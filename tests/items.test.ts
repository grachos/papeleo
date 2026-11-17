import { afterEach, describe, expect, it, vi } from "vitest";
import { runTool } from "../src/assistant.js";
import { checkItems } from "../src/items.js";
import { SupabaseStore } from "../src/store.js";
import type { Expense, QueryPort } from "../src/types.js";

const renglon = (valor_linea: number, descripcion = "Pan") => ({ descripcion, cantidad: 1, valor_unitario: valor_linea, valor_linea });

describe("checkItems: la suma de renglones contra el total", () => {
  it("cuadra con el total o con el subtotal (tolerancia de 1 peso)", () => {
    expect(checkItems([renglon(600), renglon(400)], 1000, null)).toEqual({ revisar: false, suma: 1000 });
    expect(checkItems([renglon(600), renglon(400.5)], 1000, null).revisar).toBe(false);
    expect(checkItems([renglon(838.7), renglon(161.3)], 1200, 1000).revisar).toBe(false); // cuadra con el subtotal
  });

  it("marca revisar cuando no cuadra con ninguno", () => {
    const r = checkItems([renglon(600), renglon(300)], 1000, 950);
    expect(r).toEqual({ revisar: true, suma: 900 });
  });

  it("sin renglones no marca nada", () => {
    expect(checkItems(null, 1000, null)).toEqual({ revisar: false, suma: 0 });
    expect(checkItems([], 1000, null)).toEqual({ revisar: false, suma: 0 });
  });
});

describe("almacén: los renglones se guardan aparte y sin romper el gasto", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("guarda el gasto y luego sus renglones con el id del gasto", async () => {
    const urls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: any) => {
      urls.push({ url: String(u), body: init?.body ? JSON.parse(init.body) : null });
      if (String(u).includes("papeleo_expenses")) {
        return new Response(JSON.stringify({ id: "g1", fecha: "2026-11-01", proveedor: "Pan", nit: null, numero_factura: null, subtotal: null, iva: null, total: 1000, moneda: "COP", categoria: "otros", medio_pago: null, descripcion: null, confianza: "alta" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 201 });
    }));
    const store = new SupabaseStore("http://db.local", "key", "b");
    const gasto = await store.saveExpense("o1", "m1", "d1", { fecha: "2026-11-01", proveedor: "Pan", nit: null, numero_factura: null, subtotal: null, iva: null, total: 1000, moneda: "COP", categoria: "otros", medio_pago: null, descripcion: null, confianza: "alta" } as never, [renglon(600, "Pan"), renglon(400, "Suero")]);
    expect(gasto.id).toBe("g1");
    const itemsCall = urls.find((u) => u.url.includes("papeleo_expense_items"));
    expect(itemsCall?.body).toEqual([
      expect.objectContaining({ org_id: "o1", expense_id: "g1", orden: 1, descripcion: "Pan", valor_linea: 600 }),
      expect.objectContaining({ org_id: "o1", expense_id: "g1", orden: 2, descripcion: "Suero", valor_linea: 400 }),
    ]);
  });

  it("si la tabla de renglones falla, el gasto se guarda igual (y el error queda en el log sin datos)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (String(u).includes("papeleo_expense_items")) return new Response(JSON.stringify({ code: "42P01", message: 'relation "papeleo_expense_items" does not exist' }), { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: "g2", fecha: "2026-11-01", proveedor: null, nit: null, numero_factura: null, subtotal: null, iva: null, total: 1000, moneda: "COP", categoria: "otros", medio_pago: null, descripcion: null, confianza: "alta" }), { status: 201, headers: { "content-type": "application/json" } });
    }));
    const gasto = await new SupabaseStore("http://db.local", "key", "b").saveExpense("o1", "m1", "d1", { fecha: "2026-11-01", proveedor: null, nit: null, numero_factura: null, subtotal: null, iva: null, total: 1000, moneda: "COP", categoria: "otros", medio_pago: null, descripcion: null, confianza: "alta" } as never, [renglon(1000)]);
    expect(gasto.id).toBe("g2");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Pan");
    spy.mockRestore();
  });
});

describe("el asistente ve los renglones y si cuadran con el total", () => {
  const base: Expense = { id: "00000000-0000-4000-8000-000000000001", fecha: "2026-11-03", proveedor: "Éxito", nit: null, numero_factura: null, subtotal: null, iva: null, total: 1000, moneda: "COP", categoria: "mercado_hogar", medio_pago: null, descripcion: null, confianza: "alta" };

  it("el detalle incluye renglones con su valor formateado y la indicación de cuadre", async () => {
    const query = { detalle: vi.fn(async () => ({ ...base, items: [renglon(600, "Pan"), renglon(300, "Suero")] })) } as unknown as QueryPort;
    const out: any = await runTool("detalle_gasto", { id: base.id }, "o1", query);
    expect(out.renglones).toHaveLength(2);
    expect(out.renglones[0]).toMatchObject({ descripcion: "Pan", valor_linea: 600 });
    expect(out.renglones_cuadran_con_el_total).toBe(false);
    expect(out.suma_de_renglones).toContain("900");
  });

  it("sin renglones lo dice con null, sin inventarlos", async () => {
    const query = { detalle: vi.fn(async () => ({ ...base, items: [] })) } as unknown as QueryPort;
    const out: any = await runTool("detalle_gasto", { id: base.id }, "o1", query);
    expect(out.renglones).toEqual([]);
    expect(out.renglones_cuadran_con_el_total).toBeNull();
  });
});
