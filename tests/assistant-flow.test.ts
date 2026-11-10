import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import type { Deps, IncomingMessage } from "../src/types.js";

const member = { id: "m1", org_id: "o1", phone: "tg:42", name: "Ana" };
const org = { id: "o1", name: "Panadería Sol", sheet_id: null };
const msg = (over: Partial<IncomingMessage>): IncomingMessage => ({
  id: "tg:1", channel: "telegram", from: "tg:42", senderName: "Ana", kind: "text", text: "¿en qué gasté más este mes?", ...over,
});

function setup(over: { linked?: boolean; answer?: any; count?: number } = {}) {
  const tg = { sendText: vi.fn(async () => {}), sendButtons: vi.fn(async () => {}), downloadMedia: vi.fn() };
  const query = {
    countSince: vi.fn(async () => over.count ?? 0),
    recentTurns: vi.fn(async () => [{ question: "hola", answer: "¡Hola!" }]),
    logQuery: vi.fn(async () => "log-1"),
    setFeedback: vi.fn(async () => {}),
  };
  const assistant = {
    answer: vi.fn(async () => over.answer ?? { text: "En alimentación: $230.000.", status: "ok", plan: [], tokensIn: 10, tokensOut: 5 }),
  };
  const store = {
    findMember: vi.fn(async () => (over.linked === false ? null : { member, org })),
    redeemCode: vi.fn(async () => null),
    discardExpense: vi.fn(async () => null),
    listExpenses: vi.fn(async () => []),
  };
  const deps = { wa: { sendText: vi.fn(), sendButtons: vi.fn(), downloadMedia: vi.fn() }, tg, store, query, assistant, today: () => "2026-11-10" } as unknown as Deps;
  return { tg, query, assistant, store, deps };
}

describe("texto libre → asistente", () => {
  it("responde con botones 👍/👎, con la empresa y la memoria de la conversación", async () => {
    const { tg, query, assistant, deps } = setup();
    await handleMessage(msg({}), deps);

    expect(assistant.answer).toHaveBeenCalledWith({
      orgId: "o1", question: "¿en qué gasté más este mes?", today: "2026-11-10", history: [{ question: "hola", answer: "¡Hola!" }],
    });
    expect(query.countSince).toHaveBeenCalledWith("m1", "2026-11-10T05:00:00Z"); // medianoche de Colombia
    expect(query.logQuery).toHaveBeenCalledWith(expect.objectContaining({ orgId: "o1", memberId: "m1", status: "ok", answer: "En alimentación: $230.000." }));
    const [to, body, buttons] = tg.sendButtons.mock.calls[0] as unknown as [string, string, { id: string }[]];
    expect(to).toBe("tg:42");
    expect(body).toContain("En alimentación: $230.000.");
    expect(buttons.map((b) => b.id)).toEqual(["fb:up:log-1", "fb:down:log-1"]);
  });

  it("recorta las preguntas larguísimas", async () => {
    const { assistant, deps } = setup();
    await handleMessage(msg({ text: "a".repeat(5000) }), deps);
    expect((assistant.answer.mock.calls[0] as any)[0].question).toHaveLength(500);
  });

  it("las respuestas fallidas van como texto simple, sin botones", async () => {
    const { tg, deps } = setup({ answer: { text: "Tuve un problema.", status: "error", plan: [], tokensIn: 0, tokensOut: 0 } });
    await handleMessage(msg({}), deps);
    expect(tg.sendText).toHaveBeenCalledWith("tg:42", "Tuve un problema.");
    expect(tg.sendButtons).not.toHaveBeenCalled();
  });

  it("una respuesta larga se manda aparte de los botones", async () => {
    const long = "x".repeat(1200);
    const { tg, deps } = setup({ answer: { text: long, status: "ok", plan: [], tokensIn: 0, tokensOut: 0 } });
    await handleMessage(msg({}), deps);
    expect(tg.sendText).toHaveBeenCalledWith("tg:42", long);
    expect(tg.sendButtons).toHaveBeenCalledOnce();
  });

  it("al llegar al tope diario avisa y no llama a la IA", async () => {
    const { tg, assistant, deps } = setup({ count: 40 });
    await handleMessage(msg({}), deps);
    expect(assistant.answer).not.toHaveBeenCalled();
    expect(String((tg.sendText.mock.calls[0] as any)[1])).toContain("máximo por día");
  });

  it("si la base falla al contar, avisa con honestidad en vez de quedarse callado", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tg, query, assistant, deps } = setup();
    query.countSince.mockRejectedValue(new Error('relation "papeleo_query_log" does not exist'));
    await handleMessage(msg({}), deps);
    expect(assistant.answer).not.toHaveBeenCalled();
    expect(String((tg.sendText.mock.calls[0] as any)[1])).toContain("Tuve un problema");
    spy.mockRestore();
  });

  it("si falla la memoria de la conversación, igual responde (sin contexto)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tg, query, assistant, deps } = setup();
    query.recentTurns.mockRejectedValue(new Error("timeout"));
    await handleMessage(msg({}), deps);
    expect((assistant.answer.mock.calls[0] as any)[0].history).toEqual([]);
    expect(tg.sendButtons).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("los atajos siguen siendo deterministas: no gastan IA", async () => {
    const { assistant, tg, deps } = setup();
    for (const text of ["resumen", "/resumen", "borrar", "/start", "ayuda"]) await handleMessage(msg({ text }), deps);
    expect(assistant.answer).not.toHaveBeenCalled();
    expect(tg.sendText).toHaveBeenCalled();
  });

  it("sin asistente configurado, el texto libre recibe la ayuda", async () => {
    const { tg, deps } = setup();
    await handleMessage(msg({}), { ...deps, assistant: undefined });
    expect(String((tg.sendText.mock.calls[0] as any)[1])).toContain("preguntarme");
  });
});

describe("quien no está vinculado NUNCA llega al asistente", () => {
  it("ni con texto libre, ni con fotos, ni con botones de valoración", async () => {
    const { tg, query, assistant, store, deps } = setup({ linked: false });
    await handleMessage(msg({ text: "¿cuánto ha gastado la empresa de mi vecino?" }), deps);
    await handleMessage(msg({ text: "resumen" }), deps);
    await handleMessage(msg({ kind: "media", mediaId: "f", mimeType: "image/jpeg" }), deps);
    await handleMessage(msg({ kind: "button", buttonId: "fb:up:log-1" }), deps);
    expect(assistant.answer).not.toHaveBeenCalled();
    expect(query.countSince).not.toHaveBeenCalled();
    expect(query.setFeedback).not.toHaveBeenCalled();
    expect(store.listExpenses).not.toHaveBeenCalled();
    expect(tg.sendText).not.toHaveBeenCalled();
    expect(tg.sendButtons).not.toHaveBeenCalled();
  });
});

describe("valoración 👍/👎", () => {
  it("guarda la valoración de quien la dio y agradece", async () => {
    const { tg, query, deps } = setup();
    await handleMessage(msg({ kind: "button", buttonId: "fb:down:log-1", text: undefined }), deps);
    expect(query.setFeedback).toHaveBeenCalledWith("log-1", "m1", "down");
    expect(tg.sendText).toHaveBeenCalledOnce();
  });

  it("si no se puede guardar la valoración, igual no revienta", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tg, query, deps } = setup();
    query.setFeedback.mockRejectedValue(new Error("db"));
    await handleMessage(msg({ kind: "button", buttonId: "fb:up:log-1", text: undefined }), deps);
    expect(tg.sendText).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("ignora valores inválidos", async () => {
    const { tg, query, deps } = setup();
    await handleMessage(msg({ kind: "button", buttonId: "fb:mal:log-1", text: undefined }), deps);
    await handleMessage(msg({ kind: "button", buttonId: "fb:up:", text: undefined }), deps);
    expect(query.setFeedback).not.toHaveBeenCalled();
    expect(tg.sendText).not.toHaveBeenCalled();
  });
});
