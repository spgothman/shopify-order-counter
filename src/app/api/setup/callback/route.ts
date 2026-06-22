import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "No code in callback" }, { status: 400 });
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  const shop = process.env.SHOPIFY_STORE_DOMAIN;

  if (!clientId || !clientSecret || !shop) {
    return NextResponse.json(
      { error: "Missing SHOPIFY_CLIENT_ID, SHOPIFY_API_SECRET, or SHOPIFY_STORE_DOMAIN in environment variables." },
      { status: 500 },
    );
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  const data = (await res.json()) as { access_token?: string; errors?: string };

  if (!data.access_token) {
    return NextResponse.json({ error: "Token exchange failed", details: data }, { status: 500 });
  }

  return new Response(
    `<!DOCTYPE html>
<html>
<head><title>Setup complete</title></head>
<body style="font-family:monospace;background:#111;color:#fff;padding:2rem;max-width:700px;margin:auto">
  <h2 style="color:#96bf48">&#10003; OAuth complete!</h2>
  <p>Copy the access token below, then add it to your <strong>Vercel environment variables</strong> as <code>SHOPIFY_ACCESS_TOKEN</code> and redeploy.</p>
  <pre style="background:#000;padding:1rem;border-radius:8px;word-break:break-all;font-size:1rem">${data.access_token}</pre>
  <p style="color:#888;font-size:.875rem">This token is permanent — you only need to do this once.</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}
