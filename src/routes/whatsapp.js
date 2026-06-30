import express from "express";
import * as whatsapp from "../services/whatsapp.js";
import { readAll, append } from "../state/store.js";

export const whatsappRouter = express.Router();

/** Meta webhook verification handshake (GET). */
whatsappRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

/** Inbound messages from customers (POST). Drives the two-way menu bot. */
whatsappRouter.post("/webhook", express.json(), async (req, res) => {
  res.sendStatus(200); // ack immediately, Meta requires <20s response

  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const text = (message.text?.body || "").trim().toUpperCase();

  try {
    if (text === "REPEAT") {
      const orders = readAll("orders", []);
      const last = orders.find((o) => o.phone === from);
      if (last) {
        const reorder = append("orders", { ...last, id: `ORD-${Date.now().toString().slice(-6)}`, source: "WhatsApp", status: "Placed" });
        await whatsapp.sendOrderConfirmation(from, reorder);
      } else {
        await whatsapp.sendText(from, "We don't have a previous order on file for this number yet. Reply MENU to browse our catalog.");
      }
    } else if (text === "MENU" || text === "HI" || text === "HELLO") {
      await whatsapp.sendText(
        from,
        "Welcome! Reply with a number:\n1. View Catalog\n2. Reorder Last Order\n3. Track Order\n4. Talk to AI (call me back)\n5. Talk to Staff"
      );
    } else if (text === "1") {
      await whatsapp.sendText(from, "Browse our catalog here: [Meta Catalog link configured per shop]. Add items and checkout to place an order.");
    } else if (text === "2") {
      await whatsapp.sendText(from, "Reply REPEAT to confirm reordering your last order.");
    } else if (text === "3") {
      const orders = readAll("orders", []);
      const last = orders.find((o) => o.phone === from);
      await whatsapp.sendText(from, last ? `Order ${last.id} status: ${last.status}` : "We couldn't find a recent order for this number.");
    } else if (text === "4") {
      await whatsapp.sendText(from, "Got it — our AI will call you back shortly to take your order.");
      // Production: trigger an outbound Twilio call to `from` here.
    } else if (text === "5") {
      await whatsapp.sendText(from, "Connecting you to a staff member — they'll reply here shortly.");
    } else if (text === "CANCEL") {
      await whatsapp.sendText(from, "Your most recent order has been flagged for cancellation if within the 5-minute window. Our staff will confirm shortly.");
    } else {
      await whatsapp.sendText(from, "Reply MENU to see ordering options, or just tell us what you'd like and our staff will help.");
    }
  } catch (e) {
    console.error("WhatsApp webhook handling error:", e.message);
  }
});

export default whatsappRouter;
