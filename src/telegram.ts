import { createHash, timingSafeEqual } from "node:crypto";
import type { Button, IncomingMessage, MessengerPort } from "./types.js";

export const TG_PREFIX = "tg:";
// Telegram admite 4096 caracteres por mensaje; se deja margen.
const MAX_TEXT = 4000;
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

/** Compara el secreto del webhook (cabecera X-Telegram-Bot-Api-Secret-Token) en tiempo constante. */
export function verifySecret(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(secret));
}

/** Convierte un `Update` de Telegram en un mensaje normalizado; null si no hay nada que procesar. */
export function parseTelegramUpdate(update: any): IncomingMessage | null {
  if (typeof update?.update_id !== "number") return null;
  // update_id es único y se repite en los reintentos de Telegram (message_id solo es único por chat).
  const id = `${TG_PREFIX}${update.update_id}`;

  const cb = update.callback_query;
  if (cb) {
    const chat = cb.message?.chat;
    if (cb.from?.is_bot || chat?.type !== "private" || typeof cb.data !== "string") return null;
    return {
      id,
      channel: "telegram",
      from: TG_PREFIX + chat.id,
      senderName: fullName(cb.from),
      kind: "button",
      buttonId: cb.data,
    };
  }

  const m = update.message; // se ignoran edited_message, channel_post, etc.
  if (!m || m.from?.is_bot || m.chat?.type !== "private") return null;
  const base = { id, channel: "telegram" as const, from: TG_PREFIX + m.chat.id, senderName: fullName(m.from) };

  if (Array.isArray(m.photo) && m.photo.length > 0) {
    // Las miniaturas vienen de menor a mayor tamaño: se usa la última.
    return { ...base, kind: "media", mediaId: m.photo[m.photo.length - 1].file_id, mimeType: "image/jpeg" };
  }
  if (m.document?.file_id) {
    return { ...base, kind: "media", mediaId: m.document.file_id, mimeType: m.document.mime_type ?? "application/octet-stream" };
  }
  if (typeof m.text === "string") return { ...base, kind: "text", text: m.text };
  return { ...base, kind: "other" };
}

/** Id del callback_query, para quitarle el «cargando» al botón pulsado. */
export function callbackQueryId(update: any): string | null {
  return typeof update?.callback_query?.id === "string" ? update.callback_query.id : null;
}

function fullName(from: any): string | null {
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ");
  return name || null;
}

/** Parte un texto largo en trozos que respeten el límite, cortando por líneas. */
export function chunkText(text: string, max = MAX_TEXT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const pieces = line.length > max ? (line.match(new RegExp(`.{1,${max}}`, "gs")) ?? []) : [line];
    for (const piece of pieces) {
      const candidate = current ? current + "\n" + piece : piece;
      if (candidate.length > max && current) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

/** Los textos usan *negrita* al estilo WhatsApp; sin parse_mode se muestran los asteriscos, así que se quitan. */
function plain(text: string): string {
  return text.replace(/\*/g, "");
}

export class TelegramClient implements MessengerPort {
  private api: string;
  private fileApi: string;

  // El token va en la URL de cada llamada: nunca se incluye una URL en errores ni logs.
  constructor(botToken: string) {
    this.api = `https://api.telegram.org/bot${botToken}`;
    this.fileApi = `https://api.telegram.org/file/bot${botToken}`;
  }

  private async call(method: string, payload: object): Promise<any> {
    const res = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || !json?.ok) {
      throw new Error(`Telegram ${method} respondió ${res.status}: ${json?.description ?? "sin detalle"}`);
    }
    return json.result;
  }

  private chat(to: string) {
    return to.startsWith(TG_PREFIX) ? to.slice(TG_PREFIX.length) : to;
  }

  async sendText(to: string, body: string) {
    for (const part of chunkText(plain(body))) {
      await this.call("sendMessage", { chat_id: this.chat(to), text: part });
    }
  }

  async sendButtons(to: string, body: string, buttons: Button[]) {
    const parts = chunkText(plain(body));
    for (const part of parts.slice(0, -1)) await this.call("sendMessage", { chat_id: this.chat(to), text: part });
    await this.call("sendMessage", {
      chat_id: this.chat(to),
      text: parts[parts.length - 1],
      reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.title, callback_data: b.id }))] },
    });
  }

  async answerCallbackQuery(callbackQueryId: string) {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  async setWebhook(url: string, secretToken: string) {
    await this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
    });
  }

  async downloadMedia(fileId: string) {
    const file = await this.call("getFile", { file_id: fileId });
    if (typeof file?.file_path !== "string") throw new Error("Telegram no devolvió la ruta del archivo");
    const res = await fetch(`${this.fileApi}/${file.file_path}`);
    if (!res.ok) throw new Error(`No se pudo descargar el archivo de Telegram: ${res.status}`);
    const ext = file.file_path.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = EXT_MIME[ext] ?? (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    return { data: Buffer.from(await res.arrayBuffer()), mimeType };
  }
}
