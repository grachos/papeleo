import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM, TOOLS } from "../src/assistant.js";
import { OpenAIAssistant, type ResponsesClient } from "../src/assistant-openai.js";
import type { Expense, QueryPort } from "../src/types.js";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const EXP_ID = "0b3c5c52-7a0e-4b51-9c61-3a2f6f1e9a10";
const CLAVE = `sk-${randomBytes(16).toString("hex")}`; // distinta en cada corrida

const expense: Expense = {
  id: EXP_ID, fecha: "2026-11-03", proveedor: "Éxito", nit: null, numero_factura: null, subtotal: null, iva: null,
  total: 45900, moneda: "COP", categoria: "mercado_hogar", medio_pago: null, descripcion: "Mercado", confianza: "alta",
};

function makeQuery(): QueryPort & { [k: string]: any } {
  return {
    resumir: vi.fn(async () => [{ grupo: "total", moneda: "COP", valor: 230000, cantidad: 3, con_dato: 3, total_grupos: 1 }]),
    listar: vi.fn(async () => ({ rows: [expense], total: 37 })),
    detalle: vi.fn(async () => expense),
    logQuery: vi.fn(),
    recentTurns: vi.fn(),
    countSince: vi.fn(),
    setFeedback: vi.fn(),
  } as unknown as QueryPort & { [k: string]: any };
}

const usage = { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } };
const call = (name: string, args: unknown, call_id = "call_1") => ({ type: "function_call", call_id, name, arguments: JSON.stringify(args) });
const reply = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], output_text: text, usage });
const toolTurn = (...calls: ReturnType<typeof call>[]) => ({ status: "completed", output: calls, output_text: "", usage });

function fakeClient(script: any[]) {
  const calls: Record<string, unknown>[] = [];
  const create = vi.fn(async (p: Record<string, unknown>) => {
    calls.push(structuredClone(p)); // copia de cada llamada tal como se hizo (el asistente sigue modificando su lista)
    const next = script.shift();
    if (!next) throw new Error("guion agotado");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { responses: { create } } as unknown as ResponsesClient, create, calls };
}

const ask = (a: OpenAIAssistant, over: Record<string, unknown> = {}) =>
  a.answer({ orgId: ORG, question: "¿cuánto gasté?", today: "2026-11-17", history: [], ...over } as never);

afterEach(() => vi.unstubAllEnvs());

describe("herramientas en formato de OpenAI", () => {
  it("son las mismas del asistente, sin campo de empresa y sin modo estricto", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(["resumir_gastos", "listar_gastos", "detalle_gasto"]);
    for (const t of TOOLS) {
      expect(JSON.stringify(t.input_schema)).not.toMatch(/org/i);
    }
  });
});

describe("OpenAIAssistant", () => {
  it("envía el modelo, las instrucciones, las herramientas y store:false (no se guardan las conversaciones)", async () => {
    const { client, create } = fakeClient([reply("Listo.")]);
    await ask(new OpenAIAssistant("gpt-5.4-mini", makeQuery(), client), {
      history: [{ question: "hola", answer: "¡Hola!" }],
    });
    const p = create.mock.calls[0][0] as any;
    expect(p).toMatchObject({ model: "gpt-5.4-mini", instructions: SYSTEM, store: false, max_output_tokens: 4000 });
    expect(p.tools.map((t: any) => t.name)).toEqual(["resumir_gastos", "listar_gastos", "detalle_gasto"]);
    expect(p.tools.every((t: any) => t.type === "function" && t.strict === false)).toBe(true);
    expect(p.input).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¡Hola!" },
      { role: "user", content: "[Fecha de hoy: 2026-11-17, hora de Colombia]\n¿cuánto gasté?" },
    ]);
  });

  it("herramienta → respuesta: la empresa sale del servidor y los tokens se suman", async () => {
    const q = makeQuery();
    const { client, create } = fakeClient([
      toolTurn(call("resumir_gastos", { medida: "suma", agrupar_por: "mes" })),
      reply("En noviembre gastaste $230.000."),
    ]);
    const r = await ask(new OpenAIAssistant("m", q, client));
    expect(r).toMatchObject({ status: "ok", text: "En noviembre gastaste $230.000.", tokensIn: 1800, tokensOut: 80 });
    expect(r.plan).toEqual([{ tool: "resumir_gastos", input: { medida: "suma", agrupar_por: "mes" }, ok: true }]);
    expect(q.resumir).toHaveBeenCalledWith(ORG, expect.objectContaining({ agrupar: "mes", medida: "suma" }));

    // la segunda petición reenvía la llamada y su resultado, con el mismo call_id, y sin ids internos
    const second = (create.mock.calls[1][0] as any).input;
    expect(second.slice(-2)[0]).toEqual({ type: "function_call", call_id: "call_1", name: "resumir_gastos", arguments: JSON.stringify({ medida: "suma", agrupar_por: "mes" }) });
    const out = second.at(-1);
    expect(out).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(JSON.parse(out.output).grupos[0].valor_formateado).toContain("230.000");
  });

  it("parámetros inválidos vuelven al modelo como error para que corrija; la empresa nunca viene del modelo", async () => {
    const q = makeQuery();
    const { client, calls } = fakeClient([
      toolTurn(call("resumir_gastos", { medida: "suma", org_id: "robada" })),
      toolTurn(call("resumir_gastos", { medida: "suma" }, "call_2")),
      reply("Listo."),
    ]);
    const r = await ask(new OpenAIAssistant("m", q, client));
    expect(r.status).toBe("ok");
    expect(q.resumir).toHaveBeenCalledTimes(1);
    expect(q.resumir.mock.calls[0][0]).toBe(ORG);
    const err = (calls[1] as any).input.at(-1);
    expect(JSON.parse(err.output).error).toContain("Parámetros inválidos");
    expect(r.plan.map((p) => p.ok)).toEqual([false, true]);
  });

  it("tras dos fallos seguidos se rinde con honestidad", async () => {
    const { client } = fakeClient([
      toolTurn(call("resumir_gastos", { medida: "x" })),
      toolTurn(call("resumir_gastos", { medida: "y" }, "call_2")),
    ]);
    const r = await ask(new OpenAIAssistant("m", makeQuery(), client));
    expect(r.status).toBe("sin_respuesta");
    expect(r.text).toContain("No pude responder");
  });

  it("una respuesta incompleta o fallida no se usa", async () => {
    const { client } = fakeClient([{ status: "incomplete", output: [], output_text: "", usage }]);
    expect((await ask(new OpenAIAssistant("m", makeQuery(), client))).status).toBe("sin_respuesta");
  });

  it("sin texto final (ni herramientas) no inventa respuesta", async () => {
    const { client } = fakeClient([{ status: "completed", output: [], output_text: "  ", usage }]);
    expect((await ask(new OpenAIAssistant("m", makeQuery(), client))).status).toBe("sin_respuesta");
  });

  it("corta si el modelo no termina de usar herramientas", async () => {
    const script = Array.from({ length: 6 }, (_, i) => toolTurn(call("listar_gastos", {}, `c${i}`)));
    const { client, create } = fakeClient(script);
    const r = await ask(new OpenAIAssistant("m", makeQuery(), client));
    expect(r.status).toBe("sin_respuesta");
    expect(create).toHaveBeenCalledTimes(5); // 4 vueltas de herramientas + 1 intento final
  });

  it("si la API falla devuelve estado error, sin filtrar la clave ni el detalle", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient([new Error(`401 Incorrect API key provided: ${CLAVE}`)]);
    const r = await ask(new OpenAIAssistant("m", makeQuery(), client));
    expect(r.status).toBe("error");
    expect(r.text).toContain("problema");
    expect(JSON.stringify(r)).not.toContain(CLAVE);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(CLAVE);
    spy.mockRestore();
  });

  it("un fallo de la base no se muestra técnico al modelo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = makeQuery();
    q.resumir = vi.fn(async () => { throw new Error("connection to 10.0.0.1 refused"); }) as never;
    const { client, calls } = fakeClient([toolTurn(call("resumir_gastos", { medida: "suma" })), reply("No puedo ahora.")]);
    await ask(new OpenAIAssistant("m", q, client));
    const out = (calls[1] as any).input.at(-1);
    expect(JSON.parse(out.output).error).toBe("No pude consultar los datos en este momento.");
    expect(out.output).not.toContain("10.0.0.1");
    spy.mockRestore();
  });
});
