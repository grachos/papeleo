import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ExtractionResult, ExtractorPort, Usage } from "./types.js";

export const CATEGORIAS = [
  "alimentacion",
  "transporte",
  "combustible",
  "peajes_parqueadero",
  "hospedaje",
  "servicios_publicos",
  "arriendo",
  "papeleria_oficina",
  "tecnologia",
  "salud",
  "impuestos",
  "nomina_honorarios",
  "mantenimiento",
  "mercado_hogar",
  "otros",
] as const;

export const ExtractionSchema = z.object({
  es_comprobante: z
    .boolean()
    .describe("true solo si la imagen es una factura, tiquete, recibo, cuenta de cobro o comprobante de pago"),
  tipo: z.enum(["factura_electronica", "tiquete_pos", "recibo", "cuenta_cobro", "comprobante_transferencia", "otro"]),
  proveedor: z.string().nullable().describe("Razón social o nombre de quien vende o recibe el pago"),
  nit: z.string().nullable().describe("NIT o cédula del proveedor, con dígito de verificación si aparece"),
  numero_factura: z.string().nullable(),
  fecha: z.string().nullable().describe("Fecha de emisión en formato AAAA-MM-DD"),
  subtotal: z.number().nullable().describe("Valor antes de impuestos, en número sin separadores"),
  iva: z.number().nullable().describe("Valor del IVA en pesos, no el porcentaje"),
  total: z.number().nullable().describe("Total pagado, en número sin separadores"),
  moneda: z.string().describe("Código ISO, normalmente COP"),
  medio_pago: z.enum(["efectivo", "tarjeta_debito", "tarjeta_credito", "transferencia", "otro"]).nullable(),
  categoria: z.enum(CATEGORIAS),
  descripcion: z.string().describe("Resumen de máximo 10 palabras de lo comprado"),
  confianza: z.enum(["alta", "media", "baja"]).describe("Qué tan legibles y seguros son el total y la fecha"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `Lees comprobantes de gasto colombianos (facturas electrónicas DIAN, tiquetes POS, recibos manuscritos, cuentas de cobro, comprobantes de Nequi, Daviplata o transferencia) y devuelves sus datos.

Los valores están en pesos colombianos: el punto separa miles y la coma decimales, así que "45.900" es cuarenta y cinco mil novecientos. Las fechas suelen venir como DD/MM/AAAA.
No inventes datos: si un campo no aparece o no se lee, devuélvelo como null. Si el total es dudoso, marca confianza "baja" en vez de adivinar.
Si la imagen no es un comprobante de gasto, devuelve es_comprobante false y el resto de campos en null o en su valor más neutro.`;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export function isSupportedMime(mime: string): boolean {
  return mime === "application/pdf" || (IMAGE_TYPES as readonly string[]).includes(mime);
}

/** Lo mínimo que se usa del SDK; permite inyectar un cliente falso en las pruebas. */
export interface ParseClient {
  messages: { parse(params: any): Promise<any> };
}

export class ClaudeExtractor implements ExtractorPort {
  constructor(
    private model: string,
    private client: ParseClient = new Anthropic(),
  ) {}

  /** `extraction` es null si el modelo no pudo producir una lectura válida; el consumo se informa siempre. */
  async extract(data: Buffer, mimeType: string): Promise<ExtractionResult> {
    const b64 = data.toString("base64");
    const file: Anthropic.ContentBlockParam =
      mimeType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
        : { type: "image", source: { type: "base64", media_type: mimeType as ImageType, data: b64 } };

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: [file, { type: "text", text: "Extrae los datos de este comprobante." }] }],
      output_config: { effort: "medium", format: zodOutputFormat(ExtractionSchema) },
    });

    const u = response.usage ?? {};
    const usage: Usage = {
      model: this.model,
      tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      tokensOut: u.output_tokens ?? 0,
    };
    if (response.stop_reason !== "end_turn") return { extraction: null, usage };
    return { extraction: response.parsed_output ?? null, usage };
  }
}
