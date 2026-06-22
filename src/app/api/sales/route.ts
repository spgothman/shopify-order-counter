import { NextRequest, NextResponse } from "next/server";
import { getOrderSales, isShopifyConfigured } from "@/lib/shopify";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isShopifyConfigured()) {
    return NextResponse.json({ sales: null, configured: false }, { status: 503 });
  }

  const { searchParams } = request.nextUrl;
  const period = searchParams.get("period") === "today" ? "today" : "all";
  const since = searchParams.get("since") ?? undefined;

  try {
    const sales = await getOrderSales({ period, since });
    return NextResponse.json({ sales, configured: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch sales";
    return NextResponse.json({ sales: null, configured: true, error: message }, { status: 502 });
  }
}
