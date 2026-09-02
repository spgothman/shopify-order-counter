import { unstable_cache } from "next/cache";

const API_VERSION = "2024-10";

function getConfig() {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  return { storeDomain, accessToken };
}

export function isShopifyConfigured(): boolean {
  const { storeDomain, accessToken } = getConfig();
  return Boolean(storeDomain && accessToken);
}

// ── Order Count ────────────────────────────────────────────────────────────────

async function fetchOrderCountFromShopify(
  extra: Record<string, string> = {},
): Promise<number> {
  const { storeDomain, accessToken } = getConfig();
  if (!storeDomain || !accessToken) throw new Error("Shopify credentials are not configured");

  // Paginate through all orders and apply the same source_name + status filters
  // as the sales calculation so the count matches Shopify Analytics exactly.
  const baseParams = new URLSearchParams({
    status: "any",
    limit: "250",
    fields: "source_name,cancelled_at,financial_status",
    ...extra,
  });
  let nextUrl: string | null =
    `https://${storeDomain}/admin/api/${API_VERSION}/orders.json?${baseParams}`;
  let count = 0;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);

    const data = (await response.json()) as {
      orders: Array<{
        source_name?: string;
        cancelled_at?: string | null;
        financial_status?: string;
      }>;
    };

    for (const order of data.orders) {
      if (COUNT_EXCLUDED_SOURCE_NAMES.has(order.source_name ?? "")) continue;
      if (order.cancelled_at) continue;
      // Exclude orders where payment was never completed:
      // voided = reversed before capture; pending/authorized = invoice not yet paid
      if (order.financial_status === "voided") continue;
      if (order.financial_status === "pending") continue;
      count++;
    }

    nextUrl = getNextLink(response.headers.get("Link"));
  }

  return count;
}

export const getCachedOrderCount = unstable_cache(
  async () => fetchOrderCountFromShopify(),
  ["shopify-order-count-v6"],
  { tags: ["order-count"], revalidate: 60 },
);

export async function getOrderCount(options: {
  period?: "all" | "today";
  since?: string;
} = {}): Promise<number> {
  if (!isShopifyConfigured()) return 0;
  if (options.period === "today" && options.since) {
    return fetchOrderCountFromShopify({ created_at_min: options.since });
  }
  return getCachedOrderCount();
}

// ── Sales channel exclusions ───────────────────────────────────────────────────
// Channels excluded from the ORDER COUNT.
// NOTE: 1424624 = Gorgias (INCLUDE), 108220678145 = Siena for BPN (INCLUDE).
// These were previously misidentified as Syncio and Foundational.
// The actual Syncio and Foundational source_names are unknown (no orders in data).
const COUNT_EXCLUDED_SOURCE_NAMES = new Set([
  "1662707", // Loop Returns (exchange orders)
  "1615469", // Unknown app
  "tiktok",  // TikTok
  "2329312", // Facebook & Instagram
]);

// Channels excluded from the $ SALES total.
const SALES_EXCLUDED_SOURCE_NAMES = new Set([
  "shopify_draft_order", // Draft Orders
  "1662707",             // Loop Returns (exchange orders)
  "1615469",             // Unknown app
  "tiktok",              // TikTok
  "2329312",             // Facebook & Instagram
]);

// ── Order Sales ────────────────────────────────────────────────────────────────

const SALES_ORDER_FIELDS =
  "created_at,current_subtotal_price,total_shipping_price_set,refunds,source_name,cancelled_at,financial_status";

interface ShopifySalesOrder {
  created_at?: string;
  current_subtotal_price: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  refunds?: Array<{
    refund_shipping_lines?: Array<{
      subtotal_amount_set?: { shop_money?: { amount?: string } };
    }>;
  }>;
  source_name?: string;
  cancelled_at?: string | null;
  financial_status?: string;
}

function getNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.trim().split(";");
    if (rawRel?.trim() === 'rel="next"') return rawUrl.trim().slice(1, -1);
  }
  return null;
}

function isSalesOrderIncluded(order: ShopifySalesOrder): boolean {
  if (SALES_EXCLUDED_SOURCE_NAMES.has(order.source_name ?? "")) return false;
  if (order.cancelled_at) return false;
  if (order.financial_status === "voided" || order.financial_status === "refunded") return false;
  return true;
}

function calculateOrderSales(order: ShopifySalesOrder): number {
  // current_subtotal_price = line item total after all discounts and product
  // refunds (no shipping, no tax) — matches Shopify Analytics "Net Sales".
  // total_shipping_price_set = original shipping before any refunds.
  // refunds.refund_shipping_lines = shipping amounts refunded (2024-10 field).
  const netSales = parseFloat(order.current_subtotal_price) || 0;
  const originalShipping =
    parseFloat(order.total_shipping_price_set?.shop_money?.amount ?? "0") || 0;
  const refundedShipping = (order.refunds ?? []).reduce((refundSum, refund) => {
    return refundSum + (refund.refund_shipping_lines ?? []).reduce((lineSum, rsl) => {
      return lineSum + (parseFloat(rsl.subtotal_amount_set?.shop_money?.amount ?? "0") || 0);
    }, 0);
  }, 0);

  return netSales + Math.max(0, originalShipping - refundedShipping);
}

async function shopifyGet(url: string, accessToken: string): Promise<Response> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (response.status !== 429) return response;

    const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
    const waitMs = Math.min(8000, Math.max(500, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000) * (attempt + 1));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("Shopify API rate limit exceeded");
}

async function forEachShopifyOrder(
  extra: Record<string, string>,
  visit: (order: ShopifySalesOrder) => void,
): Promise<void> {
  const { storeDomain, accessToken } = getConfig();
  if (!storeDomain || !accessToken) throw new Error("Shopify credentials are not configured");

  const baseParams = new URLSearchParams({
    status: "any",
    limit: "250",
    ...extra,
    fields: SALES_ORDER_FIELDS,
  });
  let nextUrl: string | null =
    `https://${storeDomain}/admin/api/${API_VERSION}/orders.json?${baseParams}`;

  while (nextUrl) {
    const response = await shopifyGet(nextUrl, accessToken);
    if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);

    const data = (await response.json()) as { orders: ShopifySalesOrder[] };
    for (const order of data.orders) visit(order);
    nextUrl = getNextLink(response.headers.get("Link"));
  }
}

async function fetchOrderSalesFromShopify(
  extra: Record<string, string> = {},
): Promise<number> {
  let total = 0;

  await forEachShopifyOrder(extra, (order) => {
    if (!isSalesOrderIncluded(order)) return;
    total += calculateOrderSales(order);
  });

  return Math.round(total);
}

export const getCachedAllTimeSales = unstable_cache(
  async () => fetchOrderSalesFromShopify(),
  ["shopify-all-time-sales-v3"],
  { tags: ["order-sales"], revalidate: 3600 },
);

export async function getOrderSales(options: {
  period?: "all" | "today";
  since?: string;
} = {}): Promise<number> {
  if (!isShopifyConfigured()) return 0;
  if (options.period === "today" && options.since) {
    return fetchOrderSalesFromShopify({ created_at_min: options.since });
  }
  return getCachedAllTimeSales();
}

// ── Sales report (hourly / daily / monthly) ────────────────────────────────────

export type SalesReportView = "hourly" | "daily" | "monthly";

export interface SalesReportParams {
  view: SalesReportView;
  date?: string;
  year?: number;
  month?: number;
}

export interface SalesReportBucket {
  label: string;
  sales: number;
}

export interface SalesReportResult {
  view: SalesReportView;
  title: string;
  timezone: string;
  buckets: SalesReportBucket[];
  total: number;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function fetchShopTimeZone(): Promise<string> {
  const { storeDomain, accessToken } = getConfig();
  if (!storeDomain || !accessToken) return "America/Chicago";

  const response = await fetch(
    `https://${storeDomain}/admin/api/${API_VERSION}/shop.json?fields=iana_timezone`,
    {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      cache: "no-store",
    },
  );
  if (!response.ok) return "America/Chicago";

  const data = (await response.json()) as { shop?: { iana_timezone?: string } };
  return data.shop?.iana_timezone || "America/Chicago";
}

const getCachedShopTimeZone = unstable_cache(
  async () => fetchShopTimeZone(),
  ["shopify-shop-timezone"],
  { revalidate: 86400 },
);

function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const num = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
  };
}

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const asUtcFromParts = (instant: Date) => {
    const parts = formatter.formatToParts(instant);
    const num = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    return Date.UTC(num("year"), num("month") - 1, num("day"), num("hour"), num("minute"), num("second"));
  };

  let utc = wanted;
  utc -= asUtcFromParts(new Date(utc)) - wanted;
  utc -= asUtcFromParts(new Date(utc)) - wanted;
  return new Date(utc);
}

function rangeIso(year: number, month: number, day: number, timeZone: string, endExclusive = false): string {
  const instant = zonedTimeToUtc(year, month, day, 0, 0, 0, timeZone);
  if (endExclusive) {
    return new Date(instant.getTime() - 1000).toISOString();
  }
  return instant.toISOString();
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function fetchSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
  const timeZone = await getCachedShopTimeZone();

  let createdAtMin: string;
  let createdAtMax: string;
  let title: string;
  let labels: string[];
  let bucketFor: (parts: ReturnType<typeof getZonedParts>) => number | null;

  if (params.view === "hourly") {
    const parsed = params.date ? parseIsoDate(params.date) : null;
    if (!parsed) throw new Error("A valid date (YYYY-MM-DD) is required for hourly reports");
    const { year, month, day } = parsed;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    createdAtMin = rangeIso(year, month, day, timeZone);
    createdAtMax = rangeIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone, true);
    title = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
    labels = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
    bucketFor = (parts) =>
      parts.year === year && parts.month === month && parts.day === day ? parts.hour : null;
  } else if (params.view === "daily") {
    const year = params.year;
    const month = params.month;
    if (!year || !month || month < 1 || month > 12) {
      throw new Error("A valid year and month are required for daily reports");
    }
    const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    createdAtMin = rangeIso(year, month, 1, timeZone);
    createdAtMax = rangeIso(nextMonth.year, nextMonth.month, 1, timeZone, true);
    title = `${MONTH_LONG[month - 1]} ${year}`;
    const days = daysInMonth(year, month);
    labels = Array.from({ length: days }, (_, i) => String(i + 1));
    bucketFor = (parts) => (parts.year === year && parts.month === month ? parts.day - 1 : null);
  } else {
    const year = params.year;
    if (!year) throw new Error("A valid year is required for monthly reports");
    title = String(year);
    const nowParts = getZonedParts(new Date(), timeZone);
    const lastMonth = year > nowParts.year ? 0 : year < nowParts.year ? 12 : nowParts.month;
    const monthTotals = await mapPool(
      Array.from({ length: lastMonth }, (_, index) => index + 1),
      3,
      async (month) => {
        const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
        const min = rangeIso(year, month, 1, timeZone);
        const max = rangeIso(nextMonth.year, nextMonth.month, 1, timeZone, true);
        let sum = 0;
        await forEachShopifyOrder(
          { created_at_min: min, created_at_max: max },
          (order) => {
            if (!isSalesOrderIncluded(order)) return;
            sum += calculateOrderSales(order);
          },
        );
        return sum;
      },
    );
    const buckets = MONTH_SHORT.map((label, index) => ({
      label,
      sales: Math.round((monthTotals[index] ?? 0) * 100) / 100,
    }));
    const total = Math.round(monthTotals.reduce((sum, value) => sum + value, 0) * 100) / 100;
    return { view: params.view, title, timezone: timeZone, buckets, total };
  }

  const totals = new Array<number>(labels.length).fill(0);

  await forEachShopifyOrder(
    { created_at_min: createdAtMin, created_at_max: createdAtMax },
    (order) => {
      if (!isSalesOrderIncluded(order) || !order.created_at) return;
      const index = bucketFor(getZonedParts(new Date(order.created_at), timeZone));
      if (index === null || index < 0 || index >= totals.length) return;
      totals[index] += calculateOrderSales(order);
    },
  );

  const buckets = totals.map((sales, index) => ({
    label: labels[index],
    sales: Math.round(sales * 100) / 100,
  }));
  const total = Math.round(totals.reduce((sum, value) => sum + value, 0) * 100) / 100;

  return { view: params.view, title, timezone: timeZone, buckets, total };
}

const getCachedSalesReport = unstable_cache(
  async (params: SalesReportParams) => fetchSalesReport(params),
  ["shopify-sales-report-v2"],
  { tags: ["order-sales"], revalidate: 60 },
);

export async function getSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
  if (!isShopifyConfigured()) {
    return { view: params.view, title: "", timezone: "", buckets: [], total: 0 };
  }

  return getCachedSalesReport(params);
}
