import { NextResponse } from "next/server";

export function GET() {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI ?? "https://shopify-order-counter.vercel.app/api/setup/callback";

  if (!clientId || !shop) {
    return NextResponse.json(
      { error: "Add SHOPIFY_CLIENT_ID and SHOPIFY_STORE_DOMAIN to your environment variables." },
      { status: 500 },
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "read_orders",
    redirect_uri: redirectUri,
    state: "setup",
  });

  return NextResponse.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
}
