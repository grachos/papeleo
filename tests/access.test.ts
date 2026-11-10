import { describe, expect, it, vi } from "vitest";
import { AttemptLimiter, extractCode, generateCode, hashCode, normalizeCode } from "../src/access.js";
import { handleMessage } from "../src/handler.js";
import type { Deps, IncomingMessage } from "../src/types.js";

describe("códigos de acceso", () => {
  it("genera XXXX-XXXX-XXXX sin caracteres ambiguos y distintos cada vez", () => {
    const codes = new Set(Array.from({ length: 200 }, generateCode));
    expect(codes.size).toBe(200);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(c).not.toMatch(/[ILO01]/);
      expect(normalizeCode(c)).not.toBeNull();
    }
  });

  it("normaliza mayúsculas, espacios y guiones, y rechaza lo que no parece código", () => {
    expect(normalizeCode("k7qd m3xp-9twb")).toBe("K7QDM3XP9TWB");
    expect(normalizeCode("hola, quiero mi resumen")).toBeNull();
    expect(normalizeCode("K7QD-M3XP-9TW")).toBeNull();
    expect(normalizeCode("K7QD-M3XP-9TW0")).toBeNull(); // 0 no existe en el alfabeto
  });

  it("extrae el código del enlace /start y del mensaje suelto", () => {
    expect(extractCode("/start K7QDM3XP9TWB")).toBe("K7QDM3XP9TWB");
    expect(extractCode("/start@papeleo_bot k7qd-m3xp-9twb")).toBe("K7QDM3XP9TWB");
    expect(extractCode("k7qd-m3xp-9twb")).toBe("K7QDM3XP9TWB");
    expect(extractCode("/start")).toBeNull();
    expect(extractCode("resumen")).toBeNull();
  });

  it("el hash es estable y no revela el código", () => {
    expect(hashCode("K7QDM3XP9TWB")).toBe(hashCode("K7QDM3XP9TWB"));
    expect(hashCode("K7QDM3XP9TWB")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode("K7QDM3XP9TWB")).not.toContain("K7QD");
  });
});

describe("AttemptLimiter", () => {
  it("bloquea tras el máximo de fallos y libera al pasar la ventana", () => {
    let t = 0;
    const l = new AttemptLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) {
      expect(l.allowed("a")).toBe(true);
      l.fail("a");
    }
    expect(l.allowed("a")).toBe(false);
    expect(l.allowed("b")).toBe(true);
    t = 1001;
    expect(l.allowed("a")).toBe(true);
  });

  it("reset borra los fallos", () => {
    const l = new AttemptLimiter(1, 1000);
    l.fail("a");
    l.reset("a");
    expect(l.allowed("a")).toBe(true);
  });
});

describe("acceso en el manejador", () => {
  const member = { id: "m1", org_id: "o1", phone: "tg:42", name: "Ana" };
  const org = { id: "o1", name: "Panadería Sol", sheet_id: null };
  const mk = () => ({ sendText: vi.fn(async () => {}), sendButtons: vi.fn(async () => {}), downloadMedia: vi.fn() });
  const msg = (over: Partial<IncomingMessage>): IncomingMessage => ({
    id: "tg:1", channel: "telegram", from: "tg:42", senderName: "Ana", kind: "text", text: "hola", ...over,
  });
  const setup = (redeem: "ok" | "fail" = "fail") => {
    const tg = mk();
    const store = {
      findMember: vi.fn(async () => null),
      redeemCode: vi.fn(async () => (redeem === "ok" ? { member, org } : null)),
      claimDocument: vi.fn(),
    };
    const limiter = new AttemptLimiter(2, 60_000);
    return { tg, store, limiter, deps: { wa: mk(), tg, store, limiter } as unknown as Deps };
  };

  it("ignora en silencio a quien no está vinculado: texto, fotos y botones", async () => {
    const { tg, store, deps } = setup();
    await handleMessage(msg({ text: "resumen" }), deps);
    await handleMessage(msg({ kind: "media", mediaId: "f", mimeType: "image/jpeg" }), deps);
    await handleMessage(msg({ kind: "button", buttonId: "descartar:e1" }), deps);
    expect(tg.sendText).not.toHaveBeenCalled();
    expect(tg.sendButtons).not.toHaveBeenCalled();
    expect(store.redeemCode).not.toHaveBeenCalled(); // texto sin forma de código: ni se consulta la base
    expect(store.claimDocument).not.toHaveBeenCalled();
  });

  it("un código válido vincula a la persona y le da la bienvenida", async () => {
    const { tg, store, deps } = setup("ok");
    await handleMessage(msg({ text: "/start K7QDM3XP9TWB" }), deps);
    expect(store.redeemCode).toHaveBeenCalledWith("K7QDM3XP9TWB", "tg:42", "Ana");
    expect(String(tg.sendText.mock.calls[0][1])).toContain("Panadería Sol");
  });

  it("un código inválido no recibe respuesta y tras el límite ya ni se consulta", async () => {
    const { tg, store, deps } = setup("fail");
    for (let i = 0; i < 5; i++) await handleMessage(msg({ text: "K7QD-M3XP-9TWB" }), deps);
    expect(tg.sendText).not.toHaveBeenCalled();
    expect(store.redeemCode).toHaveBeenCalledTimes(2); // límite de 2 intentos fallidos
  });

  it("quien ya está vinculado usa el bot normalmente", async () => {
    const { tg, store, deps } = setup();
    store.findMember.mockResolvedValue({ member, org } as never);
    (store as any).listExpenses = vi.fn(async () => []);
    await handleMessage(msg({ text: "resumen" }), { ...deps, today: () => "2026-11-09" } as Deps);
    expect(tg.sendText).toHaveBeenCalledOnce();
  });
});
