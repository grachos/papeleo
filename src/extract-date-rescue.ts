import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { fechaLeida } from "./invoice-key.js";
import type { ExtractionResult, ExtractorPort } from "./types.js";

/** Lo mínimo que se usa de OpenAI para leer la fecha en la imagen; permite un cliente falso en las pruebas. */
export interface VisionClient {
  responses: { parse(params: Record<string, unknown>): Promise<any> };
}

export interface FechaLeidaDeImagen {
  fecha: string | null;
  tokensIn: number;
  tokensOut: number;
}

export interface DateReader {
  readDate(data: Buffer, mimeType: string, hoy: string): Promise<FechaLeidaDeImagen>;
}

const FechaSchema = z.object({
  fecha: z.string().nullable().describe("Fecha de emisión en formato AAAA-MM-DD, o null si no se ve ninguna fecha"),
});

const INSTRUCCIONES = `Lees UNA sola cosa en la imagen de un comprobante colombiano (factura, tiquete, recibo o cuenta de cobro): la fecha de emisión.
La fecha puede estar escrita a mano, por ejemplo en una casilla arriba a la derecha como «18/11/26» o «18 11 26» (día, mes, año). Los años de dos cifras son del siglo XXI (26 es 2026).
Devuelve la fecha como AAAA-MM-DD. Si no se ve ninguna fecha, devuelve null. No inventes: no uses la fecha de hoy si el comprobante no la muestra.`;

/** Lee la fecha directamente de la imagen con un modelo de visión (sirve para fechas escritas a mano que el OCR no capta). */
export class OpenAIDateReader implements DateReader {
  constructor(
    private model: string,
    private client: VisionClient,
  ) {}

  static withKey(model: string, apiKey: string) {
    return new OpenAIDateReader(model, new OpenAI({ apiKey }) as unknown as VisionClient);
  }

  async readDate(data: Buffer, mimeType: string, hoy: string): Promise<FechaLeidaDeImagen> {
    const res = await this.client.responses.parse({
      model: this.model,
      instructions: INSTRUCCIONES,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Hoy es ${hoy}. ¿Qué fecha tiene este comprobante?` },
            { type: "input_image", image_url: `data:${mimeType};base64,${data.toString("base64")}`, detail: "high" },
          ],
        },
      ],
      text: { format: zodTextFormat(FechaSchema, "fecha") },
      store: false, // OpenAI no guarda el comprobante en su plataforma
      max_output_tokens: 500,
    });
    const tokensIn = res.usage?.input_tokens ?? 0;
    const tokensOut = res.usage?.output_tokens ?? 0;
    if (res.status !== "completed" || !res.output_parsed) return { fecha: null, tokensIn, tokensOut };
    const leida = FechaSchema.safeParse(res.output_parsed);
    return { fecha: leida.success ? leida.data.fecha : null, tokensIn, tokensOut };
  }
}

const IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;
const MAX_ANOS_ATRAS = 5;

/** La fecha leída debe ser válida, no futura y no demasiado vieja; si no, no se usa (se le pregunta a la persona). */
function fechaPlausible(fecha: string | null, hoy: string): string | null {
  const f = fechaLeida(fecha);
  if (!f) return null;
  if (f > hoy) return null;
  const limite = `${Number(hoy.slice(0, 4)) - MAX_ANOS_ATRAS}${hoy.slice(4)}`;
  return f < limite ? null : f;
}

/**
 * «181136» con fecha 2026-11-18: son los dígitos de la fecha (DDMM + año mal leído), no un número de factura.
 * Devuelve null en ese caso; si no, el número tal cual.
 */
export function sinEcoDeFecha(numero: string | null, fecha: string): string | null {
  const [, mm, dd] = fecha.split("-");
  const eco = /^\d{6}$/.test(numero ?? "") && (numero as string).startsWith(`${dd}${mm}`);
  return eco ? null : numero;
}

/**
 * Si la lectura principal no trajo fecha (p. ej. está escrita a mano), se intenta leerla de la imagen con un modelo
 * de visión. Es un intento adicional y opcional: si falla o no ve fecha, la lectura queda como estaba y el bot pregunta.
 * Cuando se encuentra la fecha, un «número de factura» que en realidad eran los dígitos de la fecha (DDMM…) se descarta.
 */
export class DateRescueExtractor implements ExtractorPort {
  constructor(
    private primary: ExtractorPort,
    private reader: DateReader,
    private hoy: () => string,
  ) {}

  async extract(data: Buffer, mimeType: string): Promise<ExtractionResult> {
    const result = await this.primary.extract(data, mimeType);
    const e = result.extraction;
    if (!e || !e.es_comprobante || fechaLeida(e.fecha) || !IMAGE_MIME.test(mimeType)) return result;

    try {
      const hoy = this.hoy();
      const leida = await this.reader.readDate(data, mimeType, hoy);
      const usage = {
        ...result.usage,
        tokensIn: result.usage.tokensIn + leida.tokensIn,
        tokensOut: result.usage.tokensOut + leida.tokensOut,
      };
      const fecha = fechaPlausible(leida.fecha, hoy);
      if (!fecha) return { extraction: e, usage };

      return { extraction: { ...e, fecha, numero_factura: sinEcoDeFecha(e.numero_factura, fecha) }, usage };
    } catch (err) {
      // Solo el código de estado: los textos de error de la API pueden traer fragmentos de la clave o del caso.
      console.error("Fallo la lectura de la fecha en la imagen", (err as { status?: number }).status ?? "sin_estado");
      return result;
    }
  }
}
