import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseStore } from "../src/store.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("listInvitations: nunca manda un filtro IN vacío", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("una invitación recién creada (sin ticket ni vinculación) carga la lista sin pedir ids vacíos", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      if (String(u).includes("papeleo_invitations")) {
        return json([{ id: "i1", org_id: "o1", note: "n", status: "activa", expires_at: "2099-01-01T00:00:00Z", ticket_id: null, used_member_id: null, used_at: null, created_at: "2026-11-17T00:00:00Z" }]);
      }
      return json([]);
    }));
    const lista = await new SupabaseStore("http://db.local", "key", "b").listInvitations();
    expect(lista).toHaveLength(1);
    expect(lista[0].state).toBe("pendiente");
    expect(urls.some((u) => u.includes("in.()"))).toBe(false);
    expect(urls.some((u) => u.includes("papeleo_access_codes"))).toBe(false); // sin ticket, no se consulta
  });
});
