import { describe, expect, it, vi } from "vitest";
import { ClaudeExtractor, type Extraction } from "../src/extract.js";

const lectura: Extraction = {
  es_comprobante: true, tipo: "recibo", proveedor: "Conjunto", nit: null, numero_factura: null, fecha: "2026-04-16",
  subtotal: null, iva: null, total: 380000, moneda: "COP", medio_pago: "efectivo", categoria: "otros", descripcion: "Administración", confianza: "alta",
};

const fake = (response: object) => {
  const parse = vi.fn(async () => response);
  return { client: { messages: { parse } }, parse };
};

describe("ClaudeExtractor: consumo de tokens", () => {
  it("informa el modelo y los tokens, sumando los de caché a la entrada", async () => {
    const { client } = fake({
      stop_reason: "end_turn", parsed_output: lectura,
      usage: { input_tokens: 1500, cache_read_input_tokens: 400, cache_creation_input_tokens: 200, output_tokens: 850 },
    });
    const r = await new ClaudeExtractor("claude-opus-5-5", client).extract(Buffer.from("x"), "image/jpeg");
    expect(r.extraction).toEqual(lectura);
    expect(r.usage).toEqual({ model: "claude-opus-5-5", tokensIn: 2100, tokensOut: 850 });
  });

  it("si el modelo no termina, no hay lectura pero el consumo sí se informa", async () => {
    const { client } = fake({ stop_reason: "max_tokens", parsed_output: null, usage: { input_tokens: 1500, output_tokens: 16000 } });
    const r = await new ClaudeExtractor("m", client).extract(Buffer.from("x"), "application/pdf");
    expect(r.extraction).toBeNull();
    expect(r.usage).toEqual({ model: "m", tokensIn: 1500, tokensOut: 16000 });
  });

  it("tolera una respuesta sin uso", async () => {
    const { client } = fake({ stop_reason: "end_turn", parsed_output: lectura });
    expect((await new ClaudeExtractor("m", client).extract(Buffer.from("x"), "image/png")).usage).toEqual({ model: "m", tokensIn: 0, tokensOut: 0 });
  });

  it("manda la imagen o el PDF con el tipo correcto", async () => {
    const { client, parse } = fake({ stop_reason: "end_turn", parsed_output: lectura, usage: { input_tokens: 1, output_tokens: 1 } });
    const ex = new ClaudeExtractor("m", client);
    await ex.extract(Buffer.from("pdf"), "application/pdf");
    await ex.extract(Buffer.from("img"), "image/png");
    const kinds = parse.mock.calls.map((c: any[]) => c[0].messages[0].content[0].type);
    expect(kinds).toEqual(["document", "image"]);
  });
});
