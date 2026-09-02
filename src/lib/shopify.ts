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

// ── Sales report (hourly / daily / monthly / yoy) ──────────────────────────────

const REPORT_CACHE_SECONDS = 300;
const REPORT_CACHE_MS = REPORT_CACHE_SECONDS * 1000;

type MemoryEntry = { expires: number; value: unknown };
const reportMemory = new Map<string, MemoryEntry>();
const reportInflight = new Map<string, Promise<unknown>>();

export function clearSalesReportMemoryCache() {
  reportMemory.clear();
}

async function remember<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = reportMemory.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const pending = reportInflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = fn()
    .then((value) => {
      reportMemory.set(key, { expires: Date.now() + REPORT_CACHE_MS, value });
      return value;
    })
    .finally(() => {
      reportInflight.delete(key);
    });

  reportInflight.set(key, promise);
  return promise;
}

export type SalesReportView = "hourly" | "daily" | "monthly" | "yoy";

export interface SalesReportParams {
  view: SalesReportView;
  date?: string;
  year?: number;
  month?: number;
}

export interface SalesReportBucket {
  label: string;
  sales: number;
  priorSales?: number;
}

export interface SalesReportResult {
  view: SalesReportView;
  title: string;
  timezone: string;
  buckets: SalesReportBucket[];
  total: number;
  priorTotal?: number;
  yoyChangePct?: number | null;
  currentYear?: number;
  priorYear?: number;
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

function addCalendarDays(year: number, month: number, day: number, delta: number) {
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function lastComparableMonth(year: number, timeZone: string): number {
  const now = getZonedParts(new Date(), timeZone);
  if (year > now.year) return 0;
  if (year < now.year) return 12;
  return now.month;
}

function lastComparableDay(year: number, month: number, timeZone: string): number {
  const now = getZonedParts(new Date(), timeZone);
  const days = daysInMonth(year, month);
  if (year > now.year || (year === now.year && month > now.month)) return 0;
  if (year < now.year || month < now.month) return days;
  return now.day;
}

async function sumOrdersInRange(createdAtMin: string, createdAtMax: string): Promise<number> {
  let total = 0;
  await forEachShopifyOrder(
    { created_at_min: createdAtMin, created_at_max: createdAtMax },
    (order) => {
      if (!isSalesOrderIncluded(order)) return;
      total += calculateOrderSales(order);
    },
  );
  return total;
}

async function fetchDaySales(year: number, month: number, day: number, timeZone: string): Promise<number> {
  const next = addCalendarDays(year, month, day, 1);
  return sumOrdersInRange(
    rangeIso(year, month, day, timeZone),
    rangeIso(next.year, next.month, next.day, timeZone, true),
  );
}

async function fetchMonthSales(year: number, month: number, timeZone: string): Promise<number> {
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return sumOrdersInRange(
    rangeIso(year, month, 1, timeZone),
    rangeIso(nextMonth.year, nextMonth.month, 1, timeZone, true),
  );
}

async function fetchHourlyBuckets(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Promise<number[]> {
  const next = addCalendarDays(year, month, day, 1);
  const totals = new Array<number>(24).fill(0);
  await forEachShopifyOrder(
    {
      created_at_min: rangeIso(year, month, day, timeZone),
      created_at_max: rangeIso(next.year, next.month, next.day, timeZone, true),
    },
    (order) => {
      if (!isSalesOrderIncluded(order) || !order.created_at) return;
      const parts = getZonedParts(new Date(order.created_at), timeZone);
      if (parts.year !== year || parts.month !== month || parts.day !== day) return;
      totals[parts.hour] += calculateOrderSales(order);
    },
  );
  return totals;
}

const cachedDaySales = unstable_cache(
  async (year: number, month: number, day: number, timeZone: string) =>
    fetchDaySales(year, month, day, timeZone),
  ["shopify-sales-day-v1"],
  { tags: ["order-sales"], revalidate: REPORT_CACHE_SECONDS },
);

const cachedMonthSales = unstable_cache(
  async (year: number, month: number, timeZone: string) =>
    fetchMonthSales(year, month, timeZone),
  ["shopify-sales-month-v1"],
  { tags: ["order-sales"], revalidate: REPORT_CACHE_SECONDS },
);

const cachedHourlyBuckets = unstable_cache(
  async (year: number, month: number, day: number, timeZone: string) =>
    fetchHourlyBuckets(year, month, day, timeZone),
  ["shopify-sales-hourly-v1"],
  { tags: ["order-sales"], revalidate: REPORT_CACHE_SECONDS },
);

function getDaySales(year: number, month: number, day: number, timeZone: string): Promise<number> {
  return remember(`day:${timeZone}:${year}-${month}-${day}`, () =>
    cachedDaySales(year, month, day, timeZone),
  );
}

function getMonthSales(year: number, month: number, timeZone: string): Promise<number> {
  return remember(`month:${timeZone}:${year}-${month}`, () =>
    cachedMonthSales(year, month, timeZone),
  );
}

function getHourlyBuckets(year: number, month: number, day: number, timeZone: string): Promise<number[]> {
  return remember(`hourly:${timeZone}:${year}-${month}-${day}`, () =>
    cachedHourlyBuckets(year, month, day, timeZone),
  );
}

function yoyChangePct(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return ((current - prior) / prior) * 100;
}

async function fetchSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
  const timeZone = await getCachedShopTimeZone();

  if (params.view === "hourly") {
    const parsed = params.date ? parseIsoDate(params.date) : null;
    if (!parsed) throw new Error("A valid date (YYYY-MM-DD) is required for hourly reports");
    const { year, month, day } = parsed;
    const totals = await getHourlyBuckets(year, month, day, timeZone);
    const buckets = totals.map((sales, hour) => ({
      label: hourLabel(hour),
      sales: roundMoney(sales),
    }));
    const title = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
    return {
      view: "hourly",
      title,
      timezone: timeZone,
      buckets,
      total: roundMoney(totals.reduce((sum, value) => sum + value, 0)),
    };
  }

  if (params.view === "daily") {
    const year = params.year;
    const month = params.month;
    if (!year || !month || month < 1 || month > 12) {
      throw new Error("A valid year and month are required for daily reports");
    }
    const days = daysInMonth(year, month);
    const lastDay = lastComparableDay(year, month, timeZone);
    const dayTotals = await Promise.all(
      Array.from({ length: days }, (_, index) => {
        const day = index + 1;
        if (day > lastDay) return Promise.resolve(0);
        return getDaySales(year, month, day, timeZone);
      }),
    );
    const buckets = dayTotals.map((sales, index) => ({
      label: String(index + 1),
      sales: roundMoney(sales),
    }));
    return {
      view: "daily",
      title: `${MONTH_LONG[month - 1]} ${year}`,
      timezone: timeZone,
      buckets,
      total: roundMoney(dayTotals.reduce((sum, value) => sum + value, 0)),
    };
  }

  const year = params.year;
  if (!year) throw new Error("A valid year is required for monthly reports");
  const lastMonth = lastComparableMonth(year, timeZone);

  if (params.view === "yoy") {
    const priorYear = year - 1;
    const [currentTotals, priorTotals] = await Promise.all([
      Promise.all(
        Array.from({ length: 12 }, (_, index) => {
          const month = index + 1;
          if (month > lastMonth) return Promise.resolve(0);
          return getMonthSales(year, month, timeZone);
        }),
      ),
      Promise.all(
        Array.from({ length: 12 }, (_, index) => getMonthSales(priorYear, index + 1, timeZone)),
      ),
    ]);
    const buckets = MONTH_SHORT.map((label, index) => ({
      label,
      sales: roundMoney(currentTotals[index] ?? 0),
      priorSales: roundMoney(priorTotals[index] ?? 0),
    }));
    const currentComparable = currentTotals
      .slice(0, lastMonth)
      .reduce((sum, value) => sum + value, 0);
    const priorComparable = priorTotals
      .slice(0, lastMonth)
      .reduce((sum, value) => sum + value, 0);
    return {
      view: "yoy",
      title: `${year} vs ${priorYear}`,
      timezone: timeZone,
      buckets,
      total: roundMoney(currentComparable),
      priorTotal: roundMoney(priorComparable),
      yoyChangePct: yoyChangePct(currentComparable, priorComparable),
      currentYear: year,
      priorYear,
    };
  }

  const monthTotals = await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      if (month > lastMonth) return Promise.resolve(0);
      return getMonthSales(year, month, timeZone);
    }),
  );
  const buckets = MONTH_SHORT.map((label, index) => ({
    label,
    sales: roundMoney(monthTotals[index] ?? 0),
  }));
  return {
    view: "monthly",
    title: String(year),
    timezone: timeZone,
    buckets,
    total: roundMoney(monthTotals.reduce((sum, value) => sum + value, 0)),
  };
}

export async function getSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
  if (!isShopifyConfigured()) {
    return { view: params.view, title: "", timezone: "", buckets: [], total: 0 };
  }

  return fetchSalesReport(params);
}
