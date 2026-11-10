import type { Button, IncomingMessage, MessengerPort } from "./types.js";

export const IG_PREFIX = "ig:";
// Instagram limita cada mensaje de texto (~1000 caracteres) y los títulos de respuesta rápida (20).
const MAX_TEXT = 900;
const MAX_QUICK_TITLE = 20;
// Solo se descargan adjuntos de los CDN de Meta (defensa extra contra URLs inesperadas).
const MEDIA_HOSTS = ["fbcdn.net", "cdninstagram.com", "fbsbx.com", "instagram.com"];

/** Convierte el cuerpo del webhook de Instagram (`object: "instagram"`) en mensajes planos. */
export function parseInstagramWebhook(body: any): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const ev of entry?.messaging ?? []) {
      const senderId = ev?.sender?.id;
      const m = ev?.message;
      if (typeof senderId !== "string" || !m || typeof m.mid !== "string") continue;
      // Ecos: mensajes que envía la propia cuenta; procesarlos causaría un bucle.
      if (m.is_echo || senderId === entry.id || senderId === ev?.recipient?.id) continue;
      if (m.is_deleted) continue;

      const base = { id: m.mid, channel: "instagram" as const, from: IG_PREFIX + senderId, senderName: null };
      const image = (m.attachments ?? []).find((a: any) => a?.type === "image" && typeof a?.payload?.url === "string");
      if (image) {
        // El tipo real se conoce al descargar; las imágenes de Instagram son JPEG/PNG/WebP.
        out.push({ ...base, kind: "media", mediaId: image.payload.url, mimeType: "image/jpeg" });
      } else if (m.quick_reply?.payload) {
        out.push({ ...base, kind: "button", buttonId: String(m.quick_reply.payload) });
      } else if (typeof m.text === "string") {
        out.push({ ...base, kind: "text", text: m.text });
      } else {
        out.push({ ...base, kind: "other" });
      }
    }
  }
  return out;
}

/** Parte un texto largo en trozos que respeten el límite, cortando por líneas. */
export function chunkText(text: string, max = MAX_TEXT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const pieces = line.length > max ? line.match(new RegExp(`.{1,${max}}`, "gs")) ?? [] : [line];
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

export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && MEDIA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

export class InstagramClient implements MessengerPort {
  private base: string;

  constructor(private opts: { accessToken: string; graphVersion: string }) {
    this.base = `https://graph.instagram.com/${opts.graphVersion}`;
  }

  private async send(to: string, message: object): Promise<void> {
    const res = await fetch(`${this.base}/me/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: to.startsWith(IG_PREFIX) ? to.slice(IG_PREFIX.length) : to }, message }),
    });
    if (!res.ok) throw new Error(`Instagram respondió ${res.status}: ${await res.text()}`);
  }

  async sendText(to: string, body: string) {
    for (const part of chunkText(body)) await this.send(to, { text: part });
  }

  async sendButtons(to: string, body: string, buttons: Button[]) {
    const parts = chunkText(body);
    for (const part of parts.slice(0, -1)) await this.send(to, { text: part });
    // Instagram no tiene botones de respuesta: se usan respuestas rápidas.
    await this.send(to, {
      text: parts[parts.length - 1],
      quick_replies: buttons.map((b) => ({
        content_type: "text",
        title: b.title.slice(0, MAX_QUICK_TITLE),
        payload: b.id,
      })),
    });
  }

  async downloadMedia(url: string) {
    if (!isAllowedMediaUrl(url)) throw new Error("URL de adjunto no permitida");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo descargar el adjunto: ${res.status}`);
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    return { data: Buffer.from(await res.arrayBuffer()), mimeType };
  }
}
