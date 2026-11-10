import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseStore } from "../src/store.js";

const usage = { model: "claude-opus-5-5", tokensIn: 2100, tokensOut: 900 };
const json = (status: number, body: unknown = null) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("SupabaseStore.finishDocument: consumo de la lectura", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("guarda el estado y, aparte, el modelo y los tokens", async () => {
    const fetchMock = vi.fn(async () => json(204));
    vi.stubGlobal("fetch", fetchMock);
    await new SupabaseStore("http://db.local", "key", "b").finishDocument("d1", "procesado", undefined, usage);

    const bodies = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ status: "procesado" });
    expect(bodies[1]).toEqual({ extraction_model: "claude-opus-5-5", tokens_in: 2100, tokens_out: 900 });
  });

  it("sin consumo no hace una segunda llamada", async () => {
    const fetchMock = vi.fn(async () => json(204));
    vi.stubGlobal("fetch", fetchMock);
    await new SupabaseStore("http://db.local", "key", "b").finishDocument("d1", "error");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("si no se puede guardar el consumo (p. ej. migración sin aplicar), la factura igual se procesa", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(204))
      .mockResolvedValueOnce(json(400, { code: "42703", message: 'column "tokens_in" does not exist' }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new SupabaseStore("http://db.local", "key", "b").finishDocument("d1", "procesado", undefined, usage)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("No se pudo registrar el consumo de la lectura", expect.anything());
    spy.mockRestore();
  });

  it("pero si falla guardar el estado, sí se propaga el error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { message: "boom" })));
    await expect(new SupabaseStore("http://db.local", "key", "b").finishDocument("d1", "procesado", undefined, usage)).rejects.toBeTruthy();
  });
});
