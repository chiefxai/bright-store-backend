import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { voiceRouter, attachMediaStreamServer } from "./routes/voice.js";
import { whatsappRouter } from "./routes/whatsapp.js";
import { apiRouter } from "./routes/api.js";
import { writeAll, readAll } from "./state/store.js";

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded

// Seed demo data on first boot so the API isn't empty out of the box.
function seed() {
  if (readAll("shops", []).length === 0) {
    writeAll("shops", [{ id: "default", name: "Sri Lakshmi Stores", aiNumber: process.env.TWILIO_PHONE_NUMBER || "+91 73580 21190", locality: "Anna Nagar, Madurai" }]);
  }
  if (readAll("catalog_default", []).length === 0) {
    writeAll("catalog_default", [
      { id: "P001", name: "Ponni Rice", brand: "Aachi", unit: "kg", price: 58, stock: 480 },
      { id: "P002", name: "Sugar", brand: "Local", unit: "kg", price: 44, stock: 12 },
      { id: "P003", name: "Sunflower Oil", brand: "Gold Winner", unit: "litre", price: 152, stock: 60 },
      { id: "P004", name: "Toor Dal", brand: "Tata Sampann", unit: "kg", price: 138, stock: 35 },
    ]);
  }
  if (readAll("customers_default", []).length === 0) {
    writeAll("customers_default", [
      { id: "C001", name: "Priya Anand", phone: "+91 90031 22456", locality: "Chokkikulam, Madurai", ltv: 12450, khata: 1200, type: "Retail" },
      { id: "C002", name: "Karthik Raja", phone: "+91 98402 11099", locality: "KK Nagar, Madurai", ltv: 34800, khata: 0, type: "Wholesale" },
      { id: "C003", name: "Srinivasan", phone: "+91 94432 78000", locality: "Simmakkal, Madurai", ltv: 8900, khata: 450, type: "Retail" },
    ]);
  }
  if (readAll("orders_default", []).length === 0) {
    writeAll("orders_default", [
      { id: "ORD-928490", customer: "Priya Anand", phone: "+91 90031 22456", items: [{ n: "Ponni Rice", q: "2 kg", p: 116 }, { n: "Sugar", q: "1 kg", p: 44 }], total: 160, status: "Delivered", source: "AI Call", time: "10:30 AM", delivery: "Delivery" },
      { id: "ORD-928491", customer: "Karthik Raja", phone: "+91 98402 11099", items: [{ n: "Sunflower Oil", q: "5 litre", p: 760 }], total: 760, status: "Confirmed", source: "WhatsApp", time: "11:15 AM", delivery: "Pickup" },
    ]);
  }
}
seed();

// Twilio voice webhooks (no JSON body parser — Twilio uses form-encoding)
app.use("/voice", voiceRouter);

// WhatsApp Cloud API webhook (Meta requires the raw verification + JSON body)
app.use("/whatsapp", whatsappRouter);

// Dashboard REST API
app.use("/api", apiRouter);

app.get("/health", (req, res) => res.json({ ok: true, service: "voxai-kirana-backend" }));

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

// Attaches the /media-stream WebSocket endpoint Twilio's <Stream> connects to
attachMediaStreamServer(server);

server.listen(PORT, () => {
  console.log(`VoxAI Kirana backend listening on :${PORT}`);
  console.log(`Twilio voice webhook: POST ${process.env.PUBLIC_BASE_URL || "http://localhost:" + PORT}/voice/incoming`);
  console.log(`WhatsApp webhook:     GET/POST ${process.env.PUBLIC_BASE_URL || "http://localhost:" + PORT}/whatsapp/webhook`);
});
