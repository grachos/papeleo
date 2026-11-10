import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import { chunkText, InstagramClient, isAllowedMediaUrl, parseInstagramWebhook } from "../src/instagram.js";
import type { Deps, IncomingMessage } from "../src/types.js";

const body = (messaging: object[]) => ({ object: "instagram", entry: [{ id: "IGPAGE", messaging }] });
const ev = (message: object, sender = "U1") => ({ sender: { id: sender }, recipient: { id: "IGPAGE" }, message });

describe("parseInstagramWebhook", () => {
  it("lee texto, imagen y respuesta rápida con el prefijo ig:", () => {
    const msgs = parseInstagramWebhook(
      body([
        ev({ mid: "m1", text: "resumen" }),
        ev({ mid: "m2", attachments: [{ type: "image", payload: { url: "https://scontent.cdninstagram.com/a.jpg" } }] }),
        ev({ mid: "m3", text: "Descartar", quick_reply: { payload: "descartar:e1" } }),
      ]),
    );
    expect(msgs).toEqual([
      { id: "m1", channel: "instagram", from: "ig:U1", senderName: null, kind: "text", text: "resumen" },
      {
        id: "m2",
        channel: "instagram",
        from: "ig:U1",
        senderName: null,
        kind: "media",
        mediaId: "https://scontent.cdninstagram.com/a.jpg",
        mimeType: "image/jpeg",
      },
      { id: "m3", channel: "instagram", from: "ig:U1", senderName: null, kind: "button", buttonId: "descartar:e1" },
    ]);
  });

  it("ignora ecos propios, mensajes de la misma cuenta y eventos sin mensaje", () => {
    const msgs = parseInstagramWebhook(
      body([
        ev({ mid: "e1", text: "hola", is_echo: true }),
        ev({ mid: "e2", text: "hola" }, "IGPAGE"),
        { sender: { id: "U1" }, recipient: { id: "IGPAGE" }, read: { mid: "x" } },
      ]),
    );
    expect(msgs).toEqual([]);
  });

  it("marca como other los adjuntos que no son imagen", () => {
    const [m] = parseInstagramWebhook(
      body([ev({ mid: "m4", attachments: [{ type: "audio", payload: { url: "https://x.fbcdn.net/a" } }] })]),
    );
    expect(m.kind).toBe("other");
  });
});

describe("chunkText", () => {
  it("no parte textos cortos y respeta el máximo en los largos", () => {
    expect(chunkText("hola")).toEqual(["hola"]);
    const long = Array.from({ length: 60 }, (_, i) => `línea número ${i} con algo de texto`).join("\n");
    const parts = chunkText(long, 200);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join("\n")).toBe(long);
  });

  it("parte una línea sin saltos que supera el máximo", () => {
    const parts = chunkText("x".repeat(250), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
  });
});

describe("isAllowedMediaUrl", () => {
  it("solo acepta https hacia los CDN de Meta", () => {
    expect(isAllowedMediaUrl("https://scontent-bog1-1.xx.fbcdn.net/v/a.jpg")).toBe(true);
    expect(isAllowedMediaUrl("https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1")).toBe(true);
    expect(isAllowedMediaUrl("http://scontent.cdninstagram.com/a.jpg")).toBe(false);
    expect(isAllowedMediaUrl("https://evil.com/fbcdn.net")).toBe(false);
    expect(isAllowedMediaUrl("https://fbcdn.net.evil.com/a")).toBe(false);
    expect(isAllowedMediaUrl("http://169.254.169.254/latest")).toBe(false);
    expect(isAllowedMediaUrl("no es url")).toBe(false);
  });
});

describe("InstagramClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("envía respuestas rápidas al id sin prefijo y recorta el título", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new InstagramClient({ accessToken: "tok", graphVersion: "v21.0" });

    await client.sendButtons("ig:U1", "Registrado", [{ id: "descartar:e1", title: "Descartar este gasto ahora" }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.instagram.com/v21.0/me/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { id: "U1" },
      message: {
        text: "Registrado",
        quick_replies: [{ content_type: "text", title: "Descartar este gasto", payload: "descartar:e1" }],
      },
    });
  });

  it("rechaza descargar adjuntos de hosts no permitidos y falla si Instagram responde error", async () => {
    const client = new InstagramClient({ accessToken: "tok", graphVersion: "v21.0" });
    await expect(client.downloadMedia("https://evil.com/a.jpg")).rejects.toThrow("no permitida");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    await expect(client.sendText("ig:U1", "hola")).rejects.toThrow("Instagram respondió 400");
  });
});

describe("handleMessage por canal", () => {
  const member = { id: "m1", org_id: "o1", phone: "ig:U1", name: null };
  const org = { id: "o1", name: "ig:U1", sheet_id: null };
  const mk = () => ({ sendText: vi.fn(async () => {}), sendButtons: vi.fn(async () => {}), downloadMedia: vi.fn() });
  const store = {
    findOrCreateMember: vi.fn(async () => ({ member, org, isNew: false })),
    listExpenses: vi.fn(async () => []),
  };
  const msg: IncomingMessage = { id: "m1", channel: "instagram", from: "ig:U1", senderName: null, kind: "text", text: "hola" };

  it("responde por Instagram a los mensajes de Instagram", async () => {
    const wa = mk();
    const ig = mk();
    await handleMessage(msg, { wa, ig, store } as unknown as Deps);
    expect(ig.sendText).toHaveBeenCalledOnce();
    expect(ig.sendText.mock.calls[0]).toContain("ig:U1");
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it("falla con claridad si Instagram no está configurado", async () => {
    await expect(handleMessage(msg, { wa: mk(), store } as unknown as Deps)).rejects.toThrow("Instagram");
  });
});
