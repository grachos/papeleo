import OpenAI from "openai";
import { z } from "zod";
import { MAX_TOOL_FAILURES, MAX_TOOL_ROUNDS, NO_PUDE, PROBLEMA, runTool, SYSTEM, TOOLS } from "./assistant.js";
import type { AssistantInput, AssistantPort, AssistantResult, QueryPort } from "./types.js";

/** Lo mínimo que se usa del SDK de OpenAI; permite inyectar un cliente falso en las pruebas. */
export interface ResponsesClient {
  responses: { create(params: Record<string, unknown>): Promise<any> };
}

// Las mismas herramientas de solo lectura del asistente, en el formato de funciones de OpenAI.
// Sin campo de empresa: el servidor la fija (ver runTool).
const FUNCTIONS = TOOLS.map((t) => ({
  type: "function" as const,
  name: t.name,
  description: t.description ?? "",
  parameters: t.input_schema as unknown as Record<string, unknown>,
  strict: false, // la validación real la hace zod en runTool, con los mismos esquemas que el asistente de Claude
}));

const MAX_OUTPUT_TOKENS = 4000; // respuestas breves; evita que una respuesta se alargue sin fin

/**
 * Asistente de consultas con un modelo de OpenAI (API de respuestas, llamadas a funciones).
 * Mismo contrato que ClaudeAssistant: solo lectura, empresa fijada por el servidor y bucle acotado.
 * `store: false`: OpenAI no guarda las conversaciones de las personas en su plataforma.
 */
export class OpenAIAssistant implements AssistantPort {
  constructor(
    private model: string,
    private query: QueryPort,
    private client: ResponsesClient,
  ) {}

  static withKey(model: string, query: QueryPort, apiKey: string) {
    return new OpenAIAssistant(model, query, new OpenAI({ apiKey }) as unknown as ResponsesClient);
  }

  async answer(input: AssistantInput): Promise<AssistantResult> {
    const plan: { tool: string; input: unknown; ok: boolean }[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    const done = (status: AssistantResult["status"], text: string): AssistantResult => ({ text, status, plan, tokensIn, tokensOut });

    const items: Record<string, unknown>[] = [
      ...input.history.flatMap((t) => [
        { role: "user", content: t.question },
        { role: "assistant", content: t.answer },
      ]),
      { role: "user", content: `[Fecha de hoy: ${input.today}, hora de Colombia]\n${input.question}` },
    ];

    let failures = 0;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const res = await this.client.responses.create({
          model: this.model,
          instructions: SYSTEM,
          input: items,
          tools: FUNCTIONS,
          store: false,
          max_output_tokens: MAX_OUTPUT_TOKENS,
        });
        tokensIn += res.usage?.input_tokens ?? 0;
        tokensOut += res.usage?.output_tokens ?? 0;

        // Respuesta incompleta (p. ej. se acabaron los tokens) o fallida: no se usa.
        if (res.status !== "completed") return done("sin_respuesta", NO_PUDE);

        const calls: { call_id: string; name: string; arguments: string }[] = (res.output ?? []).filter(
          (i: { type?: string }) => i.type === "function_call",
        );
        if (calls.length === 0) {
          const text = String(res.output_text ?? "").trim();
          return text ? done("ok", text) : done("sin_respuesta", NO_PUDE);
        }
        if (round === MAX_TOOL_ROUNDS) return done("sin_respuesta", NO_PUDE); // demasiadas vueltas

        // Solo se reenvían las llamadas (sin ids internos de razonamiento, que no se guardan con store: false).
        for (const c of calls) items.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments });

        for (const call of calls) {
          let output: string;
          try {
            const args = JSON.parse(call.arguments || "{}");
            const out = await runTool(call.name, args, input.orgId, this.query);
            plan.push({ tool: call.name, input: args, ok: true });
            output = JSON.stringify(out);
          } catch (err) {
            failures += 1;
            plan.push({ tool: call.name, input: call.arguments, ok: false });
            if (err instanceof z.ZodError) {
              const detalle = err.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
              output = JSON.stringify({ error: `Parámetros inválidos: ${detalle}. Corrígelos e inténtalo de nuevo.` });
            } else {
              console.error("Fallo ejecutando la herramienta", call.name, err instanceof Error ? err.message : "error");
              output = JSON.stringify({ error: "No pude consultar los datos en este momento." });
            }
          }
          items.push({ type: "function_call_output", call_id: call.call_id, output });
        }
        if (failures >= MAX_TOOL_FAILURES) return done("sin_respuesta", NO_PUDE);
      }
      return done("sin_respuesta", NO_PUDE);
    } catch (err) {
      // Solo el código de estado: el texto del error de la API puede traer fragmentos de la clave o datos del caso.
      console.error("Fallo del asistente", (err as { status?: number }).status ?? "sin_estado");
      return done("error", PROBLEMA);
    }
  }
}
