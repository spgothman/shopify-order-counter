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

  const params = new URLSearchParams({ status: "any", ...extra });
  const url = `https://${storeDomain}/admin/api/${API_VERSION}/orders/count.json?${params}`;

  const response = await fetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { count: number }).count;
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
  "draft_orders",
  "syncio",        // Syncio Multi Store Sync
  "foundational",  // Foundational
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
    fields: "subtotal_price,total_shipping_price_set,source_name",
    ...extra,
  });
  let nextUrl: string | null =
    `https://${storeDomain}/admin/api/${API_VERSION}/orders.json?${baseParams}`;
  let total = 0;
  // TEMPORARY: collect unique source_name values for debugging
  const seenSourceNames = new Set<string>();

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${await response.text()}`);

    const data = (await response.json()) as {
      orders: Array<{
        subtotal_price: string;
        total_shipping_price_set?: { shop_money?: { amount?: string } };
        source_name?: string;
      }>;
    };
    for (const order of data.orders) {
      // TEMPORARY: log each unique source_name so we can verify channel filter values
      const src = order.source_name ?? "(undefined)";
      if (!seenSourceNames.has(src)) {
        seenSourceNames.add(src);
        console.log("[shopify] source_name seen:", src, "| excluded:", EXCLUDED_SOURCE_NAMES.has(src));
      }

      if (EXCLUDED_SOURCE_NAMES.has(order.source_name ?? "")) continue;
      total += parseFloat(order.subtotal_price) || 0;
      total += parseFloat(order.total_shipping_price_set?.shop_money?.amount ?? "0") || 0;
    }
    nextUrl = getNextLink(response.headers.get("Link"));
  }

  // TEMPORARY: summary log
  console.log("[shopify] all source_names found:", [...seenSourceNames].sort().join(", "));

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
