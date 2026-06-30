import express from "express";
import { readAll, writeAll, append, update } from "../state/store.js";
import * as whatsapp from "../services/whatsapp.js";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase client initialized in API router");
  } catch (err) {
    console.error("❌ Failed to initialize Supabase client:", err.message);
  }
}

export const apiRouter = express.Router();
apiRouter.use(express.json());

const shopId = (req) => req.headers["x-shop-id"] || "default";

// ── Orders ───────────────────────────────────────────────
apiRouter.get("/orders", (req, res) => res.json(readAll(`orders_${shopId(req)}`, [])));

apiRouter.post("/orders", (req, res) => {
  const order = append(`orders_${shopId(req)}`, {
    id: `ORD-${Date.now().toString().slice(-6)}`,
    status: "Placed",
    source: "Manual",
    time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    ...req.body,
  });
  res.status(201).json(order);
});

apiRouter.patch("/orders/:id/status", async (req, res) => {
  const { status } = req.body;
  const order = update(`orders_${shopId(req)}`, req.params.id, { status });
  if (!order) return res.sendStatus(404);
  if (order.phone) {
    try { await whatsapp.sendStatusUpdate(order.phone, order, status); } catch {}
  }
  res.json(order);
});

// ── Catalog ──────────────────────────────────────────────
apiRouter.get("/catalog", (req, res) => res.json(readAll(`catalog_${shopId(req)}`, [])));
apiRouter.post("/catalog", (req, res) => res.status(201).json(append(`catalog_${shopId(req)}`, req.body)));
apiRouter.patch("/catalog/:id", (req, res) => {
  const arr = readAll(`catalog_${shopId(req)}`, []);
  const idx = arr.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);
  arr[idx] = { ...arr[idx], ...req.body };
  writeAll(`catalog_${shopId(req)}`, arr);
  res.json(arr[idx]);
});

// ── Customers ────────────────────────────────────────────
apiRouter.get("/customers", async (req, res) => {
  const sId = shopId(req);
  if (supabase) {
    try {
      const { data, error } = await supabase.from("customers").select("*");
      if (!error && data) return res.json(data);
    } catch (e) {
      console.error("Supabase select error:", e.message);
    }
  }
  res.json(readAll(`customers_${sId}`, []));
});

apiRouter.post("/customers", async (req, res) => {
  const sId = shopId(req);
  const newCust = {
    id: `C-${Date.now().toString().slice(-6)}`,
    khata: Number(req.body.khata || 0),
    ltv: Number(req.body.ltv || 0),
    created_at: new Date().toISOString(),
    ...req.body,
  };

  append(`customers_${sId}`, newCust);

  if (supabase) {
    try {
      const { error } = await supabase.from("customers").insert(newCust);
      if (error) console.error("Supabase customer insert error:", error.message);
    } catch (e) {
      console.error("Supabase customer insert failed:", e.message);
    }
  }

  res.status(201).json(newCust);
});

apiRouter.get("/customers/:id", async (req, res) => {
  const sId = shopId(req);
  if (supabase) {
    try {
      const { data, error } = await supabase.from("customers").select("*").eq("id", req.params.id).single();
      if (!error && data) return res.json(data);
    } catch (e) {
      console.error("Supabase single customer error:", e.message);
    }
  }
  const c = readAll(`customers_${sId}`, []).find((x) => x.id === req.params.id);
  return c ? res.json(c) : res.sendStatus(404);
});

// ── Khata / Credit ───────────────────────────────────────
apiRouter.post("/khata/:customerId/payment", (req, res) => {
  const arr = readAll(`customers_${shopId(req)}`, []);
  const idx = arr.findIndex((c) => c.id === req.params.customerId);
  if (idx === -1) return res.sendStatus(404);
  arr[idx].khata = Math.max(0, (arr[idx].khata || 0) - Number(req.body.amount || 0));
  writeAll(`customers_${shopId(req)}`, arr);
  res.json(arr[idx]);
});

apiRouter.post("/khata/:customerId/reminder", async (req, res) => {
  const c = readAll(`customers_${shopId(req)}`, []).find((x) => x.id === req.params.customerId);
  if (!c) return res.sendStatus(404);
  try {
    await whatsapp.sendKhataReminder(c.phone, c.name, c.khata, `upi://pay?pa=shop@upi&am=${c.khata}`);
    res.json({ sent: true });
  } catch (e) {
    res.status(502).json({ sent: false, error: e.message });
  }
});

// ── WhatsApp Broadcasts ──────────────────────────────────
apiRouter.post("/broadcast", async (req, res) => {
  const { audiencePhones, templateName, languageCode = "en" } = req.body;
  const results = [];
  for (const phone of audiencePhones || []) {
    try {
      await whatsapp.sendTemplate(phone, templateName, languageCode);
      results.push({ phone, ok: true });
    } catch (e) {
      results.push({ phone, ok: false, error: e.message });
    }
  }
  res.json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});

// ── Daily owner summary (call from a cron job, see scripts/dailySummary.js) ──
apiRouter.post("/notify/daily-summary", async (req, res) => {
  const { ownerWhatsapp, summary } = req.body;
  try {
    await whatsapp.sendOwnerDailySummary(ownerWhatsapp, summary);
    res.json({ sent: true });
  } catch (e) {
    res.status(502).json({ sent: false, error: e.message });
  }
});

// ── Outbound Twilio Calls ────────────────────────────────
apiRouter.post("/twilio/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Missing phoneNumber in request body" });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !twilioNumber) {
    return res.status(500).json({
      error: "Twilio credentials are not configured on the server. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."
    });
  }

  try {
    const client = twilio(accountSid, authToken);
    let callbackUrl;
    if (process.env.PUBLIC_BASE_URL) {
      let baseUrl = process.env.PUBLIC_BASE_URL.trim();
      if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        baseUrl = `https://${baseUrl}`;
      }
      callbackUrl = `${baseUrl}/voice/incoming?outbound=true`;
    } else {
      const host = req.get("host");
      const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      callbackUrl = `${protocol}://${host}/voice/incoming?outbound=true`;
    }

    console.log(`📞 Triggering Twilio outbound call to ${phoneNumber} from ${twilioNumber}...`);

    const call = await client.calls.create({
      to: phoneNumber,
      from: twilioNumber,
      url: callbackUrl
    });

    console.log(`✅ Outbound Twilio call initiated. Call SID: ${call.sid}`);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error("❌ Failed to initiate Twilio outbound call:", err.message);
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/twilio/hangup", async (req, res) => {
  const { callSid } = req.body;
  if (!callSid) {
    return res.status(400).json({ error: "Missing callSid in request body" });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).json({
      error: "Twilio credentials are not configured on the server."
    });
  }

  try {
    const client = twilio(accountSid, authToken);
    console.log(`📞 Hanging up Twilio call ${callSid}...`);
    await client.calls(callSid).update({ status: "completed" });
    console.log(`✅ Twilio call completed successfully: ${callSid}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to hang up Twilio call:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Call Logs ────────────────────────────────────────────
apiRouter.get("/calls", async (req, res) => {
  const sId = shopId(req);
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("calls")
        .select("*")
        .order("created_at", { ascending: false });
      if (!error && data) {
        return res.json(data);
      }
    } catch (err) {
      console.error("Error reading from Supabase:", err.message);
    }
  }
  // Fallback to local store
  res.json(readAll(`calls_${sId}`, []));
});

export default apiRouter;
