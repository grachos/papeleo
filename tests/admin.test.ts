import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminRouter } from "../src/admin.js";
import type { AdminPort } from "../src/types.js";

const CLAVE_ADMIN = randomBytes(12).toString("hex"); // distinta en cada corrida
const ID = "0b3c5c52-7a0e-4b51-9c61-3a2f6f1e9a10";
const TOKEN = randomBytes(32).toString("base64url"); // distinto en cada corrida

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function start(store: Partial<AdminPort> = {}) {
  const full: AdminPort = {
    listOrgs: vi.fn(async () => [{ id: ID, name: "Panadería <Sol>" }]),
    createInvitation: vi.fn(async () => ({ token: TOKEN, orgName: "Panadería <Sol>", expiresAt: "2026-11-15T12:00:00.000Z" })),
    listInvitations: vi.fn(async () => []),
    revokeInvitation: vi.fn(async () => {}),
    listMembers: vi.fn(async () => []),
    revokeMember: vi.fn(async () => {}),
    ...store,
  };
  const app = express();
  app.use(createAdminRouter({ store: full, password: CLAVE_ADMIN, botUsername: () => "papeleo_bot" }));
  app.get("/otra", (_req, res) => void res.send("ok"));
  return new Promise<{ base: string; store: AdminPort }>((resolve) => {
    server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${(server!.address() as any).port}`, store: full }));
  });
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
  redirect: "manual" as const,
});

async function login(base: string) {
  const res = await fetch(`${base}/admin/login`, form({ password: CLAVE_ADMIN }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)?.[1] ?? "";
  return { res, cookie, csrf, page };
}

describe("panel de administración", () => {
  it("sin sesión muestra el login y los POST redirigen sin ejecutar nada", async () => {
    const { base, store } = await start();
    const page = await (await fetch(`${base}/admin`)).text();
    expect(page).toContain('type="password"');
    expect(page).not.toContain("Crear código");

    const res = await fetch(`${base}/admin/invitations`, form({ newOrgName: "X", csrf: "x" }));
    expect(res.status).toBe(303);
    expect(store.createInvitation).not.toHaveBeenCalled();
  });

  it("rechaza la contraseña incorrecta y bloquea tras 5 intentos", async () => {
    const { base } = await start();
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/admin/login`, form({ password: "mala" }))).status).toBe(401);
    expect((await fetch(`${base}/admin/login`, form({ password: CLAVE_ADMIN }))).status).toBe(429);
  });

  it("con la contraseña correcta abre una sesión HttpOnly y SameSite=Strict", async () => {
    const { base } = await start();
    const { res, page } = await login(base);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(res.status).toBe(303);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(page).toContain("Crear enlace de acceso");
    expect(page).toContain("Panadería &lt;Sol&gt;"); // escapado
    expect(page).not.toContain("Panadería <Sol>");
  });

  it("crea una invitación y muestra el enlace completo una sola vez", async () => {
    const { base, store } = await start();
    const { cookie, csrf } = await login(base);
    const res = await fetch(`${base}/admin/invitations`, { ...form({ csrf, orgId: "", newOrgName: "Cliente Nuevo", note: "Contadora" }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });
    const html = await res.text();
    expect(store.createInvitation).toHaveBeenCalledWith({ orgId: undefined, newOrgName: "Cliente Nuevo", note: "Contadora" });
    expect(html).toContain(`${base}/acceso/${TOKEN}`);
    expect(html).toContain("no se vuelve a mostrar");
    // al recargar el panel el enlace ya no aparece
    const again = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
    expect(again).not.toContain(TOKEN);
  });

  it("ya no existe la creación de códigos que no vencen", async () => {
    const { base } = await start();
    const { cookie, csrf } = await login(base);
    const res = await fetch(`${base}/admin/codes`, { ...form({ csrf, newOrgName: "X" }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });
    expect(res.status).toBe(404);
  });

  it("lista los enlaces con su estado (pendiente, ticket, vinculada, vencida, revocada) y solo ofrece revocar los vigentes", async () => {
    const base_ = { note: "n", org_name: "Sol", created_at: "2026-11-14T10:00:00Z", expires_at: "2026-11-15T10:00:00Z", ticket_expires_at: null, linked_name: null, linked_at: null };
    const { base } = await start({
      listInvitations: vi.fn(async () => [
        { ...base_, id: "00000000-0000-4000-8000-000000000001", state: "pendiente" as const },
        { ...base_, id: "00000000-0000-4000-8000-000000000002", state: "ticket" as const, ticket_expires_at: "2026-11-14T15:30:00Z" },
        { ...base_, id: "00000000-0000-4000-8000-000000000003", state: "vinculada" as const, linked_name: "Ana <b>", linked_at: "2026-11-14T11:00:00Z" },
        { ...base_, id: "00000000-0000-4000-8000-000000000004", state: "vencida" as const },
        { ...base_, id: "00000000-0000-4000-8000-000000000005", state: "revocada" as const },
      ]),
    });
    const { page } = await login(base);
    for (const t of ["Pendiente", "Ticket emitido", "Vinculada", "Vencida", "Revocada"]) expect(page).toContain(t);
    expect(page).toContain("Ana &lt;b&gt;");
    expect(page.match(/\/admin\/invitations\/[0-9a-f-]+\/revoke/g)).toHaveLength(2); // solo pendiente y ticket
  });

  it("rechaza un POST con token CSRF incorrecto", async () => {
    const { base, store } = await start();
    const { cookie } = await login(base);
    const res = await fetch(`${base}/admin/invitations`, { ...form({ csrf: "falso", newOrgName: "X" }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });
    expect(res.status).toBe(403);
    expect(store.createInvitation).not.toHaveBeenCalled();
  });

  it("revoca enlaces y personas, y descarta ids con formato inválido", async () => {
    const { base, store } = await start();
    const { cookie, csrf } = await login(base);
    const post = (path: string) => fetch(`${base}${path}`, { ...form({ csrf }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });

    await post(`/admin/invitations/${ID}/revoke`);
    await post(`/admin/invitations/no-es-uuid/revoke`);
    await post(`/admin/members/${ID}/revoke`);
    await post(`/admin/members/no-es-uuid/revoke`);
    expect(store.revokeInvitation).toHaveBeenCalledOnce();
    expect(store.revokeInvitation).toHaveBeenCalledWith(ID);
    expect(store.revokeMember).toHaveBeenCalledOnce();
    expect(store.revokeMember).toHaveBeenCalledWith(ID);
  });

  it("no aplica los encabezados del panel a otras rutas", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/otra`)).headers.get("content-security-policy")).toBeNull();
    expect((await fetch(`${base}/admin`)).headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
