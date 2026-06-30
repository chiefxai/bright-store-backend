import axios from "axios";
import crypto from "crypto";

const GRAPH_VERSION = "v20.0";

function client() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error("WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set in .env");
  }
  return axios.create({
    baseURL: `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

/** Send a free-form text message (only valid within a 24h customer session). */
export async function sendText(to, body) {
  const api = client();
  return api.post("/messages", {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

/**
 * Send a pre-approved message template (required to message outside the
 * 24h session window — e.g. order confirmations, status updates).
 * Templates must be created & approved in Meta Business Manager first.
 */
export async function sendTemplate(to, templateName, languageCode, components = []) {
  const api = client();
  return api.post("/messages", {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: templateName, language: { code: languageCode }, components },
  });
}

/** Order confirmation — itemized list, total, order ID, payment link. */
export async function sendOrderConfirmation(to, order) {
  const itemLines = order.items.map((i) => `• ${i.n} — ${i.q}`).join("\n");
  const body =
    `🧾 *Order Confirmed — ${order.id}*\n\n${itemLines}\n\n` +
    `*Total: ₹${order.total.toLocaleString("en-IN")}*\n` +
    `Estimated ready: 30 mins\n\n` +
    `💳 Pay: ${order.paymentLink || "(UPI link generated on dispatch)"}\n\n` +
    `Reply CANCEL within 5 min to cancel, or call us to make changes.`;
  return sendText(to, body);
}

/** Order status update (Packing / Out for Delivery / Delivered). */
export async function sendStatusUpdate(to, order, status, deliveryBoy) {
  let body = `📦 *${order.id}* is now: *${status}*`;
  if (status === "Out for Delivery" && deliveryBoy) {
    body += `\n\nDelivery: ${deliveryBoy.name} (${deliveryBoy.phone})`;
  }
  return sendText(to, body);
}

/** Reorder nudge based on the customer's last order. */
export async function sendReorderPrompt(to, lastOrder) {
  const items = lastOrder.items.map((i) => i.n).join(", ");
  const body = `Last time you ordered: ${items}.\n\nReply *REPEAT* to order the same again, or call the shop to customize.`;
  return sendText(to, body);
}

/** Khata / credit balance reminder. */
export async function sendKhataReminder(to, customerName, balance, payLink) {
  const body =
    `Hi ${customerName}, your outstanding balance with us is *₹${balance.toLocaleString("en-IN")}*.\n` +
    `Pay now: ${payLink}\n\nThanks for shopping with us! 🙏`;
  return sendText(to, body);
}

/** Daily end-of-day digest, sent to the owner's own WhatsApp. */
export async function sendOwnerDailySummary(to, summary) {
  const body =
    `📊 *Today's Summary*\n\n` +
    `Revenue: ₹${summary.revenue.toLocaleString("en-IN")}\n` +
    `Orders: ${summary.orderCount}\n` +
    `Low stock items: ${summary.lowStockCount}\n\n` +
    `Have a good evening!`;
  return sendText(to, body);
}

/**
 * Verify Meta webhook signature (X-Hub-Signature-256) on inbound payloads.
 * Always validate this in production before trusting webhook content.
 */
export function verifySignature(rawBody, signatureHeader) {
  const expected = crypto
    .createHmac("sha256", process.env.WHATSAPP_APP_SECRET || "")
    .update(rawBody)
    .digest("hex");
  return signatureHeader === `sha256=${expected}`;
}
