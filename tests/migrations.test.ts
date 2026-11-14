import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Ejecuta las migraciones REALES contra un Postgres de verdad (PGlite, en memoria): ninguna base compartida se toca.
const sql = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");

let db: PGlite;
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
let n = 0;
const ORG_L = "eeeeeeee-0000-4000-8000-000000000005";
const LEGACY_HASH = randomBytes(16).toString("hex");
const rnd = () => randomBytes(16).toString("hex"); // «hashes» aleatorios en cada corrida

async function seedOrg(org: string) {
  await db.query("insert into papeleo_organizations (id, name) values ($1, $2)", [org, `Empresa ${org.slice(0, 1)}`]);
  await db.query("insert into papeleo_members (id, org_id, phone) values ($1, $2, $3)", [org.replace(/^./, "c"), org, `tg:${org.slice(0, 1)}`]);
}

async function expense(org: string, e: { fecha: string; proveedor?: string | null; total: number; moneda?: string; categoria?: string; estado?: string; descripcion?: string; subtotal?: number; iva?: number }) {
  n += 1;
  const member = org.replace(/^./, "c");
  const doc = await db.query<{ id: string }>(
    "insert into papeleo_documents (org_id, member_id, wa_message_id, mime_type) values ($1, $2, $3, 'image/jpeg') returning id",
    [org, member, `m${n}`],
  );
  await db.query(
    `insert into papeleo_expenses (org_id, member_id, document_id, fecha, proveedor, total, moneda, categoria, estado, descripcion, subtotal, iva, confianza)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'alta')`,
    [org, member, doc.rows[0].id, e.fecha, e.proveedor ?? null, e.total, e.moneda ?? "COP", e.categoria ?? "otros", e.estado ?? "registrado", e.descripcion ?? null, e.subtotal ?? null, e.iva ?? null],
  );
}

const resumir = (org: string, over: Record<string, unknown> = {}) => {
  const a = { medida: "suma", agrupar: "ninguno", desde: null, hasta: null, categoria: null, proveedor: null, texto: null, vmin: null, vmax: null, moneda: null, orden: "valor_desc", limite: 12, campo: "total", ...over };
  return db.query<any>("select * from papeleo_resumir($1::uuid,$2,$3,$4::date,$5::date,$6,$7,$8,$9::numeric,$10::numeric,$11,$12,$13::int,$14)", [org, a.medida, a.agrupar, a.desde, a.hasta, a.categoria, a.proveedor, a.texto, a.vmin, a.vmax, a.moneda, a.orden, a.limite, a.campo]);
};
const listar = (org: string, over: Record<string, unknown> = {}) => {
  const a = { desde: null, hasta: null, categoria: null, proveedor: null, texto: null, vmin: null, vmax: null, moneda: null, orden: "fecha_desc", limite: 10, ...over };
  return db.query<any>("select * from papeleo_listar($1::uuid,$2::date,$3::date,$4,$5,$6,$7::numeric,$8::numeric,$9,$10,$11::int)", [org, a.desde, a.hasta, a.categoria, a.proveedor, a.texto, a.vmin, a.vmax, a.moneda, a.orden, a.limite]);
};

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto, unaccent } });
  // Piezas de Supabase que las migraciones suponen.
  await db.exec(`
    create schema extensions; create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean);
    create role anon; create role authenticated; create role service_role;`);
  await db.exec(sql("0001_init.sql"));
  await db.exec(sql("0002_access_codes.sql"));
  await db.exec(sql("0004_query_assistant.sql"));
  await db.exec(sql("0005_harden_like_escape.sql"));
  await db.exec(sql("0006_extraction_usage.sql"));

  // Un código anterior sin usar (de los que no vencían), creado antes de la migración 0008.
  await db.query("insert into papeleo_organizations (id, name) values ($1, 'Empresa L')", [ORG_L]);
  await db.query("insert into papeleo_access_codes (org_id, code_hash) values ($1, $2)", [ORG_L, LEGACY_HASH]);
  await db.exec(sql("0008_invitations_tickets.sql"));

  await seedOrg(ORG_A);
  await seedOrg(ORG_B);
  await expense(ORG_A, { fecha: "2026-10-05", proveedor: "Éxito", total: 100000, categoria: "mercado_hogar", subtotal: 84034, iva: 15966 });
  await expense(ORG_A, { fecha: "2026-10-20", proveedor: "EXITO S.A.", total: 50000, categoria: "mercado_hogar" });
  await expense(ORG_A, { fecha: "2026-11-02", proveedor: "Terpel", total: 80000, categoria: "combustible", descripcion: "Gasolina corriente", subtotal: 67227, iva: 12773 });
  await expense(ORG_A, { fecha: "2026-11-03", proveedor: "Hotel Sol", total: 30, moneda: "USD", categoria: "hospedaje" });
  await expense(ORG_A, { fecha: "2026-11-04", proveedor: "Borrado", total: 999999, estado: "descartado" });
  await expense(ORG_B, { fecha: "2026-11-02", proveedor: "Éxito", total: 7000000 });
}, 60_000);

afterAll(() => db.close());

describe("papeleo_resumir", () => {
  it("suma solo la empresa pedida, ignora descartados y no mezcla monedas", async () => {
    const r = await resumir(ORG_A);
    const por = Object.fromEntries(r.rows.map((x: any) => [x.moneda, Number(x.valor)]));
    expect(por).toEqual({ COP: 230000, USD: 30 });
  });

  it("agrupa por mes en orden cronológico", async () => {
    const r = await resumir(ORG_A, { agrupar: "mes", moneda: "COP", orden: "grupo_asc" });
    expect(r.rows.map((x: any) => [x.grupo, Number(x.valor)])).toEqual([["2026-10", 150000], ["2026-11", 80000]]);
  });

  it("agrupa un mismo proveedor aunque cambien las mayúsculas o las tildes", async () => {
    const ORG_C = "dddddddd-0000-4000-8000-000000000004";
    await seedOrg(ORG_C);
    await expense(ORG_C, { fecha: "2026-11-01", proveedor: "Éxito", total: 10 });
    await expense(ORG_C, { fecha: "2026-11-02", proveedor: "EXITO", total: 20 });
    await expense(ORG_C, { fecha: "2026-11-03", proveedor: "éxito", total: 30 });
    await expense(ORG_C, { fecha: "2026-11-04", proveedor: "Terpel", total: 5 });
    const r = await resumir(ORG_C, { agrupar: "proveedor" });
    expect(r.rows).toHaveLength(2);
    expect(Number(r.rows[0].valor)).toBe(60);
  });

  it("calcula cuenta, promedio, máximo y mínimo", async () => {
    const q = async (medida: string) => Number((await resumir(ORG_A, { medida, moneda: "COP" })).rows[0].valor);
    expect(await q("cuenta")).toBe(3);
    expect(await q("promedio")).toBeCloseTo(76666.67, 1);
    expect(await q("maximo")).toBe(100000);
    expect(await q("minimo")).toBe(50000);
  });

  it("filtra por fechas, categoría y texto sin importar tildes", async () => {
    expect(Number((await resumir(ORG_A, { desde: "2026-11-01", hasta: "2026-11-30", moneda: "COP" })).rows[0].valor)).toBe(80000);
    expect(Number((await resumir(ORG_A, { categoria: "combustible" })).rows[0].valor)).toBe(80000);
    expect(Number((await resumir(ORG_A, { proveedor: "exito", moneda: "COP" })).rows[0].valor)).toBe(150000);
    expect(Number((await resumir(ORG_A, { texto: "GASOLINA" })).rows[0].valor)).toBe(80000);
  });

  it("trata % y _ como caracteres normales (no comodines)", async () => {
    expect((await resumir(ORG_A, { proveedor: "%" })).rows).toHaveLength(0);
    expect((await resumir(ORG_A, { proveedor: "_" })).rows).toHaveLength(0);
  });

  it("una empresa que no existe devuelve vacío, y la otra empresa no ve nada ajeno", async () => {
    expect((await resumir("11111111-1111-4111-8111-111111111111")).rows).toHaveLength(0);
    expect(Number((await resumir(ORG_B)).rows[0].valor)).toBe(7000000);
  });

  it("suma el IVA y el subtotal, e informa cuántas facturas traen ese dato", async () => {
    const iva = (await resumir(ORG_A, { campo: "iva", moneda: "COP" })).rows[0];
    expect(Number(iva.valor)).toBe(15966 + 12773);
    expect(Number(iva.cantidad)).toBe(3); // tres facturas en COP…
    expect(Number(iva.con_dato)).toBe(2); // …pero solo dos traen IVA
    const sub = (await resumir(ORG_A, { campo: "subtotal", moneda: "COP" })).rows[0];
    expect(Number(sub.valor)).toBe(84034 + 67227);
  });

  it("rechaza medida, agrupación, orden y campo fuera de la lista", async () => {
    await expect(resumir(ORG_A, { campo: "total; select 1" })).rejects.toThrow("campo_invalido");
    await expect(resumir(ORG_A, { medida: "suma; drop table papeleo_expenses" })).rejects.toThrow("medida_invalida");
    await expect(resumir(ORG_A, { agrupar: "fecha" })).rejects.toThrow("agrupar_invalido");
    await expect(resumir(ORG_A, { orden: "x" })).rejects.toThrow("orden_invalido");
  });

  it("limita los grupos devueltos e informa cuántos hay", async () => {
    const r = await resumir(ORG_A, { agrupar: "proveedor", moneda: "COP", limite: 1 });
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].total_grupos)).toBe(3);
  });
});

describe("papeleo_listar", () => {
  it("ordena, filtra y nunca devuelve gastos de otra empresa ni descartados", async () => {
    const r = await listar(ORG_A, { orden: "total_desc", moneda: "COP" });
    expect(r.rows.map((x: any) => Number(x.total))).toEqual([100000, 80000, 50000]);
    expect(r.rows.every((x: any) => x.proveedor !== "Borrado")).toBe(true);
  });

  it("devuelve el subtotal y el IVA de cada factura (no \"null\" por omisión)", async () => {
    const r = await listar(ORG_A, { proveedor: "terpel" });
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].iva)).toBe(12773);
    expect(Number(r.rows[0].subtotal)).toBe(67227);
  });

  it("topa el límite en 20 e informa el total de coincidencias", async () => {
    for (let i = 0; i < 25; i++) await expense(ORG_B, { fecha: "2026-09-01", proveedor: `P${i}`, total: 10 });
    const r = await listar(ORG_B, { limite: 100, desde: "2026-09-01", hasta: "2026-09-30" });
    expect(r.rows).toHaveLength(20);
    expect(Number(r.rows[0].total_filas)).toBe(25);
  });
});

describe("consumo de la lectura (0006)", () => {
  it("papeleo_documents guarda modelo y tokens, y los documentos viejos quedan en null", async () => {
    const r = await db.query<any>("select extraction_model, tokens_in, tokens_out from papeleo_documents order by created_at limit 1");
    expect(r.rows[0]).toEqual({ extraction_model: null, tokens_in: null, tokens_out: null });
    await db.query("update papeleo_documents set extraction_model = 'claude-opus-5-5', tokens_in = 2100, tokens_out = 900 where id = (select id from papeleo_documents limit 1)");
    const costo = await db.query<any>("select round(sum(tokens_in) * 4.0 / 1e6 + sum(tokens_out) * 20.0 / 1e6, 4) as usd from papeleo_documents where tokens_in is not null");
    expect(Number(costo.rows[0].usd)).toBeCloseTo(0.0264, 4);
  });
});

describe("tickets e invitaciones (0008)", () => {
  const ORG_T = "ffffffff-0000-4000-8000-000000000006";
  let seeded = false;
  const seed = async () => {
    if (seeded) return;
    await db.query("insert into papeleo_organizations (id, name) values ($1, 'Empresa T')", [ORG_T]);
    seeded = true;
  };
  const invitation = async (expires = "now() + interval '24 hours'") => {
    await seed();
    const token = rnd();
    const r = await db.query<any>(`insert into papeleo_invitations (org_id, token_hash, note, expires_at) values ($1, $2, 'nota', ${expires}) returning id`, [ORG_T, token]);
    return { id: r.rows[0].id as string, token };
  };
  const issue = (token: string, ticket: string, mins = 15) => db.query<any>("select * from papeleo_issue_ticket($1, $2, $3::int)", [token, ticket, mins]);
  const redeem = (ticket: string, phone: string) => db.query<any>("select * from papeleo_redeem_code($1, $2, 'Ana')", [ticket, phone]);
  const inv = async (id: string) => (await db.query<any>("select * from papeleo_invitations where id = $1", [id])).rows[0];

  it("retira los códigos anteriores que no vencían y seguían sin usar", async () => {
    const r = await db.query<any>("select status from papeleo_access_codes where code_hash = $1", [LEGACY_HASH]);
    expect(r.rows[0].status).toBe("revocado");
    expect((await redeem(LEGACY_HASH, "tg:legacy")).rows).toHaveLength(0);
  });

  it("emite un ticket de 15 minutos y se canjea una sola vez", async () => {
    const { id, token } = await invitation();
    const ticket = rnd();
    const out = await issue(token, ticket);
    expect(out.rows[0].r_org_name).toBe("Empresa T");
    const minutos = (new Date(out.rows[0].r_expires_at).getTime() - Date.now()) / 60000;
    expect(minutos).toBeGreaterThan(14);
    expect(minutos).toBeLessThanOrEqual(15);

    const first = await redeem(ticket, "tg:ana1");
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].r_org_name).toBe("Empresa T");
    expect((await redeem(ticket, "tg:otra")).rows).toHaveLength(0); // un solo uso

    // al vincularse, la invitación se gasta y no puede generar más tickets
    const row = await inv(id);
    expect(row.status).toBe("usada");
    expect(row.used_member_id).toBe(first.rows[0].r_member_id);
    expect((await issue(token, rnd())).rows).toHaveLength(0);
  });

  it("un ticket vencido no se puede canjear", async () => {
    const { token } = await invitation();
    const ticket = rnd();
    await issue(token, ticket);
    await db.query("update papeleo_access_codes set expires_at = now() - interval '1 second' where code_hash = $1", [ticket]);
    expect((await redeem(ticket, "tg:tarde")).rows).toHaveLength(0);
  });

  it("generar otro ticket deja sin efecto el anterior (y si se pasa el tiempo se puede volver a intentar)", async () => {
    const { id, token } = await invitation();
    const viejo = rnd();
    const nuevo = rnd();
    await issue(token, viejo);
    await db.query("update papeleo_access_codes set expires_at = now() - interval '1 minute' where code_hash = $1", [viejo]);
    expect((await issue(token, nuevo)).rows).toHaveLength(1); // la invitación sigue vigente
    expect((await redeem(viejo, "tg:rot1")).rows).toHaveLength(0);
    expect((await inv(id)).status).toBe("activa"); // el intento fallido no la gasta
    expect((await redeem(nuevo, "tg:rot1")).rows).toHaveLength(1);

    const a = rnd();
    const b = rnd();
    const dos = await invitation();
    await issue(dos.token, a);
    await issue(dos.token, b); // renueva sin esperar a que venza
    expect((await redeem(a, "tg:rot2")).rows).toHaveLength(0);
    expect((await redeem(b, "tg:rot2")).rows).toHaveLength(1);
  });

  it("revocar la invitación deja sin efecto su ticket vigente y ya no emite más", async () => {
    const { id, token } = await invitation();
    const ticket = rnd();
    await issue(token, ticket);
    await db.query("select papeleo_revoke_invitation($1)", [id]);
    expect((await inv(id)).status).toBe("revocada");
    expect((await redeem(ticket, "tg:rev")).rows).toHaveLength(0);
    expect((await issue(token, rnd())).rows).toHaveLength(0);
  });

  it("una invitación vencida no emite tickets, y el ticket nunca dura más que ella", async () => {
    const vieja = await invitation("now() - interval '1 minute'");
    expect((await issue(vieja.token, rnd())).rows).toHaveLength(0);

    const corta = await invitation("now() + interval '5 minutes'");
    const out = await issue(corta.token, rnd());
    const minutos = (new Date(out.rows[0].r_expires_at).getTime() - Date.now()) / 60000;
    expect(minutos).toBeLessThanOrEqual(5);
  });

  it("no emite con un token desconocido ni con minutos fuera de rango", async () => {
    expect((await issue(rnd(), rnd())).rows).toHaveLength(0);
    const { token } = await invitation();
    await expect(issue(token, rnd(), 0)).rejects.toThrow("minutos_invalidos");
    await expect(issue(token, rnd(), 61)).rejects.toThrow("minutos_invalidos");
  });

  it("una persona ya vinculada no puede canjear otro ticket, y el ticket no se pierde", async () => {
    const a = await invitation();
    const t1 = rnd();
    await issue(a.token, t1);
    await redeem(t1, "tg:doble");
    const b = await invitation();
    const t2 = rnd();
    await issue(b.token, t2);
    await expect(redeem(t2, "tg:doble")).rejects.toThrow("ya_vinculado");
    expect((await inv(b.id)).status).toBe("activa"); // revertido: la invitación sigue vigente
    expect((await redeem(t2, "tg:distinta")).rows).toHaveLength(1);
  });

  it("anon y authenticated no pueden ejecutar ninguna función; service_role sí", async () => {
    const fns = [
      "papeleo_issue_ticket(text, text, integer)",
      "papeleo_revoke_invitation(uuid)",
      "papeleo_redeem_code(text, text, text)",
    ];
    for (const fn of fns) {
      for (const [role, esperado] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
        const r = await db.query<any>(`select has_function_privilege('${role}', '${fn}', 'execute') as ok`);
        expect([role, fn, r.rows[0].ok]).toEqual([role, fn, esperado]);
      }
    }
    const rls = await db.query<any>("select relrowsecurity from pg_class where relname = 'papeleo_invitations'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});

describe("permisos", () => {
  it("anon y authenticated no pueden ejecutar las funciones; service_role sí", async () => {
    const sig = "papeleo_resumir(uuid, text, text, date, date, text, text, text, numeric, numeric, text, text, integer, text)";
    const priv = async (role: string, fn: string) => (await db.query<any>(`select has_function_privilege('${role}', '${fn}', 'execute') as ok`)).rows[0].ok;
    for (const fn of [sig, "papeleo_listar(uuid, date, date, text, text, text, numeric, numeric, text, text, integer)"]) {
      expect(await priv("anon", fn)).toBe(false);
      expect(await priv("authenticated", fn)).toBe(false);
      expect(await priv("service_role", fn)).toBe(true);
    }
  });

  it("papeleo_like_escape tiene search_path fijo y sigue escapando bien", async () => {
    const cfg = await db.query<any>("select proconfig from pg_proc where proname = 'papeleo_like_escape'");
    expect(cfg.rows[0].proconfig).toEqual(["search_path=\"\""]);
    const out = await db.query<any>("select papeleo_like_escape('a%b_c\\d') as v");
    expect(out.rows[0].v).toBe("a\\%b\\_c\\\\d");
    // y las búsquedas que dependen de ella siguen funcionando
    expect((await resumir(ORG_A, { proveedor: "%" })).rows).toHaveLength(0);
    expect(Number((await resumir(ORG_A, { proveedor: "exito", moneda: "COP" })).rows[0].valor)).toBe(150000);
  });

  it("las funciones son SECURITY INVOKER y papeleo_query_log tiene RLS", async () => {
    const r = await db.query<any>("select proname, prosecdef from pg_proc where proname in ('papeleo_resumir','papeleo_listar')");
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((x: any) => x.prosecdef === false)).toBe(true);
    const rls = await db.query<any>("select relrowsecurity from pg_class where relname = 'papeleo_query_log'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});
