import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAssistant, runTool, SYSTEM, TOOLS, type MessagesClient } from "../src/assistant.js";
import type { Expense, QueryPort } from "../src/types.js";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const EXP_ID = "0b3c5c52-7a0e-4b51-9c61-3a2f6f1e9a10";

const expense: Expense = {
  id: EXP_ID, fecha: "2026-11-03", proveedor: "Éxito", nit: "890900608-9", numero_factura: "A123", subtotal: 38571,
  iva: 7329, total: 45900, moneda: "COP", categoria: "mercado_hogar", medio_pago: "tarjeta_debito", descripcion: "Mercado", confianza: "alta",
};

function makeQuery(over: Partial<QueryPort> = {}) {
  const q = {
    resumir: vi.fn(async () => [{ grupo: "total", moneda: "COP", valor: 230000, cantidad: 3, con_dato: 3, total_grupos: 1 }]),
    listar: vi.fn(async () => ({ rows: [expense], total: 37 })),
    detalle: vi.fn(async () => expense as Expense | null),
    logQuery: vi.fn(),
    recentTurns: vi.fn(),
    countSince: vi.fn(),
    setFeedback: vi.fn(),
    ...over,
  };
  return q as typeof q & QueryPort;
}

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
const toolUse = (name: string, input: unknown, id = "tu1"): Anthropic.Message =>
  ({ stop_reason: "tool_use", usage, content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id, name, input }] }) as never;
const finalText = (text: string): Anthropic.Message => ({ stop_reason: "end_turn", usage, content: [{ type: "text", text }] }) as never;

function fakeClient(script: (Anthropic.Message | Error)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = []; // copia de cada llamada tal como se hizo
  const create = vi.fn(async (p: Anthropic.MessageCreateParamsNonStreaming) => {
    calls.push(structuredClone(p));
    const next = script.shift();
    if (!next) throw new Error("guion agotado");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { messages: { create } } as MessagesClient, create, calls };
}

const ask = (a: ClaudeAssistant, over: Record<string, unknown> = {}) =>
  a.answer({ orgId: ORG, question: "¿cuánto gasté?", today: "2026-11-10", history: [], ...over } as never);

describe("herramientas", () => {
  it("ningún esquema deja elegir la empresa y todos son estrictos", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["resumir_gastos", "listar_gastos", "detalle_gasto"]);
    for (const t of TOOLS) {
      expect(JSON.stringify(t.input_schema)).not.toMatch(/org/i);
      expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.input_schema).not.toHaveProperty("$schema");
    }
  });

  it("el mensaje de sistema es estable y reconoce lo que aún no puede hacer", () => {
    expect(SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/); // sin fechas: se puede cachear
    expect(SYSTEM).toContain("NO puedes enviar fotos ni archivos");
    expect(SYSTEM).toContain("DATOS");
  });
});

describe("runTool", () => {
  it("usa SIEMPRE la empresa recibida y completa los valores por defecto", async () => {
    const q = makeQuery();
    await runTool("resumir_gastos", { medida: "suma", categoria: "combustible" }, ORG, q);
    expect(q.resumir).toHaveBeenCalledWith(ORG, expect.objectContaining({ medida: "suma", agrupar: "ninguno", orden: "valor_desc", limite: 12, campo: "total", categoria: "combustible" }));
  });

  it("rechaza org_id, campos extra, enumeraciones y fechas inválidas", async () => {
    const q = makeQuery();
    await expect(runTool("resumir_gastos", { medida: "suma", org_id: "otra" }, ORG, q)).rejects.toThrow();
    await expect(runTool("resumir_gastos", { medida: "borrar" }, ORG, q)).rejects.toThrow();
    await expect(runTool("resumir_gastos", { medida: "suma", desde: "ayer" }, ORG, q)).rejects.toThrow();
    await expect(runTool("resumir_gastos", { medida: "suma", categoria: "inventada" }, ORG, q)).rejects.toThrow();
    await expect(runTool("listar_gastos", { limite: 500 }, ORG, q)).rejects.toThrow();
    await expect(runTool("detalle_gasto", { id: "no-es-uuid" }, ORG, q)).rejects.toThrow();
    expect(q.resumir).not.toHaveBeenCalled();
    expect(q.listar).not.toHaveBeenCalled();
    expect(q.detalle).not.toHaveBeenCalled();
  });

  it("entrega el dinero ya formateado junto al número, y las cuentas sin signo de pesos", async () => {
    const q = makeQuery({
      resumir: vi.fn(async () => [
        { grupo: "total", moneda: "COP", valor: 230000, cantidad: 3, con_dato: 3, total_grupos: 2 },
        { grupo: "total", moneda: "USD", valor: 30, cantidad: 1, con_dato: 1, total_grupos: 2 },
      ]),
    });
    const out: any = await runTool("resumir_gastos", { medida: "suma" }, ORG, q);
    expect(out.grupos[0].valor_formateado).toMatch(/230\.000/);
    expect(out.grupos[0].valor_formateado).toContain("$");
    expect(out.grupos[1].valor_formateado).toMatch(/^USD 30/);
    const count: any = await runTool("resumir_gastos", { medida: "cuenta" }, ORG, q);
    expect(count.grupos[0].valor_formateado).toBe("230000");
  });

  it("el IVA pedido llega con cuántas facturas lo traen, para que el modelo no diga «no tiene IVA»", async () => {
    const q = makeQuery({ resumir: vi.fn(async () => [{ grupo: "total", moneda: "COP", valor: 28739, cantidad: 12, con_dato: 9, total_grupos: 1 }]) });
    const out: any = await runTool("resumir_gastos", { medida: "suma", campo: "iva" }, ORG, q);
    expect(q.resumir).toHaveBeenCalledWith(ORG, expect.objectContaining({ campo: "iva" }));
    expect(out.grupos[0]).toMatchObject({ facturas: 12, facturas_con_ese_dato: 9 });
    await expect(runTool("resumir_gastos", { medida: "suma", campo: "descuento" }, ORG, q)).rejects.toThrow();
  });

  it("listar informa el total de coincidencias; detalle consulta con la empresa y avisa si no existe", async () => {
    const q = makeQuery({ detalle: vi.fn(async () => null) });
    const list: any = await runTool("listar_gastos", {}, ORG, q);
    expect(list).toMatchObject({ total_de_facturas_que_coinciden: 37, mostrando: 1 });
    expect(list.facturas[0].total_formateado).toContain("45.900");
    expect(await runTool("detalle_gasto", { id: EXP_ID }, ORG, q)).toEqual({ error: "No encontré esa factura." });
    expect(q.detalle).toHaveBeenCalledWith(ORG, EXP_ID);
  });
});

describe("ClaudeAssistant", () => {
  it("plan → herramienta → respuesta: la empresa sale del servidor y el contenido del modelo vuelve intacto", async () => {
    const q = makeQuery();
    const first = toolUse("resumir_gastos", { medida: "suma", agrupar_por: "mes", desde: "2026-11-01" });
    const { client, calls } = fakeClient([first, finalText("En noviembre gastaste $230.000.")]);

    const r = await ask(new ClaudeAssistant("modelo-x", q, client), { history: [{ question: "hola", answer: "¡Hola!" }] });

    expect(r).toMatchObject({ status: "ok", text: "En noviembre gastaste $230.000.", tokensIn: 300, tokensOut: 40 });
    expect(r.plan).toEqual([{ tool: "resumir_gastos", input: { medida: "suma", agrupar_por: "mes", desde: "2026-11-01" }, ok: true }]);
    expect(q.resumir).toHaveBeenCalledWith(ORG, expect.objectContaining({ agrupar: "mes", desde: "2026-11-01" }));

    const [firstCall, secondCall] = calls;
    expect(firstCall).toMatchObject({ model: "modelo-x", system: SYSTEM, cache_control: { type: "ephemeral" } });
    expect(firstCall.messages).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¡Hola!" },
      { role: "user", content: "[Fecha de hoy: 2026-11-10, hora de Colombia]\n¿cuánto gasté?" },
    ]);
    // Segunda llamada: el turno del asistente se reenvía tal cual (con sus bloques de razonamiento) + el resultado.
    const sent = secondCall.messages.slice(-2);
    expect(sent[0]).toEqual({ role: "assistant", content: first.content });
    expect((sent[1].content as any)[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });
    expect(JSON.parse((sent[1].content as any)[0].content).grupos[0].valor_formateado).toContain("230.000");
  });

  it("si el modelo manda parámetros inválidos recibe el error y puede corregirse", async () => {
    const q = makeQuery();
    const { client, calls } = fakeClient([
      toolUse("resumir_gastos", { medida: "suma", org_id: "robada" }),
      toolUse("resumir_gastos", { medida: "suma" }, "tu2"),
      finalText("Listo: $230.000."),
    ]);
    const r = await ask(new ClaudeAssistant("m", q, client));
    expect(r.status).toBe("ok");
    expect(q.resumir).toHaveBeenCalledTimes(1);
    const retry = calls[1].messages.at(-1)!.content as any[];
    expect(retry[0]).toMatchObject({ is_error: true });
    expect(retry[0].content).toContain("Parámetros inválidos");
    expect(r.plan.map((p: any) => p.ok)).toEqual([false, true]);
  });

  it("se rinde con honestidad tras dos fallos seguidos", async () => {
    const q = makeQuery();
    const { client } = fakeClient([toolUse("resumir_gastos", { medida: "x" }), toolUse("resumir_gastos", { medida: "y" }, "tu2")]);
    const r = await ask(new ClaudeAssistant("m", q, client));
    expect(r.status).toBe("sin_respuesta");
    expect(r.text).toContain("No pude responder");
    expect(q.resumir).not.toHaveBeenCalled();
  });

  it("un fallo de la base no se le muestra técnico al modelo ni a la persona", async () => {
    const q = makeQuery({ resumir: vi.fn(async () => { throw new Error("connection refused 10.0.0.1"); }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, calls } = fakeClient([toolUse("resumir_gastos", { medida: "suma" }), finalText("Ahora no puedo consultar.")]);
    const r = await ask(new ClaudeAssistant("m", q, client));
    const toolResult = (calls[1].messages.at(-1)!.content as any[])[0];
    expect(toolResult).toMatchObject({ is_error: true, content: "No pude consultar los datos en este momento." });
    expect(r.status).toBe("ok");
    spy.mockRestore();
  });

  it("corta si el modelo no termina de usar herramientas", async () => {
    const q = makeQuery();
    const script = Array.from({ length: 6 }, (_, i) => toolUse("listar_gastos", {}, `t${i}`));
    const { client, create } = fakeClient(script);
    const r = await ask(new ClaudeAssistant("m", q, client));
    expect(r.status).toBe("sin_respuesta");
    expect(create).toHaveBeenCalledTimes(5); // 4 vueltas de herramientas + 1 intento final
  });

  it("devuelve estado error si la API falla, y sin_respuesta ante un rechazo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await ask(new ClaudeAssistant("m", makeQuery(), fakeClient([new Error("503")]).client));
    expect(a).toMatchObject({ status: "error" });
    expect(a.text).toContain("problema");
    const refusal = { stop_reason: "refusal", usage, content: [] } as never;
    const b = await ask(new ClaudeAssistant("m", makeQuery(), fakeClient([refusal]).client));
    expect(b.status).toBe("sin_respuesta");
    spy.mockRestore();
  });
});
