# Shopify Order Counter

A kiosk-style web app that displays your total Shopify order count on an 8-digit split-flap display.

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Copy the environment template and add your Shopify credentials:

```bash
cp .env.example .env.local
```

3. Replace `public/brand-logo.svg` with your brand logo (PNG or SVG also works if you update the image path in `src/components/OrderCounter.tsx`).

4. Start the dev server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000).

## Connect Shopify

### 1. Create a custom app

1. In Shopify admin, go to **Settings → Apps and sales channels → Develop apps**.
2. Create an app (enable custom app development if prompted).
3. Configure **Admin API scopes**:
   - `read_orders`
4. Install the app on your store.
5. Copy the **Admin API access token** into `SHOPIFY_ACCESS_TOKEN`.
6. Copy the **API secret key** into `SHOPIFY_API_SECRET`.
7. Set `SHOPIFY_STORE_DOMAIN` to your store domain, e.g. `your-store.myshopify.com`.

### 2. Enable near real-time updates (webhook)

The app polls every 2 seconds and refreshes immediately when Shopify sends a webhook.

1. In your custom app, open **Webhooks**.
2. Create a webhook:
   - **Event:** Order creation
   - **URL:** `https://YOUR-DOMAIN/api/webhooks/orders`
   - **Format:** JSON

For local development, expose your machine with a tunnel (for example [ngrok](https://ngrok.com/)) and use that public URL for the webhook.

## Deploy

This app works on Vercel or any Node host that supports Next.js.

1. Push the repo to GitHub.
2. Import the project in Vercel.
3. Add the three environment variables from `.env.example`.
4. Deploy, then update the Shopify webhook URL to your production domain.

## What it shows

- **Count:** total orders ever (all statuses)
- **Digits:** 8, zero-padded (e.g. `00000206`)
- **Branding:** your logo on the left, small Shopify mark in the top-right corner
