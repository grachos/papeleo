import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtractionSchema, type Extraction } from "../src/extract.js";
import { FallbackExtractor, LlamaParseExtractor, type ParseClient, type StructureClient } from "../src/extract-llamaparse.js";
import type { ExtractorPort } from "../src/types.js";

const CLAVE = `llx-${randomBytes(12).toString("hex")}`; // distinta en cada corrida

const lectura: Extraction = {
  es_comprobante: true, tipo: "recibo", proveedor: "Conjunto Residencial", nit: null, numero_factura: null, fecha: "2026-04-16",
  subtotal: null, iva: null, total: 380000, moneda: "COP", medio_pago: "efectivo", categoria: "otros",
  descripcion: "Administración abril", confianza: "alta", items: null,
};

function parseClient(pages: unknown[] = [{ success: true, page_number: 1, markdown: "# Conjunto\n| Total | 380.000 |" }], usage?: { credits: number | null }) {
  const parse = vi.fn(async (_p: Record<string, unknown>) => ({ markdown: { pages }, usage }));
  return { client: { parsing: { parse } } as unknown as ParseClient, parse };
}

function structureClient(res: Record<string, unknown> = { status: "completed", output_parsed: lectura, usage: { input_tokens: 1200, output_tokens: 300 } }) {
  const parse = vi.fn(async (_p: Record<string, unknown>) => {
    if (res instanceof Error) throw res;
    return res;
  });
  return { client: { responses: { parse } } as unknown as StructureClient, parse };
}

const opts = { tier: "cost_effective", model: "gpt-5.4-mini" };
const img = Buffer.from("imagen-de-prueba");

afterEach(() => vi.restoreAllMocks());

describe("LlamaParseExtractor: lectura en dos pasos", () => {
  it("sube el archivo a LlamaParse con su tipo y pide el markdown", async () => {
    const p = parseClient();
    await new LlamaParseExtractor(opts, p.client, structureClient().client).extract(img, "image/jpeg");
    const params = p.parse.mock.calls[0][0] as any;
    expect(params).toMatchObject({ tier: "cost_effective", version: "latest", expand: ["markdown", "usage"] });
    expect(params.upload_file).toBeInstanceOf(File);
    expect(params.upload_file.type).toBe("image/jpeg");
    expect(params.upload_file.size).toBe(img.length);
  });

  it("manda el texto (no el archivo) a OpenAI, con las instrucciones, el esquema y store:false", async () => {
    const s = structureClient();
    await new LlamaParseExtractor(opts, parseClient().client, s.client).extract(img, "image/jpeg");
    const p = s.parse.mock.calls[0][0] as any;
    expect(p).toMatchObject({ model: "gpt-5.4-mini", store: false, max_output_tokens: 4000 });
    expect(p.instructions).toContain("comprobantes de gasto");
    expect(p.input[0].content).toContain("# Conjunto");
    expect(p.text.format).toMatchObject({ type: "json_schema", name: "comprobante" });
    expect(JSON.stringify(p.input)).not.toContain(img.toString());
  });

  it("devuelve la lectura validada y los tokens de OpenAI, con el modelo y el nivel usados", async () => {
    const r = await new LlamaParseExtractor(opts, parseClient().client, structureClient().client).extract(img, "image/jpeg");
    expect(r.extraction).toEqual(lectura);
    expect(r.usage).toEqual({
      model: "llamaparse:cost_effective+gpt-5.4-mini",
      tokensIn: 1200,
      tokensOut: 300,
      llamaparsePages: 1,
      llamaparseCredits: null, // la facturación aún no lo registró
    });
  });

  it("informa las páginas y los créditos de LlamaParse, que cobra por página y no por tokens", async () => {
    const dos = [
      { success: true, page_number: 1, markdown: "# A" },
      { success: true, page_number: 2, markdown: "# B" },
    ];
    const r = await new LlamaParseExtractor(opts, parseClient(dos, { credits: 90 }).client, structureClient().client).extract(img, "application/pdf");
    expect(r.usage.llamaparsePages).toBe(2);
    expect(r.usage.llamaparseCredits).toBe(90);
  });

  it("ignora las páginas que LlamaParse no pudo leer", async () => {
    const s = structureClient();
    await new LlamaParseExtractor(opts, parseClient([
      { success: true, page_number: 1, markdown: "pagina buena" },
      { success: false, page_number: 2, error: "ilegible" },
    ]).client, s.client).extract(img, "application/pdf");
    expect(s.parse.mock.calls[0][0].input[0].content).toContain("pagina buena");
    expect(s.parse.mock.calls[0][0].input[0].content).not.toContain("ilegible");
  });

  it("sin texto legible no llama a OpenAI y devuelve «no reconocido» (sin error)", async () => {
    const s = structureClient();
    const r = await new LlamaParseExtractor(opts, parseClient([]).client, s.client).extract(img, "image/png");
    expect(r.extraction).toBeNull();
    expect(s.parse).not.toHaveBeenCalled();
  });

  it("acota el texto enviado para acotar el costo", async () => {
    const s = structureClient();
    await new LlamaParseExtractor(opts, parseClient([{ success: true, markdown: "x".repeat(60_000) }]).client, s.client).extract(img, "application/pdf");
    expect(s.parse.mock.calls[0][0].input[0].content.length).toBeLessThan(41_000);
  });

  it("si OpenAI no completa la respuesta, no hay lectura pero el consumo se informa", async () => {
    const r = await new LlamaParseExtractor(opts, parseClient().client, structureClient({ status: "incomplete", output_parsed: null, usage: { input_tokens: 900, output_tokens: 4000 } }).client)
      .extract(img, "image/jpeg");
    expect(r.extraction).toBeNull();
    expect(r.usage.tokensOut).toBe(4000);
  });

  it("una lectura que no cumple el esquema lanza error, para que el respaldo tome el relevo", async () => {
    const malo = { ...lectura, total: "380.000" } as unknown;
    await expect(new LlamaParseExtractor(opts, parseClient().client, structureClient({ status: "completed", output_parsed: malo, usage: {} }).client).extract(img, "image/jpeg"))
      .rejects.toThrow();
  });
});

describe("FallbackExtractor", () => {
  const ok = (model = "claude"): ExtractorPort => ({ extract: vi.fn(async () => ({ extraction: lectura, usage: { model, tokensIn: 1, tokensOut: 1 } })) });
  const roto = (err: unknown): ExtractorPort => ({ extract: vi.fn(async () => { throw err; }) });

  it("si la lectura principal funciona, no usa el respaldo", async () => {
    const respaldo = ok();
    const r = await new FallbackExtractor(ok("llamaparse"), respaldo).extract(img, "image/jpeg");
    expect(r.usage.model).toBe("llamaparse");
    expect(respaldo.extract).not.toHaveBeenCalled();
  });

  it("si la principal lanza error, usa el respaldo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await new FallbackExtractor(roto(new Error("timeout")), ok()).extract(img, "image/jpeg");
    expect(r.usage.model).toBe("claude");
    spy.mockRestore();
  });

  it("un comprobante sin texto no activa el respaldo (es una respuesta válida)", async () => {
    const respaldo = ok();
    const nulo: ExtractorPort = { extract: vi.fn(async () => ({ extraction: null, usage: { model: "llamaparse", tokensIn: 0, tokensOut: 0 } })) };
    const r = await new FallbackExtractor(nulo, respaldo).extract(img, "image/png");
    expect(r.extraction).toBeNull();
    expect(respaldo.extract).not.toHaveBeenCalled();
  });

  it("sin respaldo, el error se propaga; y el log solo registra el código de estado, nunca la clave", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error(`401 invalid key ${CLAVE}`), { status: 401 });
    await expect(new FallbackExtractor(roto(error), null).extract(img, "image/jpeg")).rejects.toThrow();
    expect(JSON.stringify(spy.mock.calls)).toContain("401");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(CLAVE);
  });
});

describe("esquema de lectura", () => {
  it("la lectura de ejemplo cumple el esquema exacto que usa el sistema", () => {
    expect(ExtractionSchema.parse(lectura)).toEqual(lectura);
  });
});
