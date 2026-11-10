import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminRouter } from "../src/admin.js";
import type { AdminPort } from "../src/types.js";

const PASSWORD = `test-${randomBytes(8).toString("hex")}`; // generada en cada corrida: no hay contraseñas escritas en el código
const ID = "0b3c5c52-7a0e-4b51-9c61-3a2f6f1e9a10";

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function start(store: Partial<AdminPort> = {}) {
  const full: AdminPort = {
    listOrgs: vi.fn(async () => [{ id: ID, name: "Panadería <Sol>" }]),
    createCode: vi.fn(async () => ({ code: "K7QD-M3XP-9TWB", orgName: "Panadería <Sol>" })),
    listCodes: vi.fn(async () => []),
    revokeCode: vi.fn(async () => {}),
    listMembers: vi.fn(async () => []),
    revokeMember: vi.fn(async () => {}),
    ...store,
  };
  const app = express();
  app.use(createAdminRouter({ store: full, password: PASSWORD, botUsername: () => "papeleo_bot" }));
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
  const res = await fetch(`${base}/admin/login`, form({ password: PASSWORD }));
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

    const res = await fetch(`${base}/admin/codes`, form({ newOrgName: "X", csrf: "x" }));
    expect(res.status).toBe(303);
    expect(store.createCode).not.toHaveBeenCalled();
  });

  it("rechaza la contraseña incorrecta y bloquea tras 5 intentos", async () => {
    const { base } = await start();
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/admin/login`, form({ password: "mala" }))).status).toBe(401);
    expect((await fetch(`${base}/admin/login`, form({ password: PASSWORD }))).status).toBe(429);
  });

  it("con la contraseña correcta abre una sesión HttpOnly y SameSite=Strict", async () => {
    const { base } = await start();
    const { res, page } = await login(base);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(res.status).toBe(303);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(page).toContain("Crear código de acceso");
    expect(page).toContain("Panadería &lt;Sol&gt;"); // escapado
    expect(page).not.toContain("Panadería <Sol>");
  });

  it("crea un código nuevo, lo muestra una vez con el enlace del bot", async () => {
    const { base, store } = await start();
    const { cookie, csrf } = await login(base);
    const res = await fetch(`${base}/admin/codes`, { ...form({ csrf, orgId: "", newOrgName: "Cliente Nuevo", note: "Contadora" }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });
    const html = await res.text();
    expect(store.createCode).toHaveBeenCalledWith({ orgId: undefined, newOrgName: "Cliente Nuevo", note: "Contadora" });
    expect(html).toContain("K7QD-M3XP-9TWB");
    expect(html).toContain("https://t.me/papeleo_bot?start=K7QDM3XP9TWB");
  });

  it("rechaza un POST con token CSRF incorrecto", async () => {
    const { base, store } = await start();
    const { cookie } = await login(base);
    const res = await fetch(`${base}/admin/codes`, { ...form({ csrf: "falso", newOrgName: "X" }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });
    expect(res.status).toBe(403);
    expect(store.createCode).not.toHaveBeenCalled();
  });

  it("revoca códigos y personas, y descarta ids con formato inválido", async () => {
    const { base, store } = await start();
    const { cookie, csrf } = await login(base);
    const post = (path: string) => fetch(`${base}${path}`, { ...form({ csrf }), headers: { "Content-Type": "application/x-www-form-urlencoded", cookie } });

    await post(`/admin/codes/${ID}/revoke`);
    await post(`/admin/members/${ID}/revoke`);
    await post(`/admin/members/no-es-uuid/revoke`);
    expect(store.revokeCode).toHaveBeenCalledWith(ID);
    expect(store.revokeMember).toHaveBeenCalledOnce();
    expect(store.revokeMember).toHaveBeenCalledWith(ID);
  });

  it("no aplica los encabezados del panel a otras rutas", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/otra`)).headers.get("content-security-policy")).toBeNull();
    expect((await fetch(`${base}/admin`)).headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
