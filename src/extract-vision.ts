import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { type Extraction, ExtractionSchema, SYSTEM } from "./extract.js";
import { fechaLeida } from "./invoice-key.js";
import type { ExtractionResult, ExtractorPort } from "./types.js";

/** Lo mínimo que se usa de OpenAI para leer la imagen; permite un cliente falso en las pruebas. */
export interface VisionClient {
  responses: { parse(params: Record<string, unknown>): Promise<any> };
}

export interface LecturaDeImagen {
  extraction: Extraction | null;
  tokensIn: number;
  tokensOut: number;
}

export interface VisionReader {
  /** Lee TODO el comprobante directamente de la imagen (sirve para letra manuscrita que el OCR no capta). */
  readDocument(data: Buffer, mimeType: string, hoy: string): Promise<LecturaDeImagen>;
}

const INSTRUCCIONES = `${SYSTEM}

Estás viendo la IMAGEN original del comprobante (no un texto). Puede estar escrito a mano. Lee la letra con cuidado: si una palabra no es del todo clara, escribe la interpretación más probable según el contexto (por ejemplo «Rollo de Impresora Térmica 80x60» para un rollo de papel) en lugar de dejarla vacía o inventar otra cosa. Lee cada renglón (cantidad, detalle, valor unitario y valor total), la fecha (a mano suele ir en una casilla arriba a la derecha como «18/11/26»: día, mes y año de dos cifras del siglo XXI) y el total. No uses la fecha de hoy si el comprobante no muestra ninguna.`;

/** Lee el comprobante con un modelo de visión de OpenAI (la imagen no se guarda en su plataforma: store false). */
export class OpenAIVisionReader implements VisionReader {
  constructor(
    private model: string,
    private client: VisionClient,
  ) {}

  static withKey(model: string, apiKey: string) {
    return new OpenAIVisionReader(model, new OpenAI({ apiKey }) as unknown as VisionClient);
  }

  async readDocument(data: Buffer, mimeType: string, hoy: string): Promise<LecturaDeImagen> {
    const res = await this.client.responses.parse({
      model: this.model,
      instructions: INSTRUCCIONES,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Hoy es ${hoy}. Lee este comprobante.` },
            { type: "input_image", image_url: `data:${mimeType};base64,${data.toString("base64")}`, detail: "high" },
          ],
        },
      ],
      text: { format: zodTextFormat(ExtractionSchema, "comprobante") },
      store: false,
      max_output_tokens: 4000,
    });
    const tokensIn = res.usage?.input_tokens ?? 0;
    const tokensOut = res.usage?.output_tokens ?? 0;
    if (res.status !== "completed" || !res.output_parsed) return { extraction: null, tokensIn, tokensOut };
    const valida = ExtractionSchema.safeParse(res.output_parsed);
    return { extraction: valida.success ? valida.data : null, tokensIn, tokensOut };
  }
}

const IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;
const MAX_ANOS_ATRAS = 5;
const MANUSCRITOS = new Set(["cuenta_cobro", "recibo"]);

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

/** Combina la lectura de texto (OCR) con la de la imagen. En comprobantes manuscritos manda la imagen; si no, solo completa vacíos. */
function combinar(texto: Extraction, imagen: Extraction, hoy: string): Extraction {
  const manuscrito = MANUSCRITOS.has(texto.tipo) || MANUSCRITOS.has(imagen.tipo);
  const fecha = fechaLeida(texto.fecha) ?? fechaPlausible(imagen.fecha, hoy);
  const elegir = <T>(delTexto: T | null, delaImagen: T | null): T | null =>
    manuscrito ? (delaImagen ?? delTexto) : (delTexto ?? delaImagen);

  const items = manuscrito
    ? (imagen.items && imagen.items.length > 0 ? imagen.items : texto.items)
    : (texto.items && texto.items.length > 0 ? texto.items : imagen.items);
  const numero = elegir(texto.numero_factura, imagen.numero_factura);

  return {
    ...texto,
    proveedor: elegir(texto.proveedor, imagen.proveedor),
    nit: elegir(texto.nit, imagen.nit),
    numero_factura: fecha ? sinEcoDeFecha(numero, fecha) : numero,
    fecha,
    descripcion: manuscrito ? (imagen.descripcion || texto.descripcion) : texto.descripcion,
    medio_pago: elegir(texto.medio_pago, imagen.medio_pago),
    // Los valores en pesos se conservan de la lectura de texto; la imagen solo los completa si faltan.
    subtotal: texto.subtotal ?? imagen.subtotal,
    iva: texto.iva ?? imagen.iva,
    total: texto.total ?? imagen.total,
    items: items ?? null,
  };
}

/**
 * Segunda lectura sobre la imagen, solo cuando la primera (OCR + texto) se queda corta:
 * - no trajo fecha (p. ej. escrita a mano), o
 * - es un comprobante manuscrito (cuenta de cobro o recibo), donde el OCR suele leer mal la letra.
 * Es opcional: si falla o no devuelve nada útil, la lectura queda como estaba (y, sin fecha, el bot pregunta).
 */
export class VisionRescueExtractor implements ExtractorPort {
  constructor(
    private primary: ExtractorPort,
    private reader: VisionReader,
    private hoy: () => string,
  ) {}

  async extract(data: Buffer, mimeType: string): Promise<ExtractionResult> {
    const result = await this.primary.extract(data, mimeType);
    const e = result.extraction;
    if (!e || !e.es_comprobante || !IMAGE_MIME.test(mimeType)) return result;
    if (fechaLeida(e.fecha) && !MANUSCRITOS.has(e.tipo)) return result;

    try {
      const hoy = this.hoy();
      const leida = await this.reader.readDocument(data, mimeType, hoy);
      const usage = {
        ...result.usage,
        tokensIn: result.usage.tokensIn + leida.tokensIn,
        tokensOut: result.usage.tokensOut + leida.tokensOut,
      };
      if (!leida.extraction || !leida.extraction.es_comprobante) return { extraction: e, usage };
      return { extraction: combinar(e, leida.extraction, hoy), usage };
    } catch (err) {
      // Solo el código de estado: los textos de error de la API pueden traer fragmentos de la clave o del caso.
      console.error("Fallo la lectura del comprobante en la imagen", (err as { status?: number }).status ?? "sin_estado");
      return result;
    }
  }
}
