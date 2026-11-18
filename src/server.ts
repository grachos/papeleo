import express from "express";
import { AttemptLimiter } from "./access.js";
import { ClaudeAssistant } from "./assistant.js";
import { OpenAIAssistant } from "./assistant-openai.js";
import { LlamaParseExtractor, FallbackExtractor } from "./extract-llamaparse.js";
import LlamaCloud from "@llamaindex/llama-cloud";
import { createAdminRouter } from "./admin.js";
import { createInviteRouter } from "./invite.js";
import { createPanelRouter } from "./panel.js";
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
  sendLink: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
  downloadMedia: () => Promise.reject(new Error("El canal de WhatsApp no está configurado")),
};

const telegramClient = config.telegram ? new TelegramClient(config.telegram.botToken) : null;

const store = new SupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, config.supabase.bucket);

// Enlace de entrada al panel web: necesita la dirección pública del servicio (no se arma con datos de la petición).
const publicBase = config.publicUrl?.replace(/\/$/, "") ?? null;

function extractorPort() {
  const claude = config.anthropicApiKey ? new ClaudeExtractor(config.extractionModel) : null;
  if (config.extractionProvider === "llamaparse" && config.llamaCloudApiKey && config.openaiApiKey) {
    return new FallbackExtractor(
      new LlamaParseExtractor(
        { tier: config.llamaParseTier, model: config.openaiExtractionModel },
        new LlamaCloud({ apiKey: config.llamaCloudApiKey }) as unknown as import("./extract-llamaparse.js").ParseClient,
        LlamaParseExtractor.structurerWithKey(config.openaiApiKey),
      ),
      claude,
    );
  }
  if (config.extractionProvider === "llamaparse") {
    console.warn("EXTRACTION_PROVIDER=llamaparse pero faltan LLAMA_CLOUD_API_KEY u OPENAI_API_KEY: se lee con Claude.");
  }
  return claude ?? new ClaudeExtractor(config.extractionModel);
}

function chatAssistant() {
  if (config.chatProvider === "openai" && config.openaiApiKey) {
    return OpenAIAssistant.withKey(config.openaiChatModel, store, config.openaiApiKey);
  }
  if (config.chatProvider === "openai") {
    console.warn("CHAT_PROVIDER=openai pero falta OPENAI_API_KEY: el asistente usa Claude mientras tanto.");
  }
  return new ClaudeAssistant(config.queryModel, store);
}

const deps: Deps = {
  limiter: new AttemptLimiter(5, 60 * 60 * 1000), // 5 códigos erróneos por hora y remitente
  wa: config.whatsapp ? new WhatsAppClient(config.whatsapp) : noWhatsApp,
  tg: telegramClient ?? undefined,
  store,
  query: store,
  portal: publicBase
    ? {
        createLoginLink: async (memberId) => {
          const token = await store.createWebLogin(memberId);
          return token ? `${publicBase}/panel/entrar/${token}` : null;
        },
      }
    : undefined,
  assistant: chatAssistant(),
  dailyCap: config.queryDailyCap,
  extractor: extractorPort(),
  sheets: new GoogleSheets(config.googleServiceAccountJson),
};

const app = express();
app.set("trust proxy", 1); // Render termina TLS y reenvía la IP real

let botUsername: string | null = null;

// Página pública del enlace de invitación (el token de la ruta es lo único que da acceso).
// Si el arranque no pudo consultar el nombre del bot, se vuelve a intentar al armar la página (no se queda sin enlace).
async function currentBotUsername(): Promise<string | null> {
  if (config.telegram?.botUsername) return config.telegram.botUsername;
  if (!botUsername && telegramClient) {
    botUsername = await telegramClient.getUsername().catch(() => null);
  }
  return botUsername;
}

app.use(createInviteRouter({ store, botUsername: currentBotUsername }));

// Panel web de solo lectura: solo se entra con el enlace que entrega el bot.
app.use(createPanelRouter({ store, query: store }));

if (config.adminPassword) {
  app.use(createAdminRouter({ store, password: config.adminPassword, botUsername: currentBotUsername }));
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

const WEBHOOK_INTENTOS = 5;

function registrarWebhook(client: TelegramClient, url: string, secreto: string, intento: number): void {
  client
    .setWebhook(url, secreto)
    .then(() => console.log(`Webhook de Telegram registrado en ${url}`))
    .catch((err) => {
      console.error(`No se pudo registrar el webhook de Telegram (intento ${intento} de ${WEBHOOK_INTENTOS})`, err instanceof Error ? err.message : "error");
      if (intento < WEBHOOK_INTENTOS) setTimeout(() => registrarWebhook(client, url, secreto, intento + 1), intento * 30_000);
    });
}

app.listen(config.port, () => {
  const canales = [config.whatsapp && "WhatsApp", config.telegram && "Telegram"].filter(Boolean).join(" + ");
  console.log(`Papeleo escuchando en el puerto ${config.port} (canales: ${canales})`);

  if (telegramClient) {
    telegramClient.getUsername().then((u) => (botUsername = u)).catch((err) => console.error("No se pudo consultar el bot de Telegram", err));
  }

  // Registra el webhook de Telegram al arrancar, si se conoce la URL pública.
  // Telegram a veces responde 504: se reintenta con espera creciente para no quedarse sin webhook.
  if (config.telegram && telegramClient && publicBase) {
    registrarWebhook(telegramClient, `${publicBase}/telegram/webhook`, config.telegram.webhookSecret, 1);
  }
});
