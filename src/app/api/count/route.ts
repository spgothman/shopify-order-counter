import { NextRequest, NextResponse } from "next/server";
import { getOrderCount, isShopifyConfigured } from "@/lib/shopify";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isShopifyConfigured()) {
    return NextResponse.json(
      {
        count: null,
        configured: false,
        error: "Shopify credentials are not configured",
      },
      { status: 503 },
    );
  }

  const { searchParams } = request.nextUrl;
  const period = searchParams.get("period") === "today" ? "today" : "all";
  const since = searchParams.get("since") ?? undefined;

  try {
    const count = await getOrderCount({ period, since });
    return NextResponse.json({ count, configured: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch order count";
    return NextResponse.json(
      { count: null, configured: true, error: message },
      { status: 502 },
    );
  }
}
