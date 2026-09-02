import { NextRequest, NextResponse } from "next/server";
import { getSalesReport, isShopifyConfigured, type SalesReportView } from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VIEWS = new Set<SalesReportView>(["hourly", "daily", "monthly"]);

export async function GET(request: NextRequest) {
  if (!isShopifyConfigured()) {
    return NextResponse.json(
      { buckets: null, configured: false, error: "Shopify credentials are not configured" },
      { status: 503 },
    );
  }

  const { searchParams } = request.nextUrl;
  const viewParam = searchParams.get("view");
  const view = VIEWS.has(viewParam as SalesReportView) ? (viewParam as SalesReportView) : null;

  if (!view) {
    return NextResponse.json(
      { buckets: null, configured: true, error: "view must be hourly, daily, or monthly" },
      { status: 400 },
    );
  }

  const date = searchParams.get("date") ?? undefined;
  const yearParam = searchParams.get("year");
  const monthParam = searchParams.get("month");
  const year = yearParam ? Number(yearParam) : undefined;
  const month = monthParam ? Number(monthParam) : undefined;

  if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
    return NextResponse.json(
      { buckets: null, configured: true, error: "year must be a valid number" },
      { status: 400 },
    );
  }
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return NextResponse.json(
      { buckets: null, configured: true, error: "month must be between 1 and 12" },
      { status: 400 },
    );
  }

  try {
    const report = await getSalesReport({ view, date, year, month });
    return NextResponse.json({ ...report, configured: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch sales report";
    return NextResponse.json(
      { buckets: null, configured: true, error: message },
      { status: 502 },
    );
  }
}
