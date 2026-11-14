import { createHmac, timingSafeEqual } from "node:crypto";
import type { Button, IncomingMessage, WhatsAppPort } from "./types.js";

/** Valida la cabecera X-Hub-Signature-256 contra el cuerpo crudo del webhook. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice(7), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Convierte el cuerpo del webhook en una lista plana de mensajes. */
export function parseWebhook(body: any): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const names = new Map<string, string>();
      for (const c of value?.contacts ?? []) names.set(c.wa_id, c.profile?.name);

      for (const m of value?.messages ?? []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        const base = { id: m.id, from: m.from, senderName: names.get(m.from) ?? null };
        if (m.type === "text") {
          out.push({ ...base, kind: "text", text: String(m.text?.body ?? "") });
        } else if (m.type === "image" || m.type === "document") {
          const media = m[m.type];
          out.push({ ...base, kind: "media", mediaId: media?.id, mimeType: media?.mime_type });
        } else if (m.type === "interactive" && m.interactive?.button_reply) {
          out.push({ ...base, kind: "button", buttonId: m.interactive.button_reply.id });
        } else {
          out.push({ ...base, kind: "other" });
        }
      }
    }
  }
  return out;
}

export class WhatsAppClient implements WhatsAppPort {
  private base: string;

  constructor(private opts: { accessToken: string; phoneNumberId: string; graphVersion: string }) {
    this.base = `https://graph.facebook.com/${opts.graphVersion}`;
  }

  private auth() {
    return { Authorization: `Bearer ${this.opts.accessToken}` };
  }

  private async send(to: string, payload: object): Promise<void> {
    const res = await fetch(`${this.base}/${this.opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
    });
    if (!res.ok) throw new Error(`WhatsApp respondió ${res.status}: ${await res.text()}`);
  }

  sendText(to: string, body: string) {
    return this.send(to, { type: "text", text: { body } });
  }

  sendLink(to: string, body: string, label: string, url: string) {
    return this.sendText(to, `${body}\n\n${label}: ${url}`);
  }

  sendButtons(to: string, body: string, buttons: Button[]) {
    return this.send(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
      },
    });
  }

  async downloadMedia(mediaId: string) {
    const meta = await fetch(`${this.base}/${encodeURIComponent(mediaId)}`, { headers: this.auth() });
    if (!meta.ok) throw new Error(`No se pudo consultar el archivo: ${meta.status}`);
    const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };

    const file = await fetch(url, { headers: this.auth() });
    if (!file.ok) throw new Error(`No se pudo descargar el archivo: ${file.status}`);
    return { data: Buffer.from(await file.arrayBuffer()), mimeType: mime_type };
  }
}
