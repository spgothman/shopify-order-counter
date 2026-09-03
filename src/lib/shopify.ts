import { unstable_cache } from "next/cache";

const API_VERSION = "2024-10";
const GRAPHQL_API_VERSION = "2026-07";

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

async function shopifyGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { storeDomain, accessToken } = getConfig();
  if (!storeDomain || !accessToken) throw new Error("Shopify credentials are not configured");

  const url = `https://${storeDomain}/admin/api/${GRAPHQL_API_VERSION}/graphql.json`;
  let lastError = "Shopify GraphQL request failed";

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      const waitMs = Math.min(8000, Math.max(500, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000) * (attempt + 1));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: unknown;
    };

    const errorList = Array.isArray(json.errors)
      ? json.errors as Array<{ message?: string; extensions?: { code?: string } }>
      : typeof json.errors === "string"
        ? [{ message: json.errors }]
        : json.errors && typeof json.errors === "object" && "message" in json.errors
          ? [json.errors as { message?: string; extensions?: { code?: string } }]
          : [];

    const accessDenied = errorList.some((error) =>
      /ACCESS_DENIED|read_reports|access scope/i.test(
        `${error.extensions?.code ?? ""} ${error.message ?? ""}`,
      ),
    );
    if (accessDenied || response.status === 403) {
      throw new Error(
        "Sales Report needs the read_reports Admin API scope. In Shopify admin: custom app → Configuration → enable “Read reports”, save, reinstall the app, then replace SHOPIFY_ACCESS_TOKEN with the new token.",
      );
    }

    if (!response.ok) {
      lastError = errorList[0]?.message ?? `Shopify GraphQL error (${response.status})`;
      if (/invalid api key|unrecognized login|wrong password/i.test(lastError)) {
        throw new Error(lastError);
      }
      continue;
    }

    if (errorList.length) {
      throw new Error(errorList.map((error) => error.message ?? "GraphQL error").join("; "));
    }

    if (!json.data) throw new Error("Shopify GraphQL returned no data");
    return json.data;
  }

  throw new Error(lastError);
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
  let page = 0;
  let rawCount = 0;
  let includedCount = 0;

  console.log("[sales-report] Shopify range", {
    created_at_min: extra.created_at_min ?? null,
    created_at_max: extra.created_at_max ?? null,
    url: nextUrl,
  });

  while (nextUrl) {
    page += 1;
    const response = await shopifyGet(nextUrl, accessToken);
    if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);

    const data = (await response.json()) as { orders: ShopifySalesOrder[] };
    rawCount += data.orders.length;
    for (const order of data.orders) {
      if (isSalesOrderIncluded(order)) includedCount += 1;
      visit(order);
    }
    nextUrl = getNextLink(response.headers.get("Link"));
  }

  console.log("[sales-report] Shopify result", {
    created_at_min: extra.created_at_min ?? null,
    created_at_max: extra.created_at_max ?? null,
    pages: page,
    rawOrders: rawCount,
    includedOrders: includedCount,
  });

  if (rawCount === 0 && extra.created_at_min) {
    const ageDays = (Date.now() - new Date(extra.created_at_min).getTime()) / 86_400_000;
    if (ageDays > 60) {
      console.warn(
        "[sales-report] Shopify returned 0 orders for a range",
        `${ageDays.toFixed(0)} days ago. The Admin API only returns the last 60 days unless the app has the read_all_orders scope.`,
      );
    }
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

const REPORT_CACHE_SECONDS = 600;
const REPORT_CACHE_MS = REPORT_CACHE_SECONDS * 1000;

type MemoryEntry = { expires: number; value: unknown };
const reportMemory = new Map<string, MemoryEntry>();
const reportInflight = new Map<string, Promise<unknown>>();

export function clearSalesReportMemoryCache() {
  reportMemory.clear();
}

async function remember<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = reportMemory.get(key);
  if (hit && hit.expires > Date.now()) {
    console.log("[sales-report] cache HIT", key);
    return hit.value as T;
  }

  const pending = reportInflight.get(key);
  if (pending) return pending as Promise<T>;

  console.log("[sales-report] cache MISS", key);

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

export type SalesReportView = "hourly" | "daily" | "monthly";

export interface SalesReportParams {
  view: SalesReportView;
  date?: string;
  year?: number;
  month?: number;
  compare?: boolean;
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
  warning?: string;
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

async function withPriorYearWarning(result: SalesReportResult): Promise<SalesReportResult> {
  if ((result.priorTotal ?? 0) > 0) return result;
  return {
    ...result,
    warning: "Shopify Analytics returned no sales for this period last year.",
  };
}

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

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
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

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

type ReportGrain = "hour" | "day" | "month";
type ReportSeries = { current: number[]; prior: number[] };

const SALES_QL_CHANNEL_NAMES = [
  "Draft Orders",
  "TikTok",
  "TikTok Shop",
  "Facebook & Instagram",
  "Facebook",
  "Instagram",
  "Loop Returns",
];

function buildSalesShopifyql(
  grain: ReportGrain,
  since: string,
  until: string,
  timeZone: string,
  includeChannelIds: boolean,
): string {
  const tz = timeZone.replace(/'/g, "");
  const names = SALES_QL_CHANNEL_NAMES.map((name) => `'${name.replace(/'/g, "''")}'`).join(", ");
  const idFilter = includeChannelIds
    ? " AND sale_sales_channel_id NOT IN (1662707, 1615469, 2329312)"
    : "";
  return [
    "FROM sales",
    "SHOW net_sales + shipping_charges AS sales",
    `WHERE sales_channel NOT IN (${names})${idFilter}`,
    `TIMESERIES ${grain} WITH TIMEZONE '${tz}'`,
    `SINCE ${since} UNTIL ${until}`,
    "COMPARE TO previous_year",
    `ORDER BY ${grain} ASC`,
  ].join(" ");
}

function parseMoney(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return parseFloat(value) || 0;
  if (value && typeof value === "object" && "amount" in value) {
    return parseMoney((value as { amount?: unknown }).amount);
  }
  return 0;
}

function asRowRecords(
  rows: unknown,
  columns: Array<{ name?: string }> | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return [row as Record<string, unknown>];
    }
    if (Array.isArray(row) && columns?.length) {
      const record: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        if (column.name) record[column.name] = row[index];
      });
      return [record];
    }
    return [];
  });
}

function rowCurrentSales(row: Record<string, unknown>): number {
  if (row.sales != null) return parseMoney(row.sales);
  return parseMoney(row.net_sales) + parseMoney(row.shipping_charges);
}

function rowPriorSales(row: Record<string, unknown>): number {
  if (row.comparison_sales__previous_year != null) {
    return parseMoney(row.comparison_sales__previous_year);
  }
  if (row.comparison_net_sales__previous_year != null || row.comparison_shipping_charges__previous_year != null) {
    return parseMoney(row.comparison_net_sales__previous_year) + parseMoney(row.comparison_shipping_charges__previous_year);
  }
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("comparison_") && key.includes("sales") && !key.includes("percent")) {
      return parseMoney(value);
    }
  }
  return 0;
}

function hourFromShopifyql(value: unknown, timeZone: string): number | null {
  if (typeof value === "number" && value >= 0 && value <= 23) return Math.trunc(value);
  if (typeof value !== "string" || !value) return null;
  if (/Z|[+-]\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return getZonedParts(parsed, timeZone).hour;
  }
  const match = /T(\d{2})| (\d{2}):/.exec(value);
  if (!match) return null;
  return parseInt(match[1] ?? match[2], 10);
}

function calendarFromShopifyql(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3] ?? "1"),
  };
}

function bucketIndex(
  grain: ReportGrain,
  row: Record<string, unknown>,
  timeZone: string,
): number | null {
  if (grain === "hour") {
    return hourFromShopifyql(row.hour ?? row.hour_of_day, timeZone);
  }
  if (grain === "day") {
    const parts = calendarFromShopifyql(row.day);
    return parts ? parts.day - 1 : null;
  }
  const parts = calendarFromShopifyql(row.month);
  return parts ? parts.month - 1 : null;
}

const SHOPIFYQL_REPORT_QUERY = `
  query SalesReport($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns { name dataType }
        rows
      }
      parseErrors
    }
  }
`;

interface ShopifyqlQueryData {
  shopifyqlQuery?: {
    tableData?: {
      columns?: Array<{ name?: string; dataType?: string }>;
      rows?: unknown;
    } | null;
    parseErrors?: string[] | null;
  } | null;
}

async function fetchShopifyqlSeries(
  grain: ReportGrain,
  since: string,
  until: string,
  timeZone: string,
  bucketCount: number,
): Promise<ReportSeries> {
  const run = async (includeChannelIds: boolean) => {
    const shopifyql = buildSalesShopifyql(grain, since, until, timeZone, includeChannelIds);
    console.log("[sales-report] ShopifyQL", shopifyql);
    return shopifyGraphql<ShopifyqlQueryData>(SHOPIFYQL_REPORT_QUERY, { query: shopifyql });
  };

  let data = await run(true);
  const parseErrors = data.shopifyqlQuery?.parseErrors?.filter(Boolean) ?? [];
  if (parseErrors.some((error) => /sale_sales_channel_id/i.test(error))) {
    data = await run(false);
  }
  const finalErrors = data.shopifyqlQuery?.parseErrors?.filter(Boolean) ?? [];
  if (finalErrors.length) {
    throw new Error(`ShopifyQL parse error: ${finalErrors.join("; ")}`);
  }

  const table = data.shopifyqlQuery?.tableData;
  const current = new Array<number>(bucketCount).fill(0);
  const prior = new Array<number>(bucketCount).fill(0);

  for (const row of asRowRecords(table?.rows, table?.columns)) {
    const index = bucketIndex(grain, row, timeZone);
    if (index === null || index < 0 || index >= bucketCount) continue;
    current[index] += rowCurrentSales(row);
    prior[index] += rowPriorSales(row);
  }

  return { current, prior };
}

function getHourlySeries(year: number, month: number, day: number, timeZone: string): Promise<ReportSeries> {
  const date = isoDate(year, month, day);
  return remember(`ql:hourly:${timeZone}:${date}`, () =>
    fetchShopifyqlSeries("hour", date, date, timeZone, 24),
  );
}

function getDailySeries(year: number, month: number, timeZone: string): Promise<ReportSeries> {
  const days = daysInMonth(year, month);
  return remember(`ql:daily:${timeZone}:${year}-${month}`, () =>
    fetchShopifyqlSeries("day", isoDate(year, month, 1), isoDate(year, month, days), timeZone, days),
  );
}

function getMonthlySeries(year: number, timeZone: string): Promise<ReportSeries> {
  return remember(`ql:monthly:${timeZone}:${year}`, () =>
    fetchShopifyqlSeries("month", isoDate(year, 1, 1), isoDate(year, 12, 31), timeZone, 12),
  );
}

function yoyChangePct(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return ((current - prior) / prior) * 100;
}

function lastComparableHour(year: number, month: number, day: number, timeZone: string): number {
  const now = getZonedParts(new Date(), timeZone);
  if (year > now.year || (year === now.year && (month > now.month || (month === now.month && day > now.day)))) {
    return 0;
  }
  if (year === now.year && month === now.month && day === now.day) return now.hour + 1;
  return 24;
}

function attachCompare(
  view: SalesReportView,
  title: string,
  timeZone: string,
  buckets: SalesReportBucket[],
  priorValues: number[],
  currentYear: number,
  comparableCount: number,
): SalesReportResult {
  const merged = buckets.map((bucket, index) => ({
    ...bucket,
    priorSales: roundMoney(priorValues[index] ?? 0),
  }));
  const currentTotal = merged.slice(0, comparableCount).reduce((sum, bucket) => sum + bucket.sales, 0);
  const priorTotal = merged.slice(0, comparableCount).reduce((sum, bucket) => sum + (bucket.priorSales ?? 0), 0);
  return {
    view,
    title: `${title} vs ${currentYear - 1}`,
    timezone: timeZone,
    buckets: merged,
    total: roundMoney(currentTotal),
    priorTotal: roundMoney(priorTotal),
    yoyChangePct: yoyChangePct(currentTotal, priorTotal),
    currentYear,
    priorYear: currentYear - 1,
  };
}

async function fetchSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
  const timeZone = await getCachedShopTimeZone();
  const compare = Boolean(params.compare);

  if (params.view === "hourly") {
    const parsed = params.date ? parseIsoDate(params.date) : null;
    if (!parsed) throw new Error("A valid date (YYYY-MM-DD) is required for hourly reports");
    const { year, month, day } = parsed;
    const series = await getHourlySeries(year, month, day, timeZone);
    const title = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
    const buckets = series.current.map((sales, hour) => ({
      label: hourLabel(hour),
      sales: roundMoney(sales),
    }));
    if (compare) {
      return withPriorYearWarning(
        attachCompare(
          "hourly",
          title,
          timeZone,
          buckets,
          series.prior,
          year,
          lastComparableHour(year, month, day, timeZone),
        ),
      );
    }
    return {
      view: "hourly",
      title,
      timezone: timeZone,
      buckets,
      total: roundMoney(series.current.reduce((sum, value) => sum + value, 0)),
    };
  }

  if (params.view === "daily") {
    const year = params.year;
    const month = params.month;
    if (!year || !month || month < 1 || month > 12) {
      throw new Error("A valid year and month are required for daily reports");
    }
    const lastDay = lastComparableDay(year, month, timeZone);
    const series = await getDailySeries(year, month, timeZone);
    const title = `${MONTH_LONG[month - 1]} ${year}`;
    const buckets = series.current.map((sales, index) => ({
      label: String(index + 1),
      sales: roundMoney(sales),
    }));
    if (compare) {
      return withPriorYearWarning(
        attachCompare("daily", title, timeZone, buckets, series.prior, year, lastDay),
      );
    }
    return {
      view: "daily",
      title,
      timezone: timeZone,
      buckets,
      total: roundMoney(series.current.reduce((sum, value) => sum + value, 0)),
    };
  }

  const year = params.year;
  if (!year) throw new Error("A valid year is required for monthly reports");
  const lastMonth = lastComparableMonth(year, timeZone);
  const series = await getMonthlySeries(year, timeZone);
  const title = String(year);
  const buckets = MONTH_SHORT.map((label, index) => ({
    label,
    sales: roundMoney(series.current[index] ?? 0),
  }));
  if (compare) {
    return withPriorYearWarning(
      attachCompare("monthly", title, timeZone, buckets, series.prior, year, lastMonth),
    );
  }
  return {
    view: "monthly",
    title,
    timezone: timeZone,
    buckets,
    total: roundMoney(series.current.reduce((sum, value) => sum + value, 0)),
  };
}

export async function getSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
  if (!isShopifyConfigured()) {
    return { view: params.view, title: "", timezone: "", buckets: [], total: 0 };
  }

  return fetchSalesReport(params);
}
