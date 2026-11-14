import express, { type Request, type Response } from "express";
import { z } from "zod";
import { AttemptLimiter, INVITE_TOKEN_RE, WEB_IDLE_MINUTES, WEB_LOGIN_MINUTES, WEB_MAX_HOURS } from "./access.js";
import { CATEGORIAS } from "./extract.js";
import { moneyIn } from "./format.js";
import type { Expense, PanelFilters, PanelPort, PanelSession, QueryPort } from "./types.js";
import { esc, getCookie, page, SECURITY_HEADERS } from "./web.js";

const COOKIE = "papeleo_panel";
const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PanelOptions {
  store: PanelPort;
  query: Pick<QueryPort, "resumir" | "detalle">;
  now?: () => number;
}

// --- Parámetros de la lista: todo se valida; lo que no se conoce (p. ej. org_id) se ignora ---

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const validDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const date = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate).optional());
const text = z.preprocess(blank, z.string().trim().max(80).optional());
const Query = z.object({
  desde: date,
  hasta: date,
  categoria: z.preprocess(blank, z.enum(CATEGORIAS).optional()),
  proveedor: text,
  texto: text,
  pagina: z.preprocess(blank, z.coerce.number().int().min(1).max(10000).default(1)),
});

const label = (cat: string) => esc(cat.replace(/_/g, " "));

const SALIR = `<form method="post" action="/panel/salir"><button class="link">Salir</button></form>`;

/**
 * Panel web de solo lectura. Solo se entra con el enlace de un solo uso que entrega el bot (`/panel/entrar/<token>`).
 * - La empresa sale únicamente de la sesión guardada en la base; ningún parámetro de la petición la puede cambiar.
 * - Todo texto que viene de las facturas se escapa. Sin scripts ni recursos externos; sin caché; sin referer.
 */
export function createPanelRouter(opts: PanelOptions) {
  const now = opts.now ?? Date.now;
  const loginLimiter = new AttemptLimiter(10, 15 * 60 * 1000, now);
  const router = express.Router();

  router.use("/panel", (_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  const simple = (res: Response, status: number, title: string, body: string) =>
    res.status(status).send(page(`Papeleo · ${title}`, `<h1>Papeleo</h1><div class="card">${body}</div>`));

  const noSession = (res: Response) =>
    simple(res, 401, "Panel", `<p>Para ver tus facturas, abre el panel desde Telegram: escríbele <b>panel</b> al bot.</p>`);
  const invalidLink = (res: Response, status = 404) =>
    simple(res, status, "Panel", `<p class="err">Este enlace no es válido o ya no sirve (venció o ya se usó). Pídele otro al bot escribiendo <b>panel</b>.</p>`);
  const failure = (res: Response) =>
    simple(res, 500, "Panel", `<p class="err">Algo salió mal. Inténtalo de nuevo en unos minutos.</p>`);

  const clearCookie = (res: Response) =>
    res.append("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/panel; Max-Age=0`);

  /** Resuelve la sesión de la petición (y la prolonga). Responde 401 si no hay una vigente. */
  async function authenticate(req: Request, res: Response): Promise<{ session: PanelSession; token: string } | null> {
    const token = getCookie(req.headers.cookie, COOKIE);
    if (token && INVITE_TOKEN_RE.test(token)) {
      const session = await opts.store.session(token);
      if (session) return { session, token };
    }
    clearCookie(res);
    noSession(res);
    return null;
  }

  // --- Entrada: el GET solo muestra el botón (los previsualizadores abren los enlaces); el POST abre la sesión ---

  router.get("/panel/entrar/:token", (req, res) => {
    if (!INVITE_TOKEN_RE.test(req.params.token)) return void invalidLink(res);
    res.send(
      page(
        "Papeleo · Panel",
        `<h1>Papeleo</h1><form class="card" method="post" action="/panel/entrar/${esc(req.params.token)}">
         <h2>Tu panel de facturas</h2>
         <p>Es una vista de <b>solo lectura</b>. Este enlace sirve una sola vez y venció a los ${WEB_LOGIN_MINUTES} minutos de pedirlo.
         La sesión se cierra tras ${WEB_IDLE_MINUTES} minutos sin usarla.</p>
         <button>Abrir mi panel</button></form>`,
      ),
    );
  });

  router.post("/panel/entrar/:token", async (req, res) => {
    const ip = req.ip ?? "?";
    if (!loginLimiter.allowed(ip)) return void invalidLink(res, 429);
    if (!INVITE_TOKEN_RE.test(req.params.token)) {
      loginLimiter.fail(ip);
      return void invalidLink(res);
    }
    let session: string | null;
    try {
      session = await opts.store.consumeLogin(req.params.token);
    } catch (err) {
      console.error("Fallo abriendo una sesión del panel", err instanceof Error ? err.message : "error");
      return void failure(res);
    }
    if (!session) {
      loginLimiter.fail(ip);
      return void invalidLink(res);
    }
    const secure = req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/panel; Max-Age=${WEB_MAX_HOURS * 3600}${secure}`);
    res.redirect(303, "/panel");
  });

  router.post("/panel/salir", async (req, res) => {
    const token = getCookie(req.headers.cookie, COOKIE);
    if (token && INVITE_TOKEN_RE.test(token)) {
      await opts.store.endSession(token).catch((err) => console.error("Fallo cerrando la sesión del panel", err instanceof Error ? err.message : "error"));
    }
    clearCookie(res);
    simple(res, 200, "Panel", `<p>Sesión cerrada. Para volver, escríbele <b>panel</b> al bot en Telegram.</p>`);
  });

  // --- Resumen y lista ---

  router.get("/panel", async (req, res) => {
    try {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const { orgId, orgName } = auth.session;

      const parsed = Query.safeParse(req.query);
      if (!parsed.success) {
        return void simple(res, 400, "Panel", `<p class="err">Alguno de los filtros no es válido.</p><p><a href="/panel">Quitar los filtros</a></p>`);
      }
      const { pagina, ...f } = parsed.data;
      const filters: PanelFilters = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
      const base = { medida: "suma", orden: "valor_desc", limite: 24, campo: "total", ...filters };

      const [lista, totales, porMes, porCategoria] = await Promise.all([
        opts.store.list(orgId, filters, pagina, PAGE_SIZE),
        opts.query.resumir(orgId, { ...base, agrupar: "ninguno", limite: 12 }),
        opts.query.resumir(orgId, { ...base, agrupar: "mes", orden: "grupo_desc", limite: 12 }),
        opts.query.resumir(orgId, { ...base, agrupar: "categoria" }),
      ]);

      const pages = Math.max(1, Math.ceil(lista.total / PAGE_SIZE));
      const qs = (p: number) => {
        const q = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]));
        if (p > 1) q.set("pagina", String(p));
        const s = q.toString();
        return `/panel${s ? `?${s}` : ""}`;
      };

      const cards = totales.length
        ? totales.map((t) => `<div><div class="muted">Total ${esc(t.moneda)}</div><div class="code" style="font-size:1.3rem">${esc(moneyIn(t.valor, t.moneda))}</div><div class="muted">${t.cantidad} facturas</div></div>`).join("")
        : `<p class="muted">No hay facturas con esos filtros.</p>`;
      const grupos = (rows: typeof porMes, titulo: string, nombre: (g: string) => string) =>
        `<div class="card"><h2>${titulo}</h2><div class="tablewrap"><table><tr><th>${titulo.split(" ").pop()}</th><th>Total</th><th>Facturas</th></tr>${
          rows.map((r) => `<tr><td>${nombre(r.grupo)}</td><td>${esc(moneyIn(r.valor, r.moneda))}</td><td>${r.cantidad}</td></tr>`).join("") ||
          '<tr><td colspan="3" class="muted">Sin datos.</td></tr>'
        }</table></div></div>`;
      const filas = lista.rows
        .map(
          (e) => `<tr><td>${esc(e.fecha)}</td><td>${esc(e.proveedor || "—")}</td><td>${label(e.categoria)}</td><td>${esc(moneyIn(e.total, e.moneda))}</td>
          <td><a href="/panel/factura/${esc(e.id)}">Ver</a></td></tr>`,
        )
        .join("");
      const opcionesCategoria = CATEGORIAS.map((c) => `<option value="${c}"${filters.categoria === c ? " selected" : ""}>${label(c)}</option>`).join("");

      res.send(
        page(
          "Papeleo · Panel",
          `<div class="top"><h1>${esc(orgName)}</h1>${SALIR}</div>
           <p class="muted">Vista de solo lectura de las facturas de tu empresa.</p>
           <form class="card" method="get" action="/panel"><h2>Filtros</h2>
             <div class="row"><div><label for="d">Desde</label><input id="d" type="date" name="desde" value="${esc(filters.desde)}"></div>
             <div><label for="h">Hasta</label><input id="h" type="date" name="hasta" value="${esc(filters.hasta)}"></div></div>
             <div class="row"><div><label for="c">Categoría</label><select id="c" name="categoria"><option value="">Todas</option>${opcionesCategoria}</select></div>
             <div><label for="p">Proveedor</label><input id="p" name="proveedor" maxlength="80" value="${esc(filters.proveedor)}"></div></div>
             <label for="t">Texto en el proveedor o la descripción</label><input id="t" name="texto" maxlength="80" value="${esc(filters.texto)}">
             <p><button>Filtrar</button> <a href="/panel">Quitar filtros</a></p></form>
           <div class="card"><h2>Total del periodo</h2><div class="row">${cards}</div></div>
           ${grupos(porMes, "Total por mes", (g) => esc(g))}
           ${grupos(porCategoria, "Total por categoría", (g) => label(g))}
           <div class="card"><h2>Facturas (${lista.total})</h2><div class="tablewrap"><table><tr><th>Fecha</th><th>Proveedor</th><th>Categoría</th><th>Total</th><th></th></tr>${
             filas || '<tr><td colspan="5" class="muted">No hay facturas con esos filtros.</td></tr>'
           }</table></div>
           <p>${pagina > 1 ? `<a href="${esc(qs(pagina - 1))}">← Anterior</a>` : ""} Página ${pagina} de ${pages}
           ${pagina < pages ? `<a href="${esc(qs(pagina + 1))}">Siguiente →</a>` : ""}</p></div>`,
        ),
      );
    } catch (err) {
      console.error("Fallo en el panel", err instanceof Error ? err.message : "error");
      failure(res);
    }
  });

  // --- Detalle de una factura ---

  router.get("/panel/factura/:id", async (req, res) => {
    try {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const e: Expense | null = UUID.test(req.params.id) ? await opts.query.detalle(auth.session.orgId, req.params.id) : null;
      if (!e) {
        return void simple(res, 404, "Panel", `<p>No encontré esa factura.</p><p><a href="/panel">Volver al panel</a></p>`);
      }
      const dato = (nombre: string, valor: string | null | undefined) =>
        `<tr><th>${nombre}</th><td>${valor ? esc(valor) : '<span class="muted">—</span>'}</td></tr>`;
      res.send(
        page(
          "Papeleo · Factura",
          `<div class="top"><h1>Factura</h1>${SALIR}</div>
           <div class="card"><div class="tablewrap"><table>
             ${dato("Fecha", e.fecha)}${dato("Proveedor", e.proveedor)}${dato("NIT", e.nit)}${dato("Número de factura", e.numero_factura)}
             ${dato("Subtotal", e.subtotal === null ? null : moneyIn(e.subtotal, e.moneda))}${dato("IVA", e.iva === null ? null : moneyIn(e.iva, e.moneda))}
             ${dato("Total", moneyIn(e.total, e.moneda))}${dato("Categoría", e.categoria.replace(/_/g, " "))}${dato("Medio de pago", e.medio_pago)}
             ${dato("Descripción", e.descripcion)}${dato("Confianza de la lectura", e.confianza)}
           </table></div>
           <p class="muted">Los archivos originales (foto o PDF) todavía no se pueden ver desde el panel.</p>
           <p><a href="/panel">← Volver al panel</a></p></div>`,
        ),
      );
    } catch (err) {
      console.error("Fallo en el panel", err instanceof Error ? err.message : "error");
      failure(res);
    }
  });

  return router;
}
