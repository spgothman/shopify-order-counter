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

  const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };

  // The count endpoint only accepts one status value at a time.
  // Fetch open + closed separately and sum to exclude cancelled orders,
  // matching how Shopify Analytics counts orders.
  const counts = await Promise.all(
    (["open", "closed"] as const).map(async (status) => {
      const params = new URLSearchParams({ status, ...extra });
      const url = `https://${storeDomain}/admin/api/${API_VERSION}/orders/count.json?${params}`;
      const response = await fetch(url, { headers, cache: "no-store" });
      if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);
      return ((await response.json()) as { count: number }).count;
    }),
  );

  return counts[0] + counts[1];
}

export const getCachedOrderCount = unstable_cache(
  async () => fetchOrderCountFromShopify(),
  ["shopify-order-count"],
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
// Orders whose source_name matches any of these are excluded from the $ sales total.
// "draft_orders" is the standard Shopify value for the Draft Orders channel.
// Syncio and Foundational use whatever source_name their app registers — update
// these strings if the numbers don't match your Shopify Analytics report.
const EXCLUDED_SOURCE_NAMES = new Set([
  "shopify_draft_order", // Draft Orders
  "108220678145",        // Foundational
  "1424624",             // Syncio Multi Store Sync
]);

// ── Order Sales ────────────────────────────────────────────────────────────────

function getNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.trim().split(";");
    if (rawRel?.trim() === 'rel="next"') return rawUrl.trim().slice(1, -1);
  }
  return null;
}

async function fetchOrderSalesFromShopify(
  extra: Record<string, string> = {},
): Promise<number> {
  const { storeDomain, accessToken } = getConfig();
  if (!storeDomain || !accessToken) throw new Error("Shopify credentials are not configured");

  const baseParams = new URLSearchParams({
    status: "any",
    limit: "250",
    // current_subtotal_price = line item total after all discounts and product
    // refunds (no shipping, no tax) — matches Shopify Analytics "Net Sales".
    // total_shipping_price_set = original shipping before any refunds.
    // refunds.refund_shipping_lines = shipping amounts refunded (2024-10 field).
    fields: "current_subtotal_price,total_shipping_price_set,refunds,source_name,cancelled_at,financial_status",
    ...extra,
  });
  let nextUrl: string | null =
    `https://${storeDomain}/admin/api/${API_VERSION}/orders.json?${baseParams}`;
  let total = 0;
  // TEMPORARY: debug logging
  let pageNum = 0;
  let totalIncluded = 0;
  const includedSourceCounts: Record<string, number> = {};

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);

    const data = (await response.json()) as {
      orders: Array<{
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
      }>;
    };

    pageNum++;
    let pageIncluded = 0;

    for (const order of data.orders) {
      const src = order.source_name ?? "(undefined)";
      if (EXCLUDED_SOURCE_NAMES.has(src)) continue;
      if (order.cancelled_at) continue;
      if (order.financial_status === "voided" || order.financial_status === "refunded") continue;

      // TEMPORARY: log every included order's source_name
      console.log(`[shopify:sales] INCLUDED src="${src}" financial_status="${order.financial_status ?? ""}"`);

      pageIncluded++;
      totalIncluded++;
      includedSourceCounts[src] = (includedSourceCounts[src] ?? 0) + 1;

      const netSales = parseFloat(order.current_subtotal_price) || 0;
      const originalShipping =
        parseFloat(order.total_shipping_price_set?.shop_money?.amount ?? "0") || 0;
      const refundedShipping = (order.refunds ?? []).reduce((refundSum, refund) => {
        return refundSum + (refund.refund_shipping_lines ?? []).reduce((lineSum, rsl) => {
          return lineSum + (parseFloat(rsl.subtotal_amount_set?.shop_money?.amount ?? "0") || 0);
        }, 0);
      }, 0);

      total += netSales + Math.max(0, originalShipping - refundedShipping);
    }

    // TEMPORARY: per-page summary
    console.log(`[shopify:sales] page ${pageNum}: fetched ${data.orders.length} orders, included ${pageIncluded}`);

    nextUrl = getNextLink(response.headers.get("Link"));
  }

  // TEMPORARY: final summary
  console.log(`[shopify:sales] TOTAL included orders: ${totalIncluded}`);
  console.log(`[shopify:sales] source_name breakdown:`, JSON.stringify(includedSourceCounts, null, 2));

  return Math.round(total);
}

export const getCachedAllTimeSales = unstable_cache(
  async () => fetchOrderSalesFromShopify(),
  ["shopify-all-time-sales"],
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
