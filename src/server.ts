import express from "express";
import { loadConfig } from "./config.js";
import { ClaudeExtractor } from "./extract.js";
import { handleMessage } from "./handler.js";
import { InstagramClient, parseInstagramWebhook } from "./instagram.js";
import { GoogleSheets } from "./sheets.js";
import { SupabaseStore } from "./store.js";
import type { Deps, MessengerPort } from "./types.js";
import { parseWebhook, verifySignature, WhatsAppClient } from "./whatsapp.js";

const config = loadConfig();

// Si WhatsApp no está configurado, el canal por defecto falla con un mensaje claro.
const noWhatsApp: MessengerPort = {
  sendText: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
  sendButtons: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
  downloadMedia: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
};

const verifyTokens = [config.whatsapp?.verifyToken, config.instagram?.verifyToken].filter(Boolean) as string[];
const appSecrets = [...new Set([config.whatsapp?.appSecret, config.instagram?.appSecret].filter(Boolean) as string[])];

const deps: Deps = {
  wa: config.whatsapp ? new WhatsAppClient(config.whatsapp) : noWhatsApp,
  ig: config.instagram ? new InstagramClient(config.instagram) : undefined,
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
  if (mode === "subscribe" && typeof token === "string" && verifyTokens.includes(token)) {
    res.status(200).send(String(challenge));
  } else {
    res.sendStatus(403);
  }
});

// Cuerpo crudo: la firma se calcula sobre los bytes exactos que envía Meta.
app.post("/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const raw = req.body as Buffer;
  const signature = req.get("x-hub-signature-256");
  if (!Buffer.isBuffer(raw) || !appSecrets.some((secret) => verifySignature(raw, signature, secret))) {
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
  const messages =
    (body as any)?.object === "instagram" ? parseInstagramWebhook(body) : parseWebhook(body);
  for (const msg of messages) {
    handleMessage(msg, deps).catch((err) => console.error("Fallo manejando el mensaje", msg.id, err));
  }
});

app.listen(config.port, () => {
  const canales = [config.whatsapp && "WhatsApp", config.instagram && "Instagram"].filter(Boolean).join(" + ");
  console.log(`Papeleo escuchando en el puerto ${config.port} (canales: ${canales})`);
});
