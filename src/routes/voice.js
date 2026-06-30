import express from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import { openLiveSession } from "../services/geminiLive.js";
import { mulawBase64ToPcm16Base64, pcm16Base64ToMulawBase64 } from "../services/audioCodec.js";
import { append, readAll } from "../state/store.js";
import * as whatsapp from "../services/whatsapp.js";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase client initialized in voice.js router");
  } catch (err) {
    console.error("❌ Failed to initialize Supabase client in voice.js:", err.message);
  }
}

export const voiceRouter = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Inbound call webhook — set this URL as the shop's Twilio number's
 * "A Call Comes In" webhook (Voice > Configure). Returns TwiML that opens
 * a bidirectional Media Stream to our WebSocket, which bridges to Gemini Live.
 */
voiceRouter.post("/incoming", (req, res) => {
  let callerNumber = req.body.From;
  let shopNumber = req.body.To;

  if (req.query.outbound === "true") {
    // For outbound calls, From is our Twilio number (shop) and To is the customer's number (callee)
    callerNumber = req.body.To;
    shopNumber = req.body.From;
  }

  const shopId = resolveShopIdByNumber(shopNumber);

  const twiml = new VoiceResponse();
  twiml.say(
    { voice: "Polly.Aditi" },
    "This call may be recorded for order accuracy and quality."
  );
  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${req.get("host")}/media-stream`,
  });
  stream.parameter({ name: "callerNumber", value: callerNumber || "" });
  stream.parameter({ name: "shopId", value: shopId });

  res.type("text/xml").send(twiml.toString());
});

/** Resolve which shop owns a dialed number (single-number-per-shop or shared pool + IVR digit). */
function resolveShopIdByNumber(toNumber) {
  const shops = readAll("shops", []);
  const match = shops.find((s) => s.aiNumber === toNumber);
  return match?.id || "default";
}

/**
 * Attaches the Twilio Media Streams WebSocket server to the same HTTP server.
 * Twilio connects here per-call (per the <Stream> verb above) and streams
 * mulaw 8kHz audio frames; we bridge them bidirectionally to Gemini Live.
 */
export function attachMediaStreamServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/media-stream" });

  wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let liveSession = null;
    let shopId = "default";
    let callerNumber = "";
    let startTime = Date.now();
    let transcriptLines = [];
    let isSaved = false;

    async function saveCallAndClose() {
      if (isSaved) return;
      isSaved = true;
      liveSession?.close();

      const duration = Math.round((Date.now() - startTime) / 1000);
      const fullTranscript = transcriptLines
        .map((l) => `${l.role === "user" ? "Caller" : "Agent"}: ${l.text}`)
        .join("\n");

      const callLog = {
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        caller_number: callerNumber || "Unknown",
        agent_name: "Aoede",
        duration_seconds: duration,
        transcript: fullTranscript,
        created_at: new Date().toISOString(),
      };

      console.log(`💾 Saving call log to local state: ${callLog.id}`);
      append(`calls_${shopId}`, callLog);

      if (supabase) {
        try {
          const { error } = await supabase.from("calls").insert({
            caller_number: callerNumber || "Unknown",
            agent_name: "Aoede",
            duration_seconds: duration,
            transcript: fullTranscript,
          });
          if (error) console.error("❌ Supabase DB insert error:", error.message);
          else console.log(`✅ Saved call to Supabase DB`);
        } catch (err) {
          console.error("❌ Supabase DB insert failed:", err.message);
        }
      }
    }

    twilioWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        const params = msg.start.customParameters || {};
        shopId = params.shopId || "default";
        callerNumber = params.callerNumber || "";
        startTime = Date.now();

        liveSession = openLiveSession({
          shopId,
          callerNumber,
          onAudioOut: (pcmB64) => {
            const mulawB64 = pcm16Base64ToMulawBase64(pcmB64, 24000);
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: mulawB64 },
            }));
          },
          onTranscript: (tObj) => {
            transcriptLines.push(tObj);
            console.log(`[Call ${streamSid}] ${tObj.role.toUpperCase()}: ${tObj.text}`);
          },
          onOrderConfirmed: async (orderArgs, customer) => {
            const order = append("orders", {
              id: `ORD-${Date.now().toString().slice(-6)}`,
              customer: customer?.name || "New Customer",
              phone: callerNumber,
              items: orderArgs.items.map((i) => ({ n: i.name, q: `${i.quantity} ${i.unit}`, p: i.lineTotal })),
              total: orderArgs.total,
              status: "Confirmed",
              source: "AI Call",
              time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
              delivery: orderArgs.deliveryMode || "Pickup",
            });
            if (callerNumber) {
              try { await whatsapp.sendOrderConfirmation(callerNumber, order); }
              catch (e) { console.error("WhatsApp send failed:", e.message); }
            }
          },
          onTransferRequested: (reason) => {
            console.log(`[Call ${streamSid}] Transfer requested: ${reason}`);
            // Production: use Twilio REST API to redirect the live call leg
            // to a staff conference room / forwarding number here.
          },
        });
      }

      if (msg.event === "media" && liveSession) {
        const pcm16Base64 = mulawBase64ToPcm16Base64(msg.media.payload);
        liveSession.sendAudioChunk(pcm16Base64);
      }

      if (msg.event === "stop") {
        saveCallAndClose();
      }
    });

    twilioWs.on("close", () => saveCallAndClose());
  });
}
