import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ExtractionSchema, SYSTEM } from "./extract.js";
import type { ExtractionResult, ExtractorPort, Usage } from "./types.js";

/** Lo mínimo que se usa de LlamaParse (SDK @llamaindex/llama-cloud); permite un cliente falso en las pruebas. */
export interface ParseClient {
  parsing: { parse(params: Record<string, unknown>): Promise<any> };
}

/** Lo mínimo que se usa de OpenAI para estructurar el texto; permite un cliente falso en las pruebas. */
export interface StructureClient {
  responses: { parse(params: Record<string, unknown>): Promise<any> };
}

export interface LlamaParseOptions {
  /** Nivel de LlamaParse: fast, cost_effective, agentic o agentic_plus. */
  tier: string;
  /** Modelo de OpenAI que llena los campos a partir del texto. */
  model: string;
}

// Un comprobante de varias páginas puede ser largo: se acota el texto para acotar también el costo.
const MAX_TEXT_CHARS = 40_000;

/**
 * Lectura de facturas en dos pasos:
 * 1) LlamaParse convierte el archivo (PDF o foto) en texto y tablas (OCR).
 * 2) Un modelo de OpenAI llena los campos del comprobante con el esquema ExtractionSchema (salida estructurada).
 * Si el archivo no tiene texto legible, no hay lectura (sin error); el consumo se informa igual.
 */
export class LlamaParseExtractor implements ExtractorPort {
  constructor(
    private opts: LlamaParseOptions,
    private parser: ParseClient,
    private structurer: StructureClient,
  ) {}

  async extract(data: Buffer, mimeType: string): Promise<ExtractionResult> {
    const file = new File([new Uint8Array(data)], "comprobante", { type: mimeType });
    const parsed = await this.parser.parsing.parse({
      tier: this.opts.tier,
      version: "latest",
      upload_file: file,
      expand: ["markdown", "usage"],
    });

    const text = ((parsed?.markdown?.pages ?? []) as { success?: boolean; markdown?: string }[])
      .filter((p) => p.success === true && typeof p.markdown === "string")
      .map((p) => p.markdown as string)
      .join("\n\n---\n\n")
      .trim()
      .slice(0, MAX_TEXT_CHARS);

    const paginas = (parsed?.markdown?.pages ?? []) as unknown[];
    const creditos = parsed?.usage?.credits;
    const usage: Usage = {
      model: `llamaparse:${this.opts.tier}+${this.opts.model}`,
      tokensIn: 0,
      tokensOut: 0,
      llamaparsePages: paginas.length,
      llamaparseCredits: typeof creditos === "number" ? creditos : null,
    };
    if (!text) return { extraction: null, usage };

    const res = await this.structurer.responses.parse({
      model: this.opts.model,
      instructions: SYSTEM,
      input: [
        {
          role: "user",
          content: `Este es el texto extraído del comprobante (OCR de la factura, con sus tablas en markdown):\n\n${text}`,
        },
      ],
      text: { format: zodTextFormat(ExtractionSchema, "comprobante") },
      store: false, // OpenAI no guarda el comprobante en su plataforma
      max_output_tokens: 4000,
    });

    usage.tokensIn = res.usage?.input_tokens ?? 0;
    usage.tokensOut = res.usage?.output_tokens ?? 0;
    if (res.status !== "completed" || !res.output_parsed) return { extraction: null, usage };
    // Se valida otra vez con el mismo esquema: lo que llega aquí debe cumplir la forma exacta que usa el resto del sistema.
    return { extraction: ExtractionSchema.parse(res.output_parsed), usage };
  }

  /** Cliente de OpenAI con su clave (la clave nunca se registra). */
  static structurerWithKey(apiKey: string): StructureClient {
    return new OpenAI({ apiKey }) as unknown as StructureClient;
  }
}

/**
 * Usa el extractor principal y, si lanza un error (red, cuota, servicio caído), intenta el respaldo.
 * Un comprobante que no se pudo leer (resultado vacío) NO activa el respaldo: eso es una respuesta válida.
 */
export class FallbackExtractor implements ExtractorPort {
  constructor(
    private primary: ExtractorPort,
    private fallback: ExtractorPort | null,
  ) {}

  async extract(data: Buffer, mimeType: string): Promise<ExtractionResult> {
    try {
      return await this.primary.extract(data, mimeType);
    } catch (err) {
      // Solo el código de estado: los textos de error de las APIs pueden traer fragmentos de claves o del caso.
      console.error("Fallo la lectura principal de un comprobante", (err as { status?: number }).status ?? "sin_estado");
      if (!this.fallback) throw err;
      return this.fallback.extract(data, mimeType);
    }
  }
}
