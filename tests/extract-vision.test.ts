import { describe, expect, it, vi } from "vitest";
import { OpenAIVisionReader, sinEcoDeFecha, VisionRescueExtractor, type VisionReader } from "../src/extract-vision.js";
import type { Extraction } from "../src/extract.js";
import type { ExtractionResult, ExtractorPort } from "../src/types.js";

const HOY = "2026-11-19";
const img = Buffer.from("imagen");

// Lo que entregó el OCR de la cuenta de cobro manuscrita (valores reales de la prueba del 2026-11-18).
const ocr = (over: Partial<Extraction> = {}): Extraction => ({
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
  descripcion: "Papel de impresión térmico",
  confianza: "alta",
  items: [{ cantidad: 6, descripcion: "Papel de Impresión Termico 80x60 a", valor_unitario: 5500, valor_linea: 33000 }],
  ...over,
});

// Lo que lee el modelo de visión sobre la imagen.
const vision = (over: Partial<Extraction> = {}): Extraction => ({
  ...ocr(),
  proveedor: "Fertilicandi",
  numero_factura: null,
  fecha: "2026-11-18",
  descripcion: "Rollos de impresora térmica",
  items: [{ cantidad: 6, descripcion: "Rollo de Impresora Térmica 80x60", valor_unitario: 5500, valor_linea: 33000 }],
  ...over,
});

const primario = (e: Extraction | null) => {
  const extract = vi.fn(async (): Promise<ExtractionResult> => ({ extraction: e, usage: { model: "llamaparse+gpt", tokensIn: 1200, tokensOut: 100 } }));
  return { port: { extract } as unknown as ExtractorPort, extract };
};

const lector = (e: Extraction | null, fail = false) => {
  const readDocument = vi.fn(async () => {
    if (fail) throw Object.assign(new Error("boom"), { status: 500 });
    return { extraction: e, tokensIn: 800, tokensOut: 150 };
  });
  return { reader: { readDocument } as VisionReader, readDocument };
};

describe("VisionRescueExtractor", () => {
  it("en una cuenta de cobro manuscrita manda la imagen: detalle, proveedor y fecha, y descarta el número que era la fecha", async () => {
    const { reader, readDocument } = lector(vision());
    const r = await new VisionRescueExtractor(primario(ocr()).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDocument).toHaveBeenCalledWith(img, "image/jpeg", HOY);
    expect(r.extraction?.fecha).toBe("2026-11-18");
    expect(r.extraction?.items?.[0].descripcion).toBe("Rollo de Impresora Térmica 80x60");
    expect(r.extraction?.proveedor).toBe("Fertilicandi");
    expect(r.extraction?.numero_factura).toBeNull(); // «181136» eran los dígitos de la fecha
    expect(r.extraction?.total).toBe(33000); // los valores en pesos se conservan de la primera lectura
    expect(r.usage.tokensIn).toBe(2000);
    expect(r.usage.tokensOut).toBe(250);
    expect(r.usage.visionTokensIn).toBe(800); // la parte del total que fue la lectura de la imagen
    expect(r.usage.visionTokensOut).toBe(150);
  });

  it("en un tiquete impreso sin fecha solo completa la fecha: no cambia lo que el OCR leyó bien", async () => {
    const texto = ocr({ tipo: "tiquete_pos", proveedor: "JUMBO", numero_factura: "202443" });
    const { reader } = lector(vision({ tipo: "tiquete_pos", proveedor: "OTRO", numero_factura: "999", fecha: "2026-11-17", items: null }));
    const r = await new VisionRescueExtractor(primario(texto).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(r.extraction?.fecha).toBe("2026-11-17");
    expect(r.extraction?.proveedor).toBe("JUMBO");
    expect(r.extraction?.numero_factura).toBe("202443");
    expect(r.extraction?.items).toEqual(texto.items); // la imagen no trae renglones: quedan los del OCR
  });

  it("si el OCR no trae renglones, los toma de la imagen", async () => {
    const texto = ocr({ tipo: "tiquete_pos", items: null });
    const { reader } = lector(vision({ tipo: "tiquete_pos" }));
    const r = await new VisionRescueExtractor(primario(texto).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(r.extraction?.items?.[0].descripcion).toBe("Rollo de Impresora Térmica 80x60");
  });

  it("no llama a la visión en un comprobante impreso que ya trae fecha", async () => {
    const { reader, readDocument } = lector(vision());
    const r = await new VisionRescueExtractor(primario(ocr({ tipo: "tiquete_pos", fecha: "2026-11-10" })).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDocument).not.toHaveBeenCalled();
    expect(r.extraction?.fecha).toBe("2026-11-10");
  });

  it("un recibo manuscrito con fecha igual se lee con visión (la letra a mano es lo que el OCR hace mal)", async () => {
    const { reader, readDocument } = lector(vision({ tipo: "recibo" }));
    await new VisionRescueExtractor(primario(ocr({ tipo: "recibo", fecha: "2026-11-10" })).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDocument).toHaveBeenCalledOnce();
  });

  it("no lo intenta con PDF, ni si no es comprobante, ni si no hubo lectura", async () => {
    const { reader, readDocument } = lector(vision());
    await new VisionRescueExtractor(primario(ocr()).port, reader, () => HOY).extract(img, "application/pdf");
    await new VisionRescueExtractor(primario(ocr({ es_comprobante: false })).port, reader, () => HOY).extract(img, "image/jpeg");
    await new VisionRescueExtractor(primario(null).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("rechaza una fecha futura, inválida o demasiado vieja: queda sin fecha (el bot pregunta) y sin tocar el número", async () => {
    for (const f of ["2036-11-18", "2026-02-30", "2019-05-01", "ayer", null]) {
      const { reader } = lector(vision({ fecha: f }));
      const r = await new VisionRescueExtractor(primario(ocr({ tipo: "tiquete_pos" })).port, reader, () => HOY).extract(img, "image/jpeg");
      expect(r.extraction?.fecha).toBeNull();
      expect(r.extraction?.numero_factura).toBe("181136");
    }
  });

  it("si la imagen no se lee o no es comprobante, deja la lectura original (con el consumo sumado)", async () => {
    const original = ocr();
    const { reader } = lector(null);
    const r = await new VisionRescueExtractor(primario(original).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(r.extraction).toEqual(original);
    expect(r.usage.tokensIn).toBe(2000);
  });

  it("si la visión falla, devuelve la lectura original sin romper el flujo", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reader } = lector(null, true);
    const original = ocr();
    const r = await new VisionRescueExtractor(primario(original).port, reader, () => HOY).extract(img, "image/jpeg");
    expect(r.extraction).toEqual(original);
    expect(err).toHaveBeenCalledWith("Fallo la lectura del comprobante en la imagen", 500);
    err.mockRestore();
  });
});

describe("sinEcoDeFecha", () => {
  it("descarta el número que empieza con día y mes de la fecha y deja los demás", () => {
    expect(sinEcoDeFecha("181136", "2026-11-18")).toBeNull();
    expect(sinEcoDeFecha("202443", "2026-11-18")).toBe("202443");
    expect(sinEcoDeFecha("1811", "2026-11-18")).toBe("1811");
    expect(sinEcoDeFecha(null, "2026-11-18")).toBeNull();
  });
});

describe("OpenAIVisionReader", () => {
  const cliente = (res: Record<string, unknown>) => {
    const parse = vi.fn(async (_p: Record<string, unknown>) => res);
    return { client: { responses: { parse } }, parse };
  };

  it("manda la imagen en base64, sin guardar en OpenAI, con la instrucción de interpretar la letra, y devuelve la lectura", async () => {
    const { client, parse } = cliente({ status: "completed", output_parsed: vision(), usage: { input_tokens: 900, output_tokens: 140 } });
    const r = await new OpenAIVisionReader("gpt-x", client).readDocument(img, "image/jpeg", HOY);
    expect(r.extraction?.items?.[0].descripcion).toBe("Rollo de Impresora Térmica 80x60");
    expect(r.tokensIn).toBe(900);
    const params = parse.mock.calls[0][0] as { store: boolean; instructions: string; input: { content: { type: string; image_url?: string }[] }[] };
    expect(params.store).toBe(false);
    expect(params.instructions).toContain("interpretación más probable");
    expect(params.input[0].content.find((c) => c.type === "input_image")?.image_url).toBe(`data:image/jpeg;base64,${img.toString("base64")}`);
  });

  it("una respuesta incompleta o que no cumple el esquema no da lectura, pero informa el consumo", async () => {
    const incompleta = cliente({ status: "incomplete", output_parsed: null, usage: { input_tokens: 650, output_tokens: 4000 } });
    expect(await new OpenAIVisionReader("gpt-x", incompleta.client).readDocument(img, "image/png", HOY)).toEqual({ extraction: null, tokensIn: 650, tokensOut: 4000 });
    const rota = cliente({ status: "completed", output_parsed: { fecha: "x" }, usage: {} });
    expect((await new OpenAIVisionReader("gpt-x", rota.client).readDocument(img, "image/png", HOY)).extraction).toBeNull();
  });
});
