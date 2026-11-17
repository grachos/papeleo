import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { construirExcel, neutralizar, parseExportArgs } from "../src/export.js";
import { TelegramClient } from "../src/telegram.js";
import type { Expense } from "../src/types.js";

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: "e1",
  fecha: "2026-01-05",
  proveedor: "Éxito",
  nit: "890900608-9",
  numero_factura: "A123",
  subtotal: 1000,
  iva: 190,
  total: 1190,
  moneda: "COP",
  categoria: "mercado_hogar",
  medio_pago: "tarjeta_debito",
  descripcion: "Mercado",
  confianza: "alta",
  ...over,
});

describe("parseExportArgs", () => {
  it("sin filtros exporta todo", () => {
    const r = parseExportArgs("excel");
    expect(r).toEqual({ ok: true, filters: {}, descripcion: "de todo el registro" });
  });

  it("mes completo se convierte en su primer y último día", () => {
    const r = parseExportArgs("excel mes 2026-02");
    expect(r.ok && r.filters).toEqual({ desde: "2026-02-01", hasta: "2026-02-28" });
  });

  it("acepta desde y hasta, con rubro y proveedor de varias palabras", () => {
    const r = parseExportArgs("/excel@mi_bot desde 2026-01-01 hasta 2026-03-31 rubro Mercado hogar proveedor Éxito Norte");
    expect(r).toMatchObject({
      ok: true,
      filters: { desde: "2026-01-01", hasta: "2026-03-31", categoria: "mercado_hogar", proveedor: "Éxito Norte" },
    });
  });

  it("rechaza un rubro que no existe y lista los válidos", () => {
    const r = parseExportArgs("excel rubro chucherias");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain("mercado_hogar");
  });

  it("no permite mes junto con desde o hasta", () => {
    expect(parseExportArgs("excel mes 2026-01 desde 2026-01-01").ok).toBe(false);
  });

  it("rechaza fechas inexistentes y rangos al revés", () => {
    expect(parseExportArgs("excel desde 2026-02-30").ok).toBe(false);
    expect(parseExportArgs("excel desde 2026-03-01 hasta 2026-02-01").ok).toBe(false);
    expect(parseExportArgs("excel mes 2026-13").ok).toBe(false);
  });

  it("rechaza texto suelto antes de un filtro y filtros vacíos", () => {
    expect(parseExportArgs("excel enero").ok).toBe(false);
    expect(parseExportArgs("excel rubro").ok).toBe(false);
  });

  it("limita el largo del proveedor", () => {
    expect(parseExportArgs(`excel proveedor ${"x".repeat(61)}`).ok).toBe(false);
  });
});

describe("neutralizar", () => {
  it("antepone comilla a los textos que Excel leería como fórmula", () => {
    expect(neutralizar('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(neutralizar("+1")).toBe("'+1");
    expect(neutralizar("-cmd")).toBe("'-cmd");
    expect(neutralizar("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("no toca el texto normal", () => {
    expect(neutralizar("Éxito")).toBe("Éxito");
    expect(neutralizar("")).toBe("");
  });
});

describe("construirExcel", () => {
  it("genera hojas de facturas y renglones, con fechas, cifras y revisión de cuadre", async () => {
    const rows = [
      expense({ id: "e1", proveedor: "=cmd|' /C calc'!A0" }),
      expense({ id: "e2", fecha: "2026-01-09", proveedor: "Tienda", total: 5000, subtotal: 4000 }),
    ];
    const items = new Map([
      ["e1", [{ descripcion: "Arroz", cantidad: 2, valor_unitario: 500, valor_linea: 1000 }]],
      ["e2", [{ descripcion: "Pan", cantidad: 1, valor_unitario: 3000, valor_linea: 3000 }]],
    ]);

    const buf = await construirExcel(rows, items);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const facturas = wb.getWorksheet("Facturas")!;
    expect(facturas.rowCount).toBe(3); // encabezado + 2 facturas
    expect(facturas.getCell("B2").value).toBe("'=cmd|' /C calc'!A0"); // neutralizada
    expect(facturas.getCell("A2").value).toEqual(new Date("2026-01-05T12:00:00Z"));
    expect(facturas.getCell("J2").value).toBe(1190);
    expect(facturas.getCell("M2").value).toBe("no"); // renglones (1000) cuadran con el subtotal (1000)
    expect(facturas.getCell("M3").value).toBe("sí"); // renglones (3000) no cuadran con subtotal (4000) ni total (5000)

    const renglones = wb.getWorksheet("Renglones")!;
    expect(renglones.rowCount).toBe(3);
    expect(renglones.getCell("D2").value).toBe("Arroz");
    expect(renglones.getCell("G3").value).toBe(3000);
  });

  it("sin renglones guardados no marca la factura para revisar", async () => {
    const buf = await construirExcel([expense()], new Map());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.getWorksheet("Facturas")!.getCell("M2").value).toBe("no");
    expect(wb.getWorksheet("Renglones")!.rowCount).toBe(1); // solo encabezado
  });
});

describe("TelegramClient.sendFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("envía el archivo como documento al chat y no incluye el token en el error", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("123:SECRETO");
    await client.sendFile("tg:42", { name: "papeleo.xlsx", mime: "application/x", data: Buffer.from("x") }, "Listo");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/sendDocument");
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("42");
    expect(form.get("caption")).toBe("Listo");
    expect(form.get("document")).toBeInstanceOf(Blob);
  });

  it("si Telegram responde con error, lo informa sin el token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "bad" }), { status: 400 })));
    const client = new TelegramClient("123:SECRETO");
    const err = await client
      .sendFile("tg:42", { name: "a.xlsx", mime: "application/x", data: Buffer.from("x") }, "")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("SECRETO");
  });
});
