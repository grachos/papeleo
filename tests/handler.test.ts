import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Extraction } from "../src/extract.js";
import { monthRange, summaryMessage } from "../src/format.js";
import { handleMessage } from "../src/handler.js";
import { parseSheetId } from "../src/sheets.js";
import type { Deps, Expense, IncomingMessage } from "../src/types.js";
import { parseWebhook, verifySignature } from "../src/whatsapp.js";

const member = { id: "m1", org_id: "o1", phone: "573001112233", name: "Ana" };
const org = { id: "o1", name: "Ana", sheet_id: null as string | null };

const extraction: Extraction = {
  es_comprobante: true,
  tipo: "tiquete_pos",
  proveedor: "Éxito",
  nit: "890900608-9",
  numero_factura: "A123",
  fecha: "2026-11-03",
  subtotal: 38571,
  iva: 7329,
  total: 45900,
  moneda: "COP",
  medio_pago: "tarjeta_debito",
  categoria: "mercado_hogar",
  descripcion: "Mercado",
  confianza: "alta",
};

function makeDeps(over: { extraction?: Extraction | null; sheetId?: string | null } = {}) {
  const saved: Expense[] = [];
  const deps = {
    wa: {
      sendText: vi.fn(async () => {}),
      sendButtons: vi.fn(async () => {}),
      downloadMedia: vi.fn(async () => ({ data: Buffer.from("img"), mimeType: "image/jpeg" })),
    },
    store: {
      findMember: vi.fn(async () => ({ member, org: { ...org, sheet_id: over.sheetId ?? null } })),
      redeemCode: vi.fn(async () => null),
      claimDocument: vi.fn(async () => "d1" as string | null),
      hashExists: vi.fn(async () => false),
      saveFile: vi.fn(async () => {}),
      finishDocument: vi.fn(async () => {}),
      saveExpense: vi.fn(async (_o: string, _m: string, _d: string, e: Omit<Expense, "id">) => {
        const row = { ...e, id: "e1" };
        saved.push(row);
        return row;
      }),
      discardExpense: vi.fn(async () => saved[0] ?? null),
      listExpenses: vi.fn(async () => saved),
      setSheet: vi.fn(async () => {}),
    },
    extractor: { extract: vi.fn(async () => (over.extraction === undefined ? extraction : over.extraction)) },
    sheets: { enabled: true, serviceAccountEmail: "bot@x.iam", appendExpense: vi.fn(async () => {}) },
    today: () => "2026-11-09",
  };
  return { deps: deps as unknown as Deps, mocks: deps, saved };
}

const photo: IncomingMessage = {
  id: "wamid.1",
  from: member.phone,
  senderName: "Ana",
  kind: "media",
  mediaId: "media1",
  mimeType: "image/jpeg",
};
const text = (body: string): IncomingMessage => ({ id: "wamid.t", from: member.phone, senderName: "Ana", kind: "text", text: body });

describe("handleMessage", () => {
  it("registra un gasto a partir de una foto y ofrece descartarlo", async () => {
    const { deps, mocks, saved } = makeDeps();
    await handleMessage(photo, deps);

    expect(saved[0]).toMatchObject({ total: 45900, fecha: "2026-11-03", categoria: "mercado_hogar" });
    expect(mocks.store.finishDocument).toHaveBeenCalledWith("d1", "procesado", extraction);
    const [to, body, buttons] = mocks.wa.sendButtons.mock.calls[0] as unknown as [string, string, { id: string }[]];
    expect(to).toBe(member.phone);
    expect(body).toContain("Éxito");
    expect(buttons[0].id).toBe("descartar:e1");
    expect(mocks.sheets.appendExpense).not.toHaveBeenCalled();
  });

  it("ignora el reintento del mismo mensaje de WhatsApp", async () => {
    const { deps, mocks } = makeDeps();
    mocks.store.claimDocument.mockResolvedValueOnce(null);
    await handleMessage(photo, deps);
    expect(mocks.wa.downloadMedia).not.toHaveBeenCalled();
    expect(mocks.store.saveExpense).not.toHaveBeenCalled();
  });

  it("no duplica un comprobante que ya se había enviado", async () => {
    const { deps, mocks } = makeDeps();
    mocks.store.hashExists.mockResolvedValueOnce(true);
    await handleMessage(photo, deps);
    expect(mocks.extractor.extract).not.toHaveBeenCalled();
    expect(mocks.store.finishDocument).toHaveBeenCalledWith("d1", "duplicado");
  });

  it("no registra gasto si la imagen no es un comprobante", async () => {
    const { deps, mocks } = makeDeps({ extraction: { ...extraction, es_comprobante: false, total: null } });
    await handleMessage(photo, deps);
    expect(mocks.store.saveExpense).not.toHaveBeenCalled();
    expect(mocks.store.finishDocument.mock.calls[0][1]).toBe("no_reconocido");
  });

  it("usa la fecha de hoy cuando el comprobante no trae fecha", async () => {
    const { deps, saved } = makeDeps({ extraction: { ...extraction, fecha: null } });
    await handleMessage(photo, deps);
    expect(saved[0].fecha).toBe("2026-11-09");
  });

  it("copia el gasto a la hoja de Google y avisa si falla sin perder el registro", async () => {
    const { deps, mocks, saved } = makeDeps({ sheetId: "sheet123" });
    mocks.sheets.appendExpense.mockRejectedValueOnce(new Error("403"));
    await handleMessage(photo, deps);
    expect(saved).toHaveLength(1);
    expect((mocks.wa.sendButtons.mock.calls[0] as unknown as string[])[1]).toContain("no pude copiarlo");
  });

  it("avisa al usuario si la lectura falla", async () => {
    const { deps, mocks } = makeDeps();
    mocks.extractor.extract.mockRejectedValueOnce(new Error("timeout"));
    await handleMessage(photo, deps);
    expect(mocks.store.finishDocument).toHaveBeenCalledWith("d1", "error");
    expect(mocks.wa.sendText).toHaveBeenCalledOnce();
  });

  it("rechaza tipos de archivo no soportados sin descargarlos", async () => {
    const { deps, mocks } = makeDeps();
    await handleMessage({ ...photo, mimeType: "application/zip" }, deps);
    expect(mocks.store.claimDocument).not.toHaveBeenCalled();
  });

  it("responde el resumen del mes en curso", async () => {
    const { deps, mocks } = makeDeps();
    await handleMessage(text(" Resumen "), deps);
    expect(mocks.store.listExpenses).toHaveBeenCalledWith("o1", "2026-11-01", "2026-11-30");
  });

  it("descarta por botón solo el gasto indicado y del propio miembro", async () => {
    const { deps, mocks } = makeDeps();
    await handleMessage({ ...photo, kind: "button", buttonId: "descartar:e9" }, deps);
    expect(mocks.store.discardExpense).toHaveBeenCalledWith("m1", "e9");
  });

  it("vincula una hoja de Google a la organización", async () => {
    const { deps, mocks } = makeDeps();
    await handleMessage(text("hoja https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit"), deps);
    expect(mocks.store.setSheet).toHaveBeenCalledWith("o1", "1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  });
});

describe("utilidades", () => {
  it("valida la firma del webhook", () => {
    const body = Buffer.from('{"a":1}');
    const good = "sha256=" + createHmac("sha256", "secreto").update(body).digest("hex");
    expect(verifySignature(body, good, "secreto")).toBe(true);
    expect(verifySignature(body, good, "otro")).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), good, "secreto")).toBe(false);
    expect(verifySignature(body, undefined, "secreto")).toBe(false);
    expect(verifySignature(body, "sha256=zz", "secreto")).toBe(false);
  });

  it("normaliza los mensajes del webhook", () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "57300", profile: { name: "Ana" } }],
                messages: [
                  { id: "1", from: "57300", type: "image", image: { id: "m1", mime_type: "image/jpeg" } },
                  { id: "2", from: "57300", type: "text", text: { body: "resumen" } },
                  { id: "3", from: "57300", type: "interactive", interactive: { button_reply: { id: "descartar:e1" } } },
                  { id: "4", from: "57300", type: "audio" },
                ],
              },
            },
            { value: { statuses: [{ id: "x" }] } },
          ],
        },
      ],
    };
    const msgs = parseWebhook(body);
    expect(msgs.map((m) => m.kind)).toEqual(["media", "text", "button", "other"]);
    expect(msgs[0]).toMatchObject({ mediaId: "m1", senderName: "Ana" });
    expect(parseWebhook({})).toEqual([]);
  });

  it("calcula el rango del mes, incluido febrero bisiesto", () => {
    expect(monthRange("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("resume por categoría de mayor a menor", () => {
    const e = (categoria: string, total: number) => ({ categoria, total }) as Expense;
    const out = summaryMessage([e("transporte", 10000), e("alimentacion", 30000), e("transporte", 5000)], "2026-11");
    expect(out.indexOf("alimentacion")).toBeLessThan(out.indexOf("transporte"));
    expect(out).toMatch(/45\.000/);
  });

  it("extrae el id de una URL de Google Sheets", () => {
    expect(parseSheetId("hoja nada")).toBeNull();
    expect(parseSheetId("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    );
  });
});
