import crypto from "crypto";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

function verifyWebhook(body: string, hmacHeader: string | null): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !hmacHeader) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader),
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const body = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");

  if (!verifyWebhook(body, hmac)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  revalidateTag("order-count", { expire: 0 });
  revalidateTag("order-sales", { expire: 0 });

  return NextResponse.json({ ok: true });
}
