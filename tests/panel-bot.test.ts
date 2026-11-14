import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import { SupabaseStore } from "../src/store.js";
import { TelegramClient } from "../src/telegram.js";
import type { Deps, IncomingMessage } from "../src/types.js";

const member = { id: "m1", org_id: "o1", phone: "tg:42", name: "Ana" };
const org = { id: "o1", name: "Panadería Sol", sheet_id: null };
const msg = (text: string): IncomingMessage => ({ id: "tg:1", channel: "telegram", from: "tg:42", senderName: "Ana", kind: "text", text });

function setup(over: { linked?: boolean; link?: string | null | Error; portal?: boolean } = {}) {
  const tg = { sendText: vi.fn(async () => {}), sendButtons: vi.fn(async () => {}), sendLink: vi.fn(async () => {}), downloadMedia: vi.fn() };
  const createLoginLink = vi.fn(async () => {
    if (over.link instanceof Error) throw over.link;
    return over.link === undefined ? "https://papeleo.test/panel/entrar/TOKEN" : over.link;
  });
  const store = { findMember: vi.fn(async () => (over.linked === false ? null : { member, org })), redeemCode: vi.fn(async () => null) };
  const assistant = { answer: vi.fn() };
  const deps = {
    wa: { sendText: vi.fn(), sendButtons: vi.fn(), sendLink: vi.fn(), downloadMedia: vi.fn() },
    tg, store, assistant, query: {}, portal: over.portal === false ? undefined : { createLoginLink },
  } as unknown as Deps;
  return { tg, createLoginLink, assistant, deps };
}

describe("comando «panel»", () => {
  it("entrega el enlace de un solo uso con un botón, sin llamar a la IA", async () => {
    const { tg, createLoginLink, assistant, deps } = setup();
    await handleMessage(msg("panel"), deps);
    await handleMessage(msg("/panel@papeleo_bot"), deps);
    expect(createLoginLink).toHaveBeenCalledWith("m1"); // la identidad sale del miembro vinculado
    expect(tg.sendLink).toHaveBeenCalledTimes(2);
    const [to, body, label, url] = tg.sendLink.mock.calls[0] as unknown as string[];
    expect(to).toBe("tg:42");
    expect(body).toContain("5 minutos");
    expect(label).toBe("Abrir mi panel");
    expect(url).toBe("https://papeleo.test/panel/entrar/TOKEN");
    expect(assistant.answer).not.toHaveBeenCalled();
  });

  it("quien no está vinculado no recibe nada: ni enlace ni respuesta", async () => {
    const { tg, createLoginLink, deps } = setup({ linked: false });
    await handleMessage(msg("panel"), deps);
    expect(createLoginLink).not.toHaveBeenCalled();
    expect(tg.sendLink).not.toHaveBeenCalled();
    expect(tg.sendText).not.toHaveBeenCalled();
  });

  it("si el panel no está configurado o el enlace no se pudo crear, lo dice con honestidad", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const over of [{ portal: false }, { link: null }, { link: new Error("db caída 10.0.0.1") }]) {
      const { tg, deps } = setup(over);
      await handleMessage(msg("panel"), deps);
      expect(tg.sendLink).not.toHaveBeenCalled();
      expect(String((tg.sendText.mock.calls[0] as any)[1])).toContain("no está disponible");
    }
    spy.mockRestore();
  });
});

describe("TelegramClient.sendLink", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("manda el mensaje con un botón de enlace al chat sin prefijo", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramClient("TOKEN").sendLink("tg:42", "*Tu panel*", "Abrir mi panel", "https://x.test/panel/entrar/T");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "42",
      text: "Tu panel",
      reply_markup: { inline_keyboard: [[{ text: "Abrir mi panel", url: "https://x.test/panel/entrar/T" }]] },
    });
  });
});

describe("SupabaseStore: panel web (nombres de parámetros y forma de las respuestas)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const rpc = (rows: unknown) => new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  const call = (fetchMock: ReturnType<typeof vi.fn>, n = 0) => {
    const [url, init] = fetchMock.mock.calls[n] as unknown as [string, RequestInit];
    return { fn: String(url).split("/rpc/")[1], body: JSON.parse(init.body as string) };
  };
  const store = () => new SupabaseStore("http://db.local", "key", "b");

  it("createWebLogin guarda solo el hash y devuelve el token solo si la persona sigue activa", async () => {
    const fetchMock = vi.fn(async () => rpc(true));
    vi.stubGlobal("fetch", fetchMock);
    const token = await store().createWebLogin("m1");
    const { fn, body } = call(fetchMock);
    expect(fn).toBe("papeleo_web_login_create");
    expect(body).toMatchObject({ p_member_id: "m1", p_minutes: 5 });
    expect(body.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(token!); // el token en claro no viaja a la base

    vi.stubGlobal("fetch", vi.fn(async () => rpc(false)));
    expect(await store().createWebLogin("m1")).toBeNull();
  });

  it("consumeLogin y session mandan hashes y devuelven la sesión y la empresa", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rpc([{ r_member_id: "m1", r_org_id: "o1" }]))
      .mockResolvedValueOnce(rpc([{ r_member_id: "m1", r_org_id: "o1", r_org_name: "Sol", r_member_name: "Ana" }]));
    vi.stubGlobal("fetch", fetchMock);
    const s = store();
    const sesion = await s.consumeLogin("TOKEN-DE-ENTRADA");
    const a = call(fetchMock, 0);
    expect(a.fn).toBe("papeleo_web_login_consume");
    expect(a.body).toMatchObject({ p_idle_minutes: 30 });
    expect(a.body.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.body.p_session_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a.body)).not.toContain(sesion!);

    expect(await s.session(sesion!)).toEqual({ memberId: "m1", orgId: "o1", orgName: "Sol", memberName: "Ana" });
    const b = call(fetchMock, 1);
    expect(b.fn).toBe("papeleo_web_session_touch");
    expect(b.body).toMatchObject({ p_idle_minutes: 30, p_max_hours: 8 });
  });

  it("un enlace o una sesión que la base no reconoce devuelven null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rpc([])));
    const s = store();
    expect(await s.consumeLogin("x")).toBeNull();
    expect(await s.session("x")).toBeNull();
  });

  it("list pide la página con desplazamiento, la empresa y los filtros, y devuelve el total", async () => {
    const fetchMock = vi.fn(async () => rpc([{ id: "e1", fecha: "2026-11-03", proveedor: "Éxito", nit: null, numero_factura: null, subtotal: null, iva: null, total: "45900.00", moneda: "COP", categoria: "otros", medio_pago: null, descripcion: null, confianza: "alta", total_filas: "60" }]));
    vi.stubGlobal("fetch", fetchMock);
    const r = await store().list("o1", { desde: "2026-11-01", proveedor: "Éxito" }, 3, 25);
    const { fn, body } = call(fetchMock);
    expect(fn).toBe("papeleo_panel_listar");
    expect(body).toMatchObject({ p_org_id: "o1", p_desde: "2026-11-01", p_proveedor: "Éxito", p_categoria: null, p_limite: 25, p_offset: 50 });
    expect(r.total).toBe(60);
    expect(r.rows[0]).toMatchObject({ id: "e1", total: 45900 });
    expect(r.rows[0]).not.toHaveProperty("total_filas");
  });

  it("endSession revoca por hash", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await store().endSession("SESION");
    const { fn, body } = call(fetchMock);
    expect(fn).toBe("papeleo_web_session_end");
    expect(body.p_session_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
