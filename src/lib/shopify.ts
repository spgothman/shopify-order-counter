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
  // TEMPORARY: breakdown by source_name
  const sourceCounts: Record<string, number> = {};

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
      const src = order.source_name ?? "(undefined)";
      if (COUNT_EXCLUDED_SOURCE_NAMES.has(src)) continue;
      if (order.cancelled_at) continue;
      if (order.financial_status === "voided") continue;
      count++;
      sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
    }

    nextUrl = getNextLink(response.headers.get("Link"));
  }

  // TEMPORARY: single summary log — remove once discrepancy is identified
  console.log(`[shopify:count] total=${count} breakdown:`, JSON.stringify(sourceCounts));

  return count;
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
// Channels excluded from the ORDER COUNT.
// shopify_draft_order is NOT excluded — Shopify Analytics counts manually-created
// draft orders (phone orders, wholesale, etc.) as real customer orders.
// Loop Returns and 1615469 are excluded because they create system orders
// (exchanges, app-internal) that Shopify Analytics does not count.
const COUNT_EXCLUDED_SOURCE_NAMES = new Set([
  "108220678145", // Foundational
  "1424624",      // Syncio Multi Store Sync
  "1662707",      // Loop Returns (exchange orders)
  "1615469",      // Unknown app
]);

// Channels excluded from the $ SALES total — superset of the count exclusions.
// Loop Returns and the unknown app (1615469) create orders Shopify Analytics
// counts but nets to $0 for sales, so we exclude them from the sales figure only.
const SALES_EXCLUDED_SOURCE_NAMES = new Set([
  "shopify_draft_order", // Draft Orders
  "108220678145",        // Foundational
  "1424624",             // Syncio Multi Store Sync
  "1662707",             // Loop Returns (exchange orders)
  "1615469",             // Unknown app
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

    for (const order of data.orders) {
      if (SALES_EXCLUDED_SOURCE_NAMES.has(order.source_name ?? "")) continue;
      if (order.cancelled_at) continue;
      if (order.financial_status === "voided" || order.financial_status === "refunded") continue;

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

    nextUrl = getNextLink(response.headers.get("Link"));
  }

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
