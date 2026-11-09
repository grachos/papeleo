import express from "express";
import { loadConfig } from "./config.js";
import { ClaudeExtractor } from "./extract.js";
import { handleMessage } from "./handler.js";
import { GoogleSheets } from "./sheets.js";
import { SupabaseStore } from "./store.js";
import type { Deps } from "./types.js";
import { parseWebhook, verifySignature, WhatsAppClient } from "./whatsapp.js";

const config = loadConfig();

const deps: Deps = {
  wa: new WhatsAppClient(config.whatsapp),
  store: new SupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, config.supabase.bucket),
  extractor: new ClaudeExtractor(config.extractionModel),
  sheets: new GoogleSheets(config.googleServiceAccountJson),
};

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Verificación inicial del webhook que hace Meta al configurarlo.
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    res.status(200).send(String(challenge));
  } else {
    res.sendStatus(403);
  }
});

// Cuerpo crudo: la firma se calcula sobre los bytes exactos que envía Meta.
app.post("/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.get("x-hub-signature-256"), config.whatsapp.appSecret)) {
    res.sendStatus(401);
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.sendStatus(400);
    return;
  }

  // Meta exige respuesta rápida; el procesamiento sigue en segundo plano.
  res.sendStatus(200);
  for (const msg of parseWebhook(body)) {
    handleMessage(msg, deps).catch((err) => console.error("Fallo manejando el mensaje", msg.id, err));
  }
});

app.listen(config.port, () => {
  console.log(`Papeleo escuchando en el puerto ${config.port}`);
});
