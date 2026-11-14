import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken } from "../src/access.js";
import { createPanelRouter } from "../src/panel.js";
import type { Expense, PanelPort, QueryPort } from "../src/types.js";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const EXP_ID = "0b3c5c52-7a0e-4b51-9c61-3a2f6f1e9a10";
const LOGIN = generateToken(); // distintos en cada corrida
const SESSION = generateToken();

const expense: Expense = {
  id: EXP_ID, fecha: "2026-11-03", proveedor: "Éxito <b>", nit: "890900608-9", numero_factura: "A123", subtotal: 38571, iva: 7329,
  total: 45900, moneda: "COP", categoria: "mercado_hogar", medio_pago: "tarjeta_debito", descripcion: "Mercado <script>alert(1)</script>", confianza: "alta",
};

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function start(over: Partial<PanelPort> = {}) {
  const store: PanelPort = {
    consumeLogin: vi.fn(async () => SESSION),
    session: vi.fn(async (t: string) => (t === SESSION ? { memberId: "m1", orgId: ORG, orgName: "Panadería <Sol>", memberName: "Ana" } : null)),
    endSession: vi.fn(async () => {}),
    list: vi.fn(async () => ({ rows: [expense], total: 60 })),
    ...over,
  };
  const query = {
    resumir: vi.fn(async (_org: string, a: { agrupar: string }) =>
      a.agrupar === "mes" ? [{ grupo: "2026-11", moneda: "COP", valor: 45900, cantidad: 1, con_dato: 1, total_grupos: 1 }]
      : a.agrupar === "categoria" ? [{ grupo: "mercado_hogar", moneda: "COP", valor: 45900, cantidad: 1, con_dato: 1, total_grupos: 1 }]
      : [{ grupo: "total", moneda: "COP", valor: 45900, cantidad: 1, con_dato: 1, total_grupos: 1 }]),
    detalle: vi.fn(async (org: string, id: string) => (org === ORG && id === EXP_ID ? expense : null)),
  };
  const app = express();
  app.use(createPanelRouter({ store, query: query as unknown as Pick<QueryPort, "resumir" | "detalle"> }));
  app.get("/otra", (_req, res) => void res.send("ok"));
  return new Promise<{ base: string; store: PanelPort; query: typeof query }>((resolve) => {
    server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${(server!.address() as any).port}`, store, query }));
  });
}
const withSession = { headers: { cookie: `papeleo_panel=${SESSION}` }, redirect: "manual" as const };
const post = (url: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", redirect: "manual", headers });

describe("entrada al panel", () => {
  it("GET solo muestra el botón: no canjea el enlace (los previsualizadores lo abren)", async () => {
    const { base, store } = await start();
    const res = await fetch(`${base}/panel/entrar/${LOGIN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Abrir mi panel");
    expect(store.consumeLogin).not.toHaveBeenCalled();
  });

  it("POST canjea el enlace una vez, abre la sesión con una cookie segura y redirige", async () => {
    const { base, store } = await start();
    const res = await post(`${base}/panel/entrar/${LOGIN}`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/panel");
    expect(store.consumeLogin).toHaveBeenCalledWith(LOGIN);
    expect(cookie).toContain(`papeleo_panel=${SESSION}`);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/panel", "Max-Age=28800"]) expect(cookie).toContain(flag);
  });

  it("un enlace malo, vencido o ya usado recibe siempre la misma respuesta, y se frenan los intentos", async () => {
    const { base } = await start({ consumeLogin: vi.fn(async () => null) });
    const malformado = await post(`${base}/panel/entrar/corto`);
    const desconocido = await post(`${base}/panel/entrar/${LOGIN}`);
    expect(malformado.status).toBe(404);
    expect(desconocido.status).toBe(404);
    expect(await malformado.text()).toBe(await desconocido.text());
    expect(desconocido.headers.get("set-cookie")).toBeNull();

    for (let i = 0; i < 8; i++) await post(`${base}/panel/entrar/${generateToken()}`);
    expect((await post(`${base}/panel/entrar/${generateToken()}`)).status).toBe(429);
  });

  it("si la base falla responde un error amable y no registra el token", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { base } = await start({ consumeLogin: vi.fn(async () => { throw new Error("relation papeleo_web_logins does not exist"); }) });
    const res = await post(`${base}/panel/entrar/${LOGIN}`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("papeleo_web_logins");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(LOGIN);
    spy.mockRestore();
  });
});

describe("sin sesión no se ve nada", () => {
  it("sin cookie, con cookie inventada o con sesión revocada: 401 genérico, sin datos y sin consultar facturas", async () => {
    const { base, store, query } = await start();
    const sinCookie = await fetch(`${base}/panel`);
    const inventada = await fetch(`${base}/panel`, { headers: { cookie: `papeleo_panel=${randomBytes(32).toString("base64url")}` } });
    const malformada = await fetch(`${base}/panel/factura/${EXP_ID}`, { headers: { cookie: "papeleo_panel=x" } });
    for (const res of [sinCookie, inventada, malformada]) {
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain("desde Telegram");
      expect(html).not.toContain("Éxito");
    }
    expect(store.list).not.toHaveBeenCalled();
    expect(query.resumir).not.toHaveBeenCalled();
    expect(query.detalle).not.toHaveBeenCalled();
    expect(store.session).toHaveBeenCalledTimes(1); // la cookie malformada ni llega a la base
  });

  it("si el almacén dice que la sesión ya no vale (revocada, vencida o persona sin acceso), se cierra de inmediato", async () => {
    const { base } = await start({ session: vi.fn(async () => null) });
    const res = await fetch(`${base}/panel`, withSession);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0"); // se borra la cookie
  });
});

describe("con sesión", () => {
  it("usa SIEMPRE la empresa de la sesión, aunque la petición traiga otra", async () => {
    const { base, store, query } = await start();
    const res = await fetch(`${base}/panel?org_id=11111111-2222-4222-8222-333333333333&orgId=otra&desde=2026-11-01&categoria=combustible&proveedor=Terpel`, withSession);
    expect(res.status).toBe(200);
    expect(store.list).toHaveBeenCalledWith(ORG, { desde: "2026-11-01", categoria: "combustible", proveedor: "Terpel" }, 1, 25);
    for (const call of query.resumir.mock.calls) expect(call[0]).toBe(ORG);
    expect(query.resumir.mock.calls[0][1]).toMatchObject({ desde: "2026-11-01", categoria: "combustible", proveedor: "Terpel" });
    expect(JSON.stringify(query.resumir.mock.calls)).not.toContain("11111111");
  });

  it("muestra los totales, el listado y la paginación; todo lo que viene de facturas va escapado", async () => {
    const { base, store } = await start();
    const html = await (await fetch(`${base}/panel?pagina=2&proveedor=%C3%89xito`, withSession)).text();
    expect(store.list).toHaveBeenCalledWith(ORG, { proveedor: "Éxito" }, 2, 25);
    expect(html).toContain("Panadería &lt;Sol&gt;");
    expect(html).toContain("Éxito &lt;b&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("Éxito <b>");
    expect(html).toContain("Página 2 de 3"); // 60 facturas, 25 por página
    expect(html).toContain("← Anterior");
    expect(html).toContain("Siguiente →");
    expect(html).toContain("proveedor=%C3%89xito"); // los filtros viajan en los enlaces de página
    expect(html).toContain("2026-11");
    expect(html).toContain("mercado hogar");
    expect(html).toContain("solo lectura");
  });

  it("rechaza filtros inválidos sin consultar nada", async () => {
    const { base, store, query } = await start();
    for (const q of ["desde=ayer", "desde=2026-02-31", "categoria=inventada", "pagina=0", "pagina=99999", `proveedor=${"x".repeat(81)}`, "desde=2026-01-01&desde=2026-02-01"]) {
      const res = await fetch(`${base}/panel?${q}`, withSession);
      expect([q, res.status]).toEqual([q, 400]);
    }
    expect(store.list).not.toHaveBeenCalled();
    expect(query.resumir).not.toHaveBeenCalled();
  });

  it("trata los filtros vacíos del formulario como ausentes", async () => {
    const { base, store } = await start();
    await fetch(`${base}/panel?desde=&hasta=&categoria=&proveedor=&texto=&pagina=`, withSession);
    expect(store.list).toHaveBeenCalledWith(ORG, {}, 1, 25);
  });

  it("el detalle usa la empresa de la sesión; una factura de otra empresa o un id inválido dan 404 sin pistas", async () => {
    const { base, query } = await start();
    const ok = await fetch(`${base}/panel/factura/${EXP_ID}`, withSession);
    const html = await ok.text();
    expect(ok.status).toBe(200);
    expect(query.detalle).toHaveBeenCalledWith(ORG, EXP_ID);
    expect(html).toContain("Éxito &lt;b&gt;");
    expect(html).toContain("todavía no se pueden ver");

    const ajena = await fetch(`${base}/panel/factura/99999999-9999-4999-8999-999999999999`, withSession);
    const invalida = await fetch(`${base}/panel/factura/no-es-uuid`, withSession);
    expect(ajena.status).toBe(404);
    expect(invalida.status).toBe(404);
    expect(await ajena.text()).toBe(await invalida.text());
    expect(query.detalle).toHaveBeenCalledTimes(2); // el id inválido ni se consulta
  });

  it("salir revoca la sesión en el servidor y borra la cookie", async () => {
    const { base, store } = await start();
    const res = await post(`${base}/panel/salir`, { cookie: `papeleo_panel=${SESSION}` });
    expect(res.status).toBe(200);
    expect(store.endSession).toHaveBeenCalledWith(SESSION);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("si la base falla en el panel no filtra detalles", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { base } = await start({ list: vi.fn(async () => { throw new Error("connection to 10.0.0.1 refused"); }) });
    const res = await fetch(`${base}/panel`, withSession);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("10.0.0.1");
    spy.mockRestore();
  });
});

describe("encabezados", () => {
  it("las páginas del panel no se guardan, no se indexan, no envían referer y no cargan nada externo", async () => {
    const { base } = await start();
    for (const res of [await fetch(`${base}/panel`), await fetch(`${base}/panel`, withSession), await fetch(`${base}/panel/entrar/${LOGIN}`)]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
    expect((await fetch(`${base}/otra`)).headers.get("content-security-policy")).toBeNull();
  });
});
