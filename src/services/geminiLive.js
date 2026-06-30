import WebSocket from "ws";
import { readAll } from "../state/store.js";
import { resolveOrderLine } from "./catalog.js";

const GEMINI_LIVE_URL = (apiKey) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

/**
 * Builds the per-shop system prompt: shop identity, live catalog snapshot,
 * known customer context (if caller ID matched), active offers, and the
 * conversation state machine the model should follow.
 */
function buildSystemPrompt({ shop, customer, catalogSnippet, offers }) {
  return `You are the AI phone order assistant for ${shop.name}, a kirana/wholesale shop in ${shop.locality}.
Speak naturally in Tamil, English, or Tanglish (code-switched), mirroring the customer's language.
${customer ? `The caller is a known customer: ${customer.name} (${customer.type}). Greet them by name.` : "This caller is new — ask their name and, if delivery is needed, their address."}

CONVERSATION FLOW:
1. Greet warmly and ask what they'd like to order.
2. For each item: identify product, quantity, and unit. Use the resolve_order_line
   function for every item mentioned — never guess prices or stock yourself.
3. If resolve_order_line returns "ambiguous", ask a short clarifying question.
4. If "out_of_stock", inform the customer and offer the suggested substitute.
5. If "not_found", apologize and ask them to repeat or describe the item differently.
   After 2 consecutive failures on the same item, offer to transfer to a staff member
   or suggest "WhatsApp la anupunga" (browse the WhatsApp catalog instead).
6. Once all items are captured, read back the full itemized order with quantities
   and the total price, and ask for confirmation ("confirm pannalama?").
7. Ask delivery or pickup. If delivery and new customer, confirm the address.
8. On confirmation, call confirm_order with the final item list. Then close warmly,
   promising a WhatsApp confirmation message is on its way.

Live catalog (name | brand | unit | price | stock):
${catalogSnippet}

Active offers: ${offers || "none today"}

Never invent products, prices, or stock levels outside the catalog above.
Keep responses short and conversational, like a real shopkeeper on the phone.`;
}

/**
 * Gemini Live tool/function declarations exposed to the model during the call.
 */
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "resolve_order_line",
        description: "Resolve a spoken item phrase + quantity + unit against the shop's live catalog.",
        parameters: {
          type: "object",
          properties: {
            itemPhrase: { type: "string" },
            quantity: { type: "string" },
            unit: { type: "string" },
          },
          required: ["itemPhrase"],
        },
      },
      {
        name: "confirm_order",
        description: "Finalize the order once the customer has confirmed the full itemized list and total.",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  quantity: { type: "number" },
                  unit: { type: "string" },
                  lineTotal: { type: "number" },
                },
              },
            },
            deliveryMode: { type: "string", enum: ["Delivery", "Pickup"] },
            total: { type: "number" },
          },
          required: ["items", "total"],
        },
      },
      {
        name: "transfer_to_human",
        description: "Warm-transfer the call to a human staff member when the AI cannot confidently take the order.",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
      },
    ],
  },
];

/**
 * Opens a Gemini Live session for one phone call. Returns an object with
 * sendAudioChunk(base64PcmOrMulaw) and close(), and emits events via
 * onTranscriptEvent / onAudioOut / onOrderConfirmed callbacks.
 *
 * This is wired to Twilio Media Streams in routes/voice.js: Twilio sends
 * inbound caller audio (mulaw 8kHz) over its own WebSocket per call; we
 * convert to 16kHz PCM and forward to Gemini, and convert Gemini's TTS
 * audio back to mulaw to stream back to the caller.
 */
export function openLiveSession({ shopId = "default", callerNumber, onAudioOut, onOrderConfirmed, onTransferRequested, onTranscript }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set in .env");

  const catalog = readAll(`catalog_${shopId}`, []);
  const customers = readAll(`customers_${shopId}`, []);
  const shop = readAll(`shop_${shopId}`, [{ name: "Your Shop", locality: "Tamil Nadu" }])[0];

  const customer = customers.find((c) => c.phone === callerNumber) || null;
  const catalogSnippet = catalog
    .map((p) => `${p.name} | ${p.brand} | ${p.unit} | ₹${p.price} | stock:${p.stock}`)
    .join("\n");

  const systemPrompt = buildSystemPrompt({ shop, customer, catalogSnippet, offers: "" });

  const ws = new WebSocket(GEMINI_LIVE_URL(apiKey));

  ws.on("open", () => {
    ws.send(JSON.stringify({
      setup: {
        model: `models/${process.env.GEMINI_LIVE_MODEL || "gemini-2.0-flash-live-001"}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
        },
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools: TOOLS,
        inputAudioTranscription: {},
      },
    }));
  });

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    // Streamed TTS audio out -> forward to Twilio
    const audioPart = msg.serverContent?.modelTurn?.parts?.find((p) => p.inlineData);
    if (audioPart && onAudioOut) onAudioOut(audioPart.inlineData.data);

    // Transcript text (for live dashboard captioning / logging)
    if (msg.serverContent?.inputTranscription?.text) {
      onTranscript?.({ role: "user", text: msg.serverContent.inputTranscription.text });
    }
    const textPart = msg.serverContent?.modelTurn?.parts?.find((p) => p.text);
    if (textPart) {
      onTranscript?.({ role: "ai", text: textPart.text });
    } else if (msg.serverContent?.outputTranscription?.text) {
      onTranscript?.({ role: "ai", text: msg.serverContent.outputTranscription.text });
    }

    // Tool calls from the model
    if (msg.toolCall?.functionCalls) {
      for (const call of msg.toolCall.functionCalls) {
        let result;
        if (call.name === "resolve_order_line") {
          result = resolveOrderLine(call.args, shopId);
        } else if (call.name === "confirm_order") {
          result = { status: "ok" };
          onOrderConfirmed?.(call.args, customer);
        } else if (call.name === "transfer_to_human") {
          result = { status: "transferring" };
          onTransferRequested?.(call.args.reason);
        }
        ws.send(JSON.stringify({
          toolResponse: {
            functionResponses: [{ id: call.id, name: call.name, response: { result } }],
          },
        }));
      }
    }
  });

  ws.on("error", (err) => console.error("[GeminiLive] socket error:", err.message));
  ws.on("close", (code, reason) => console.log(`[GeminiLive] socket closed: ${code} - ${reason.toString()}`));

  return {
    sendAudioChunk(base64Pcm16kMono) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Pcm16kMono }] },
      }));
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}
