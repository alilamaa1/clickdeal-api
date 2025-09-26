/**
 * ClickDeal API (Shopify + optional WhatsApp)
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/products               (live list from Shopify Admin)
 *   GET  /api/price/:handle          (live price via Storefront, default first variant)
 *   GET  /api/stock/:variantId       (live stock via Admin)
 *   POST /api/orders                 (creates Shopify Draft Order + optional WhatsApp notify)
 *
 * Auth: Bearer token "Bearer <API_KEY>"
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Secrets / Config
const API_KEY = process.env.API_KEY || "";

// Shopify
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;             // e.g. clickdeal.site
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;               // Admin token
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;     // Storefront token

// WhatsApp (optional)
const WA_TOKEN = process.env.WA_TOKEN || "";
const WA_PHONE_ID = process.env.WA_PHONE_ID || "";
const WA_RECIPIENTS = (process.env.WA_RECIPIENTS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ---- Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// ---- Simple Bearer auth
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!API_KEY || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---- Health (no auth)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---- Helpers
async function shopifyAdminGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if (!resp.ok) throw new Error(`Shopify Admin error: ${resp.status}`);
  const data = await resp.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function shopifyStorefrontGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-07/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if (!resp.ok) throw new Error(`Shopify Storefront error: ${resp.status}`);
  const data = await resp.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

// ---------------------------------------------------------------------------
// GET /api/products  (list products with handles and variant prices)
// ---------------------------------------------------------------------------
app.get("/api/products", requireAuth, async (req, res) => {
  try {
    const url =
      `https://${SHOPIFY_STORE_DOMAIN}` +
      `/admin/api/2024-07/products.json?limit=50&status=active&published_status=published&fields=id,title,handle,variants`;

    const r = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      }
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: "Shopify error", detail: text });
    }

    const data = await r.json();
    const products = (data.products || []).map(p => ({
      title: p.title,
      handle: p.handle,
      variants: (p.variants || []).map(v => ({
        id: v.admin_graphql_api_id || String(v.id),
        title: v.title,
        price: v.price,
        inventory_quantity: v.inventory_quantity
      }))
    }));

    res.json({ count: products.length, products });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch products", detail: e?.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/price/:handle  (first variant price)
// ---------------------------------------------------------------------------
app.get("/api/price/:handle", requireAuth, async (req, res) => {
  try {
    const handle = req.params.handle;
    const query = `#graphql
      query($handle: String!) {
        product(handle: $handle) {
          id
          title
          variants(first: 1) {
            nodes {
              id
              title
              price { amount currencyCode }
            }
          }
        }
      }`;

    const data = await shopifyStorefrontGraphQL(query, { handle });
    const product = data.product;
    if (!product || product.variants.nodes.length === 0) {
      return res.status(404).json({ error: "Product not found or has no variants" });
    }

    const v = product.variants.nodes[0];
    res.json({
      productHandle: handle,
      productTitle: product.title,
      variantId: v.id,
      variantTitle: v.title,
      price: v.price
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stock/:variantId
// ---------------------------------------------------------------------------
app.get("/api/stock/:variantId", requireAuth, async (req, res) => {
  try {
    const variantId = req.params.variantId;
    const gid = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;

    const query = `#graphql
      query($id: ID!) {
        productVariant(id: $id) {
          id
          inventoryQuantity
          inventoryItem { tracked }
        }
      }`;

    const data = await shopifyAdminGraphQL(query, { id: gid });
    const v = data.productVariant;
    if (!v) return res.status(404).json({ error: "Variant not found" });

    res.json({
      variantId: v.id,
      quantity: v.inventoryQuantity,
      tracked: v.inventoryItem?.tracked ?? true
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders  (create Draft Order; WhatsApp notify optional)
// Body: { name, phone, address, city, productHandle, quantity, variantId? }
// ---------------------------------------------------------------------------
app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    const { name, phone, address, city, productHandle, quantity, variantId } = req.body || {};
    if (!name || !phone || !address || !city || !productHandle || typeof quantity !== "number") {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }

    // Get variant (use provided variantId or first variant)
    let chosenVariantId = variantId;
    if (!chosenVariantId) {
      const data = await shopifyStorefrontGraphQL(`#graphql
        query($handle: String!) {
          product(handle: $handle) {
            title
            variants(first: 1) { nodes { id title price { amount currencyCode } } }
          }
        }`, { handle: productHandle });

      const product = data.product;
      if (!product || product.variants.nodes.length === 0) {
        return res.status(404).json({ error: "Product not found or has no variants" });
      }
      chosenVariantId = product.variants.nodes[0].id;
    }

    // Create Draft Order
    const mutation = `#graphql
      mutation CreateDraft($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl name }
          userErrors { field message }
        }
      }`;

    const input = {
      lineItems: [{ variantId: chosenVariantId, quantity }],
      shippingAddress: {
        address1: address,
        city,
        firstName: name.split(" ")[0] || name,
        lastName: name.split(" ").slice(1).join(" ") || "Customer",
        phone
      },
      note: "Created by ClickDeal GPT",
      tags: ["gpt", "clickdeal-assistant"]
    };

    const draftResp = await shopifyAdminGraphQL(mutation, { input });
    const draft = draftResp?.draftOrderCreate?.draftOrder;
    const errors = draftResp?.draftOrderCreate?.userErrors;
    if (!draft) return res.status(500).json({ error: "Draft order failed", details: errors });

    // WhatsApp notify (best-effort)
    if (WA_TOKEN && WA_PHONE_ID && WA_RECIPIENTS.length > 0) {
      const text =
`🛍️ New ClickDeal GPT Order
Name: ${name}
Phone: ${phone}
City: ${city}
Address: ${address}
Handle: ${productHandle}
Qty: ${quantity}
Invoice: ${draft.invoiceUrl}`;
      const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
      for (const to of WA_RECIPIENTS) {
        try {
          await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${WA_TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to,
              type: "text",
              text: { body: text }
            })
          });
        } catch (err) {
          console.error("WA send error:", err);
        }
      }
    }

    res.status(201).json({ ok: true, draftOrderId: draft.id, invoiceUrl: draft.invoiceUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Start
app.listen(PORT, () => {
  console.log(`ClickDeal API running on port ${PORT}`);
});
