
/**
 * ClickDeal API (Shopify + WhatsApp)
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/stock/:variantId        (live from Shopify Admin)
 *   GET  /api/price/:handle           (live price via Storefront, default first variant)
 *   POST /api/orders                  (creates Shopify Draft Order + WhatsApp notify)
 *
 * Auth: Bearer token "Bearer <API_KEY>"
 */
import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

// Shopify env
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. clickdeal.site
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // Private Admin API access token
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN; // Storefront API token

// WhatsApp (Meta Cloud API)
const WA_TOKEN = process.env.WA_TOKEN;             // WhatsApp Graph API token
const WA_PHONE_ID = process.env.WA_PHONE_ID;       // WhatsApp business phone number ID
const WA_RECIPIENTS = (process.env.WA_RECIPIENTS || "").split(",").map(s => s.trim()); // E.164 list

app.use(helmet());
app.use(cors());
app.use(express.json());

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!API_KEY || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * Helper: Shopify Admin GraphQL call
 */
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

/**
 * Helper: Shopify Storefront GraphQL call (for public product/price)
 */
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

/**
 * GET /api/stock/:variantId
 * Returns live inventory quantity for a variantId (gid or numeric).
 */
app.get("/api/stock/:variantId", requireAuth, async (req, res) => {
  try {
    const variantId = req.params.variantId; // can be gid or legacy id
    // Query inventory via Admin API (inventoryQuantity on variant)
    const query = `#graphql
      query($id: ID!) {
        productVariant(id: $id) {
          id
          inventoryQuantity
          inventoryItem {
            tracked
          }
        }
      }`;

    // Normalize to GID
    const gid = variantId.startsWith("gid://") ? variantId : `gid://shopify/ProductVariant/${variantId}`;
    const data = await shopifyAdminGraphQL(query, { id: gid });
    const v = data.productVariant;
    if (!v) return res.status(404).json({ error: "Variant not found" });
    res.json({ variantId: v.id, quantity: v.inventoryQuantity, tracked: v.inventoryItem?.tracked ?? true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * GET /api/price/:handle
 * Returns live price (amount + currency) for first available variant by product handle.
 */
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
              price {
                amount
                currencyCode
              }
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

/**
 * POST /api/orders
 * Body: { name, phone, address, city, productHandle, quantity }
 * - Creates a DraftOrder in Shopify with first variant of product handle
 * - Sends WhatsApp notification to owner numbers
 */
app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    const { name, phone, address, city, productHandle, quantity } = req.body || {};
    if (!name || !phone || !address || !city || !productHandle || typeof quantity !== "number") {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }

    // Get product + first variant via Storefront
    const data = await shopifyStorefrontGraphQL(`#graphql
      query($handle: String!) {
        product(handle: $handle) {
          id
          title
          variants(first: 1) {
            nodes { id title price { amount currencyCode } }
          }
        }
      }`, { handle: productHandle });

    const product = data.product;
    if (!product || product.variants.nodes.length === 0) {
      return res.status(404).json({ error: "Product not found or has no variants" });
    }
    const variant = product.variants.nodes[0];

    // Create Draft Order via Admin API
    const mutation = `#graphql
      mutation CreateDraft($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
            name
          }
          userErrors { field message }
        }
      }`;

    const input = {
      lineItems: [{
        variantId: variant.id,
        quantity: quantity
      }],
      shippingAddress: {
        address1: address,
        city: city,
        firstName: name.split(" ")[0] || name,
        lastName: name.split(" ").slice(1).join(" ") || "Customer",
        phone: phone
      },
      note: "Created by ClickDeal GPT",
      tags: ["gpt", "clickdeal-assistant"]
    };

    const draftResp = await shopifyAdminGraphQL(mutation, { input });
    const draft = draftResp.draftOrderCreate?.draftOrder;
    const errors = draftResp.draftOrderCreate?.userErrors;
    if (!draft) {
      return res.status(500).json({ error: "Draft order failed", details: errors });
    }

    // WhatsApp notify (fire-and-forget)
    if (WA_TOKEN && WA_PHONE_ID && WA_RECIPIENTS.length > 0) {
      const text = `🛍️ New ClickDeal GPT Order
Name: ${name}
Phone: ${phone}
City: ${city}
Address: ${address}
Product: ${product.title} (${variant.title})
Qty: ${quantity}
Invoice: ${draft.invoiceUrl}`;

      const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
      for (const to of WA_RECIPIENTS) {
        try {
          await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${WA_TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to,
              type: "text",
              text: { body: text }
            })
          });
        } catch (e) {
          console.error("WA send error:", e);
        }
      }
    }

    res.status(201).json({ ok: true, draftOrderId: draft.id, invoiceUrl: draft.invoiceUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`ClickDeal API (Shopify) running on port ${PORT}`);
});
