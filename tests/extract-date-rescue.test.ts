import { describe, expect, it, vi } from "vitest";
import { DateRescueExtractor, OpenAIDateReader, type DateReader } from "../src/extract-date-rescue.js";
import type { Extraction } from "../src/extract.js";
import type { ExtractionResult, ExtractorPort } from "../src/types.js";

const HOY = "2026-11-19";
const img = Buffer.from("imagen");

const lectura = (over: Partial<Extraction> = {}): Extraction => ({
  es_comprobante: true,
  tipo: "cuenta_cobro",
  proveedor: "Feztelicaudi",
  nit: null,
  numero_factura: "181136",
  fecha: null,
  subtotal: 33000,
  iva: null,
  total: 33000,
  moneda: "COP",
  medio_pago: null,
  categoria: "papeleria_oficina",
  descripcion: "Papel térmico",
  confianza: "alta",
  items: null,
  ...over,
});

const primario = (e: Extraction | null): { port: ExtractorPort; extract: ReturnType<typeof vi.fn> } => {
  const extract = vi.fn(async (): Promise<ExtractionResult> => ({ extraction: e, usage: { model: "llamaparse+gpt", tokensIn: 1200, tokensOut: 100 } }));
  return { port: { extract } as unknown as ExtractorPort, extract };
};

const lector = (fecha: string | null, fail = false) => {
  const readDate = vi.fn(async () => {
    if (fail) throw Object.assign(new Error("boom"), { status: 500 });
    return { fecha, tokensIn: 800, tokensOut: 20 };
  });
  return { reader: { readDate } as DateReader, readDate };
};

describe("DateRescueExtractor", () => {
  it("lee la fecha de la imagen y descarta el «número» que eran los dígitos de la fecha", async () => {
    const { reader, readDate } = lector("2026-11-18");
    const r = await new DateRescueExtractor(primario(lectura()).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDate).toHaveBeenCalledWith(img, "image/jpeg", HOY);
    expect(r.extraction?.fecha).toBe("2026-11-18");
    expect(r.extraction?.numero_factura).toBeNull(); // «181136» empieza por 18 11: era la fecha
    expect(r.usage.tokensIn).toBe(2000); // suma el consumo de la segunda lectura
    expect(r.usage.tokensOut).toBe(120);
  });

  it("conserva un número de factura que no tiene nada que ver con la fecha", async () => {
    const { reader } = lector("2026-11-18");
    const r = await new DateRescueExtractor(primario(lectura({ numero_factura: "202443" })).port, reader, () => HOY).extract(img, "image/png");
    expect(r.extraction?.fecha).toBe("2026-11-18");
    expect(r.extraction?.numero_factura).toBe("202443");
  });

  it("no llama a la visión si la lectura ya trae fecha válida", async () => {
    const { reader, readDate } = lector("2026-01-01");
    const r = await new DateRescueExtractor(primario(lectura({ fecha: "2026-11-10" })).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDate).not.toHaveBeenCalled();
    expect(r.extraction?.fecha).toBe("2026-11-10");
  });

  it("no lo intenta con PDF ni cuando no es comprobante ni cuando no hubo lectura", async () => {
    const { reader, readDate } = lector("2026-11-18");
    await new DateRescueExtractor(primario(lectura()).port, reader, () => HOY).extract(img, "application/pdf");
    await new DateRescueExtractor(primario(lectura({ es_comprobante: false })).port, reader, () => HOY).extract(img, "image/jpeg");
    await new DateRescueExtractor(primario(null).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDate).not.toHaveBeenCalled();
  });

  it("rechaza una fecha futura, inválida o demasiado vieja: queda sin fecha (el bot pregunta)", async () => {
    for (const f of ["2036-11-18", "2026-02-30", "2019-05-01", "ayer", null]) {
      const { reader } = lector(f);
      const r = await new DateRescueExtractor(primario(lectura()).port, reader, () => HOY).extract(img, "image/jpeg");
      expect(r.extraction?.fecha).toBeNull();
      expect(r.extraction?.numero_factura).toBe("181136"); // sin fecha confirmada no se toca el número
    }
  });

  it("si la visión falla, devuelve la lectura original sin romper el flujo", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reader } = lector(null, true);
    const original = lectura();
    const r = await new DateRescueExtractor(primario(original).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(r.extraction).toEqual(original);
    expect(err).toHaveBeenCalledWith("Fallo la lectura de la fecha en la imagen", 500);
    err.mockRestore();
  });
});

describe("OpenAIDateReader", () => {
  const cliente = (res: Record<string, unknown>) => {
    const parse = vi.fn(async (_p: Record<string, unknown>) => res);
    return { client: { responses: { parse } }, parse };
  };

  it("manda la imagen en base64, sin guardar en OpenAI, y devuelve la fecha", async () => {
    const { client, parse } = cliente({ status: "completed", output_parsed: { fecha: "2026-11-18" }, usage: { input_tokens: 700, output_tokens: 12 } });
    const r = await new OpenAIDateReader("gpt-x", client).readDate(img, "image/jpeg", HOY);
    expect(r).toEqual({ fecha: "2026-11-18", tokensIn: 700, tokensOut: 12 });
    const params = parse.mock.calls[0][0] as { store: boolean; input: { content: { type: string; image_url?: string }[] }[] };
    expect(params.store).toBe(false);
    const imagen = params.input[0].content.find((c) => c.type === "input_image");
    expect(imagen?.image_url).toBe(`data:image/jpeg;base64,${img.toString("base64")}`);
  });

  it("una respuesta incompleta no da fecha, pero informa el consumo", async () => {
    const { client } = cliente({ status: "incomplete", output_parsed: null, usage: { input_tokens: 650, output_tokens: 500 } });
    expect(await new OpenAIDateReader("gpt-x", client).readDate(img, "image/png", HOY)).toEqual({ fecha: null, tokensIn: 650, tokensOut: 500 });
  });
});
