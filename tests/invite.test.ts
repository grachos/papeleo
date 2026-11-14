import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateInviteToken, hashToken, INVITE_TOKEN_RE } from "../src/access.js";
import { createInviteRouter } from "../src/invite.js";
import { invitationState } from "../src/invitations.js";
import type { InvitePort } from "../src/types.js";

const TOKEN = generateInviteToken(); // distinto en cada corrida
const TICKET = "K7QD-M3XP-9TWB";

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function start(issue: InvitePort["issueTicket"], bot: string | null = "papeleo_bot") {
  const store: InvitePort = { issueTicket: vi.fn(issue) };
  const app = express();
  app.use(createInviteRouter({ store, botUsername: () => bot }));
  return new Promise<{ base: string; store: InvitePort }>((resolve) => {
    server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${(server!.address() as any).port}`, store }));
  });
}
const ok = async () => ({ ticket: TICKET, orgName: "Panadería <Sol>", expiresAt: "2026-11-14T15:30:00.000Z" });
const post = (url: string) => fetch(url, { method: "POST", redirect: "manual" });

describe("tokens de invitación", () => {
  it("son aleatorios, de 43 caracteres base64url y se guardan solo como hash", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateInviteToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(INVITE_TOKEN_RE);
    expect(hashToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(TOKEN)).not.toContain(TOKEN.slice(0, 8));
    expect(INVITE_TOKEN_RE.test("corto")).toBe(false);
    expect(INVITE_TOKEN_RE.test(randomBytes(40).toString("base64url"))).toBe(false);
  });
});

describe("página pública del enlace", () => {
  it("GET solo muestra el botón: no consulta la base ni genera ticket (los previsualizadores abren los enlaces)", async () => {
    const { base, store } = await start(ok);
    const res = await fetch(`${base}/acceso/${TOKEN}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Generar mi ticket");
    expect(html).not.toContain(TICKET);
    expect(store.issueTicket).not.toHaveBeenCalled();
  });

  it("POST genera el ticket con su hora de vencimiento y el enlace «Abrir en Telegram»", async () => {
    const { base, store } = await start(ok);
    const html = await (await post(`${base}/acceso/${TOKEN}`)).text();
    expect(store.issueTicket).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain(TICKET);
    expect(html).toContain("https://t.me/papeleo_bot?start=K7QDM3XP9TWB"); // el ticket va sin guiones en el enlace
    expect(html).toContain("10:30"); // 15:30 UTC = 10:30 en Colombia
    expect(html).toContain("Panadería &lt;Sol&gt;"); // escapado
  });

  it("sin usuario del bot muestra solo el ticket", async () => {
    const { base } = await start(ok, null);
    const html = await (await post(`${base}/acceso/${TOKEN}`)).text();
    expect(html).toContain(TICKET);
    expect(html).not.toContain("t.me");
  });

  it("enlace inexistente, vencido, revocado o usado: la misma respuesta genérica, sin pistas", async () => {
    const { base } = await start(async () => null);
    const malformado = await post(`${base}/acceso/${"x".repeat(10)}`);
    const desconocido = await post(`${base}/acceso/${TOKEN}`);
    expect(malformado.status).toBe(404);
    expect(desconocido.status).toBe(404);
    expect(await malformado.text()).toBe(await desconocido.text());
  });

  it("frena los intentos con enlaces malos desde la misma dirección", async () => {
    const { base } = await start(async () => null);
    for (let i = 0; i < 10; i++) expect((await post(`${base}/acceso/${randomBytes(32).toString("base64url")}`)).status).toBe(404);
    expect((await post(`${base}/acceso/${randomBytes(32).toString("base64url")}`)).status).toBe(429);
  });

  it("si la base falla responde un error amable y no filtra detalles", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { base } = await start(async () => {
      throw new Error("relation papeleo_invitations does not exist");
    });
    const res = await post(`${base}/acceso/${TOKEN}`);
    const html = await res.text();
    expect(res.status).toBe(500);
    expect(html).not.toContain("papeleo_invitations");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN); // el token nunca se registra
    spy.mockRestore();
  });

  it("la página no deja rastros: sin caché, sin referer, sin indexar y sin recursos externos", async () => {
    const { base } = await start(ok);
    for (const res of [await fetch(`${base}/acceso/${TOKEN}`), await post(`${base}/acceso/${TOKEN}`)]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });
});

describe("invitationState", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const vigente = { status: "activa" as const, expires_at: "2026-11-15T10:00:00Z" };

  it("deriva el estado que ve el administrador", () => {
    expect(invitationState({ ...vigente, status: "revocada" }, null, now).state).toBe("revocada");
    expect(invitationState({ ...vigente, status: "usada" }, null, now).state).toBe("vinculada");
    expect(invitationState({ ...vigente, expires_at: "2026-11-14T11:00:00Z" }, null, now).state).toBe("vencida");
    expect(invitationState(vigente, null, now).state).toBe("pendiente");
    expect(invitationState(vigente, { status: "activo", expires_at: "2026-11-14T12:10:00Z" }, now)).toEqual({ state: "ticket", ticketExpiresAt: "2026-11-14T12:10:00Z" });
  });

  it("un ticket vencido, revocado o usado no cuenta como vigente", () => {
    expect(invitationState(vigente, { status: "activo", expires_at: "2026-11-14T11:55:00Z" }, now).state).toBe("pendiente");
    expect(invitationState(vigente, { status: "revocado", expires_at: "2026-11-14T12:10:00Z" }, now).state).toBe("pendiente");
  });
});
