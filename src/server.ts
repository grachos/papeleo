import express from "express";
import { AttemptLimiter } from "./access.js";
import { ClaudeAssistant } from "./assistant.js";
import { createAdminRouter } from "./admin.js";
import { loadConfig } from "./config.js";
import { ClaudeExtractor } from "./extract.js";
import { handleMessage } from "./handler.js";
import { GoogleSheets } from "./sheets.js";
import { SupabaseStore } from "./store.js";
import { callbackQueryId, parseTelegramUpdate, TelegramClient, verifySecret } from "./telegram.js";
import type { Deps, MessengerPort } from "./types.js";
import { parseWebhook, verifySignature, WhatsAppClient } from "./whatsapp.js";

const config = loadConfig();

// Si WhatsApp no está configurado, el canal por defecto falla con un mensaje claro.
const noWhatsApp: MessengerPort = {
  sendText: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
  sendButtons: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
  downloadMedia: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
};

const telegramClient = config.telegram ? new TelegramClient(config.telegram.botToken) : null;

const store = new SupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, config.supabase.bucket);

const deps: Deps = {
  limiter: new AttemptLimiter(5, 60 * 60 * 1000), // 5 códigos erróneos por hora y remitente
  wa: config.whatsapp ? new WhatsAppClient(config.whatsapp) : noWhatsApp,
  tg: telegramClient ?? undefined,
  store,
  query: store,
  assistant: new ClaudeAssistant(config.queryModel, store),
  dailyCap: config.queryDailyCap,
  extractor: new ClaudeExtractor(config.extractionModel),
  sheets: new GoogleSheets(config.googleServiceAccountJson),
};

const app = express();
app.set("trust proxy", 1); // Render termina TLS y reenvía la IP real

let botUsername: string | null = null;

if (config.adminPassword) {
  app.use(createAdminRouter({ store, password: config.adminPassword, botUsername: () => botUsername }));
} else {
  console.warn("ADMIN_PASSWORD no está definida: no hay panel de administración y nadie podrá obtener acceso.");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

if (config.whatsapp) {
  const whatsapp = config.whatsapp;

  // Verificación inicial del webhook que hace Meta al configurarlo.
  app.get("/webhook", (req, res) => {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === whatsapp.verifyToken) {
      res.status(200).send(String(challenge));
    } else {
      res.sendStatus(403);
    }
  });

  // Cuerpo crudo: la firma se calcula sobre los bytes exactos que envía Meta.
  app.post("/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.get("x-hub-signature-256"), whatsapp.appSecret)) {
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
}

if (config.telegram && telegramClient) {
  const telegram = config.telegram;

  // Telegram autentica con el secreto que se le dio en setWebhook, enviado en esta cabecera.
  app.post("/telegram/webhook", express.json({ limit: "1mb" }), (req, res) => {
    if (!verifySecret(req.get("x-telegram-bot-api-secret-token"), telegram.webhookSecret)) {
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200); // respuesta rápida; el procesamiento sigue en segundo plano

    const cbId = callbackQueryId(req.body);
    if (cbId) telegramClient.answerCallbackQuery(cbId).catch(() => {});

    const msg = parseTelegramUpdate(req.body);
    if (!msg) return;

    // El acceso lo decide el manejador: quien no está vinculado es ignorado en silencio.
    handleMessage(msg, deps).catch((err) => console.error("Fallo manejando el mensaje", msg.id, err));
  });
}

app.listen(config.port, () => {
  const canales = [config.whatsapp && "WhatsApp", config.telegram && "Telegram"].filter(Boolean).join(" + ");
  console.log(`Papeleo escuchando en el puerto ${config.port} (canales: ${canales})`);

  if (telegramClient) {
    telegramClient.getUsername().then((u) => (botUsername = u)).catch((err) => console.error("No se pudo consultar el bot de Telegram", err));
  }

  // Registra el webhook de Telegram al arrancar, si se conoce la URL pública.
  if (config.telegram && telegramClient && config.telegram.publicUrl) {
    const url = `${config.telegram.publicUrl.replace(/\/$/, "")}/telegram/webhook`;
    telegramClient
      .setWebhook(url, config.telegram.webhookSecret)
      .then(() => console.log(`Webhook de Telegram registrado en ${url}`))
      .catch((err) => console.error("No se pudo registrar el webhook de Telegram", err));
  }
});
