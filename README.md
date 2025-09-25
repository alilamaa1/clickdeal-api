
# ClickDeal API (Shopify + WhatsApp) — for GPT Actions

This gives your GPT live **prices**, **stock**, and creates **Draft Orders** in Shopify, plus WhatsApp alerts to you.

Endpoints (all require Bearer API_KEY):
- `GET /api/price/:handle` → live price (first variant) by product handle
- `GET /api/stock/:variantId` → live inventory quantity by variant ID
- `POST /api/orders` → creates a Draft Order in Shopify + sends WhatsApp message (Meta Cloud API)

## 1) Setup Shopify tokens
- In Shopify Admin → **Apps → Develop apps → Create app** → Configure Admin API scopes:
  - `read_products`, `write_draft_orders`
- Install the app → copy **Admin API access token** → set `SHOPIFY_ADMIN_TOKEN`.
- For Storefront token: Shopify Admin → **Settings → Apps and channels → Develop apps** → Storefront API → Enable **unauthenticated_read_product_listings**. Copy the **Storefront token**.

Set env:
```
SHOPIFY_STORE_DOMAIN=clickdeal.site
SHOPIFY_ADMIN_TOKEN=...
SHOPIFY_STOREFRONT_TOKEN=...
API_KEY=long_random_string
```

## 2) WhatsApp (Meta Cloud API)
- Create a WhatsApp Business app: https://developers.facebook.com/docs/whatsapp/cloud-api/
- Get **Permanent token** and **Phone Number ID**.
- Set:
```
WA_TOKEN=EAAG...
WA_PHONE_ID=1xxxxxxxxxxxxxx
WA_RECIPIENTS=+96176851935,+96170071230
```

## 3) Run locally
```
npm install
cp .env.example .env
# fill tokens above
node server.js
```

## 4) Deploy
- Render/Railway: Web Service → Build `npm install` → Start `node server.js` → add env vars.
- Optional CNAME: `api.clickdeal.site` → your host URL.

## 5) Connect to GPT Actions
- In GPT → Configure → **Actions → Add Action → Import from JSON**
- Upload `openapi.json` from this project.
- In Action **Authentication**, set Bearer = your `API_KEY`.
- Save and **Test** endpoints.

## 6) How GPT should call it
- To quote **live prices** without fixed numbers in Knowledge:
  - Call `/api/price/:handle` and respond with the amount + currency.
- To check **stock**: call `/api/stock/:variantId` (variantId from Storefront response above).
- To **place an order**: GPT collects {name, phone, address, city, productHandle, quantity} then POST `/api/orders`.
  - You’ll receive a WhatsApp message with details + invoice URL.
  - Customer can pay via the **invoiceUrl** if enabled in your Shopify settings.

## Notes
- Uses Shopify API version 2024-07. Update if needed.
- If your product has multiple variants, you can modify `/api/price` to accept a specific `variantId`.
- For Lebanon formatting, keep phone numbers in E.164 (e.g., +96176851935).
