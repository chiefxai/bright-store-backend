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
