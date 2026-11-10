import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { handleMessage } from "../src/handler.js";
import { callbackQueryId, chunkText, parseTelegramUpdate, TelegramClient, verifySecret } from "../src/telegram.js";
import type { Deps, IncomingMessage } from "../src/types.js";

const from = { id: 42, is_bot: false, first_name: "Ana", last_name: "Pérez" };
const chat = { id: 42, type: "private" };
const upd = (message: object, update_id = 100) => ({ update_id, message: { message_id: 7, from, chat, ...message } });

describe("parseTelegramUpdate", () => {
  it("lee texto con el nombre completo y usa update_id como id", () => {
    expect(parseTelegramUpdate(upd({ text: "resumen" }))).toEqual({
      id: "tg:100",
      channel: "telegram",
      from: "tg:42",
      senderName: "Ana Pérez",
      kind: "text",
      text: "resumen",
    });
  });

  it("toma la foto de mayor tamaño (la última)", () => {
    const m = parseTelegramUpdate(upd({ photo: [{ file_id: "small" }, { file_id: "mid" }, { file_id: "big" }] }));
    expect(m).toMatchObject({ kind: "media", mediaId: "big", mimeType: "image/jpeg" });
  });

  it("lee documentos (PDF) con su mime", () => {
    const m = parseTelegramUpdate(upd({ document: { file_id: "d1", mime_type: "application/pdf" } }));
    expect(m).toMatchObject({ kind: "media", mediaId: "d1", mimeType: "application/pdf" });
  });

  it("convierte un callback_query en botón", () => {
    const update = { update_id: 101, callback_query: { id: "cb1", from, data: "descartar:e1", message: { chat } } };
    expect(parseTelegramUpdate(update)).toMatchObject({ id: "tg:101", kind: "button", buttonId: "descartar:e1", from: "tg:42" });
    expect(callbackQueryId(update)).toBe("cb1");
  });

  it("ignora bots, grupos, ediciones, canales y basura", () => {
    expect(parseTelegramUpdate(upd({ text: "x", from: { ...from, is_bot: true } }))).toBeNull();
    expect(parseTelegramUpdate(upd({ text: "x", chat: { id: -5, type: "group" } }))).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, edited_message: { text: "x", from, chat } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, channel_post: { text: "x", chat } })).toBeNull();
    expect(parseTelegramUpdate({})).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
  });

  it("marca como other lo que no es texto ni archivo", () => {
    expect(parseTelegramUpdate(upd({ sticker: {} }))?.kind).toBe("other");
  });
});

describe("verifySecret", () => {
  it("acepta solo el secreto exacto", () => {
    expect(verifySecret("abc_123", "abc_123")).toBe(true);
    expect(verifySecret("abc_124", "abc_123")).toBe(false);
    expect(verifySecret("", "abc_123")).toBe(false);
    expect(verifySecret(undefined, "abc_123")).toBe(false);
  });
});

describe("chunkText", () => {
  it("parte por líneas respetando el máximo", () => {
    const long = Array.from({ length: 50 }, (_, i) => `línea ${i} con texto`).join("\n");
    const parts = chunkText(long, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join("\n")).toBe(long);
  });
});

describe("TelegramClient", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = (result: unknown = true) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  it("envía botones como teclado en línea, al chat sin prefijo y sin asteriscos", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramClient("TOKEN").sendButtons("tg:42", "*Registrado* total $5", [{ id: "descartar:e1", title: "Descartar" }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "42",
      text: "Registrado total $5",
      reply_markup: { inline_keyboard: [[{ text: "Descartar", callback_data: "descartar:e1" }]] },
    });
  });

  it("descarga en dos pasos (getFile y luego el archivo) y deduce el tipo por la extensión", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ file_path: "documents/file_9.pdf" }))
      .mockResolvedValueOnce(new Response("%PDF", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { data, mimeType } = await new TelegramClient("TOKEN").downloadMedia("fid");
    expect(mimeType).toBe("application/pdf");
    expect(data.toString()).toBe("%PDF");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.telegram.org/file/botTOKEN/documents/file_9.pdf");
  });

  it("los errores no incluyen el token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })));
    const err = await new TelegramClient("SECRET_TOKEN").sendText("tg:42", "hola").catch((e) => e as Error);
    expect(err.message).toContain("chat not found");
    expect(err.message).not.toContain("SECRET_TOKEN");
  });

  it("registra el webhook con secreto y solo los updates necesarios", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramClient("TOKEN").setWebhook("https://x.onrender.com/telegram/webhook", "sec_1");
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      url: "https://x.onrender.com/telegram/webhook",
      secret_token: "sec_1",
      allowed_updates: ["message", "callback_query"],
    });
  });
});

describe("loadConfig", () => {
  const base = { SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" };
  const withEnv = (env: Record<string, string>) => {
    vi.unstubAllEnvs();
    for (const k of ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_IDS"]) {
      vi.stubEnv(k, "");
    }
    for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
    return loadConfig();
  };
  afterEach(() => vi.unstubAllEnvs());

  it("arranca solo con Telegram y lee los ids autorizados", () => {
    const c = withEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "sec_1", TELEGRAM_ALLOWED_IDS: "42, 77" });
    expect(c.whatsapp).toBeNull();
    expect(c.telegram?.allowedIds).toEqual(["42", "77"]);
  });

  it("exige al menos un canal y un secreto válido", () => {
    expect(() => withEnv({})).toThrow("al menos un canal");
    expect(() => withEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "con espacios!" })).toThrow("TELEGRAM_WEBHOOK_SECRET");
    expect(() => withEnv({ TELEGRAM_BOT_TOKEN: "t" })).toThrow("TELEGRAM_WEBHOOK_SECRET");
  });
});

describe("handleMessage por canal", () => {
  const member = { id: "m1", org_id: "o1", phone: "tg:42", name: "Ana" };
  const org = { id: "o1", name: "Ana", sheet_id: null };
  const mk = () => ({ sendText: vi.fn(async () => {}), sendButtons: vi.fn(async () => {}), downloadMedia: vi.fn() });
  const store = {
    findOrCreateMember: vi.fn(async () => ({ member, org, isNew: false })),
    listExpenses: vi.fn(async () => []),
  };
  const msg = (text: string): IncomingMessage => ({ id: "tg:1", channel: "telegram", from: "tg:42", senderName: "Ana", kind: "text", text });

  it("responde por Telegram y entiende /comandos", async () => {
    const wa = mk();
    const tg = mk();
    await handleMessage(msg("/resumen@papeleo_bot"), { wa, tg, store, today: () => "2026-11-09" } as unknown as Deps);
    expect(tg.sendText).toHaveBeenCalledOnce();
    expect(String(tg.sendText.mock.calls[0][1])).not.toContain("Envíame la"); // fue «resumen», no la ayuda
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it("falla con claridad si Telegram no está configurado", async () => {
    await expect(handleMessage(msg("hola"), { wa: mk(), store } as unknown as Deps)).rejects.toThrow("Telegram");
  });
});
