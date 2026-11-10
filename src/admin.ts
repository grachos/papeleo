import { createHmac } from "node:crypto";
import express, { type Request, type Response } from "express";
import { AttemptLimiter, safeEqual } from "./access.js";
import type { AdminPort } from "./types.js";

const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = "papeleo_admin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" }) : "—";

const STATUS: Record<string, string> = { activo: "Sin usar", usado: "Usado", revocado: "Revocado" };

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f24;--card:#fff;--line:#dfe3e8;--muted:#667085;--accent:#1f6feb;--danger:#c62828;--ok:#1b7f3b}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ee;--card:#1d2127;--line:#2e343c;--muted:#98a2b3;--accent:#5b9dff;--danger:#ef6b6b;--ok:#4cc27a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:.2rem 0 1rem}h2{font-size:1.1rem;margin:0 0 .75rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
label{display:block;font-size:.85rem;color:var(--muted);margin:.6rem 0 .2rem}
input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button.danger{background:var(--danger)}button.link{background:none;color:var(--muted);text-decoration:underline;padding:0}
.top{display:flex;justify-content:space-between;align-items:center}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.row{grid-template-columns:1fr}}
.tablewrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600}.muted{color:var(--muted)}.err{color:var(--danger)}
.code{font:600 1.6rem ui-monospace,monospace;letter-spacing:.08em;padding:12px;background:var(--bg);border:1px dashed var(--accent);border-radius:8px;text-align:center;user-select:all}
.badge{padding:2px 8px;border-radius:99px;border:1px solid var(--line);font-size:.8rem}.ok{color:var(--ok)}.bad{color:var(--danger)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export interface AdminOptions {
  store: AdminPort;
  password: string;
  /** Usuario del bot de Telegram, para armar el enlace de invitación. */
  botUsername?: () => string | null;
  now?: () => number;
}

export function createAdminRouter(opts: AdminOptions) {
  const now = opts.now ?? Date.now;
  const key = createHmac("sha256", "papeleo-admin-v1").update(opts.password).digest();
  const sign = (data: string) => createHmac("sha256", key).update(data).digest("hex");
  const loginLimiter = new AttemptLimiter(5, 15 * 60 * 1000, now);

  const newSession = () => {
    const exp = String(now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  };
  const validSession = (token: string | undefined): token is string => {
    if (!token) return false;
    const [exp, mac] = token.split(".");
    return Boolean(exp && mac && Number(exp) > now() && safeEqual(mac, sign(exp)));
  };
  const cookieOf = (req: Request) =>
    req.headers.cookie
      ?.split(";")
      .map((c) => c.trim().split("="))
      .find(([k]) => k === COOKIE)?.[1];
  const csrfOf = (session: string) => sign(`csrf:${session}`);

  const router = express.Router();
  router.use("/admin", (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });
  router.use("/admin", express.urlencoded({ extended: false, limit: "10kb" }));

  const loginPage = (res: Response, error?: string, status = 200) =>
    res.status(status).send(
      page(
        "Papeleo · Administración",
        `<h1>Papeleo · Administración</h1><form class="card" method="post" action="/admin/login">
         <label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
         ${error ? `<p class="err">${esc(error)}</p>` : ""}<p><button>Entrar</button></p></form>`,
      ),
    );

  async function dashboard(res: Response, session: string, notice = "") {
    const [orgs, codes, members] = await Promise.all([opts.store.listOrgs(), opts.store.listCodes(), opts.store.listMembers()]);
    const csrf = `<input type="hidden" name="csrf" value="${csrfOf(session)}">`;
    const codeRows = codes
      .map(
        (c) => `<tr><td>${esc(c.note || "—")}</td><td>${esc(c.org_name)}</td>
        <td><span class="badge ${c.status === "activo" ? "ok" : c.status === "revocado" ? "bad" : ""}">${STATUS[c.status]}</span></td>
        <td>${fmt(c.created_at)}</td><td>${fmt(c.used_at)}</td>
        <td>${c.status === "activo" ? `<form method="post" action="/admin/codes/${c.id}/revoke">${csrf}<button class="danger">Revocar</button></form>` : ""}</td></tr>`,
      )
      .join("");
    const memberRows = members
      .map(
        (m) => `<tr><td>${esc(m.name || "—")}</td><td class="muted">${esc(m.phone)}</td><td>${esc(m.org_name)}</td><td>${fmt(m.created_at)}</td>
        <td>${m.revoked_at ? `<span class="badge bad">Sin acceso desde ${fmt(m.revoked_at)}</span>` : `<span class="badge ok">Con acceso</span>`}</td>
        <td>${m.revoked_at ? "" : `<form method="post" action="/admin/members/${m.id}/revoke" onsubmit="return confirm('¿Quitar el acceso a esta persona?')">${csrf}<button class="danger">Quitar acceso</button></form>`}</td></tr>`,
      )
      .join("");

    res.send(
      page(
        "Papeleo · Administración",
        `<div class="top"><h1>Papeleo · Administración</h1>
         <form method="post" action="/admin/logout">${csrf}<button class="link">Salir</button></form></div>
         ${notice}
         <form class="card" method="post" action="/admin/codes"><h2>Crear código de acceso</h2>${csrf}
           <div class="row"><div><label for="o">Empresa</label><select id="o" name="orgId">
             <option value="">➕ Nueva empresa…</option>${orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</select></div>
           <div><label for="n">Nombre de la nueva empresa o cliente</label><input id="n" name="newOrgName" maxlength="80" placeholder="Solo si eliges «Nueva empresa»"></div></div>
           <label for="t">Nota (opcional): para quién es</label><input id="t" name="note" maxlength="80" placeholder="Ej.: Contadora, Juan Pérez">
           <p class="muted">El código sirve una sola vez y no vence. Solo tú puedes revocarlo.</p><button>Crear código</button></form>
         <div class="card"><h2>Códigos</h2><div class="tablewrap"><table><tr><th>Nota</th><th>Empresa</th><th>Estado</th><th>Creado</th><th>Usado</th><th></th></tr>${codeRows || '<tr><td colspan="6" class="muted">Aún no hay códigos.</td></tr>'}</table></div></div>
         <div class="card"><h2>Personas vinculadas</h2><div class="tablewrap"><table><tr><th>Nombre</th><th>Id</th><th>Empresa</th><th>Desde</th><th>Acceso</th><th></th></tr>${memberRows || '<tr><td colspan="6" class="muted">Nadie se ha vinculado todavía.</td></tr>'}</table></div></div>`,
      ),
    );
  }

  // Envuelve cada ruta autenticada: sesión válida y, en POST, token CSRF correcto.
  const guarded =
    (handler: (req: Request, res: Response, session: string) => Promise<void>) => async (req: Request, res: Response) => {
      const session = cookieOf(req);
      if (!validSession(session)) return void res.redirect(303, "/admin");
      if (req.method === "POST" && !safeEqual(String(req.body?.csrf ?? ""), csrfOf(session))) {
        return void res.status(403).send(page("Prohibido", "<h1>Solicitud no válida</h1><p><a href='/admin'>Volver</a></p>"));
      }
      try {
        await handler(req, res, session);
      } catch (err) {
        console.error("Fallo en el panel de administración", err);
        res.status(500).send(page("Error", "<h1>Algo salió mal</h1><p><a href='/admin'>Volver</a></p>"));
      }
    };

  // Sin sesión, /admin muestra el login (en vez de redirigir en bucle); con sesión, el panel.
  router.get("/admin", (req, res, next) => (validSession(cookieOf(req)) ? next() : loginPage(res)));
  router.get("/admin", guarded((_req, res, session) => dashboard(res, session)));

  router.post("/admin/login", (req, res) => {
    const ip = req.ip ?? "?";
    if (!loginLimiter.allowed(ip)) return void loginPage(res, "Demasiados intentos. Espera unos minutos.", 429);
    if (!safeEqual(String(req.body?.password ?? ""), opts.password)) {
      loginLimiter.fail(ip);
      return void loginPage(res, "Contraseña incorrecta.", 401);
    }
    loginLimiter.reset(ip);
    const secure = req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE}=${newSession()}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure}`);
    res.redirect(303, "/admin");
  });

  router.post(
    "/admin/logout",
    guarded(async (_req, res) => {
      res.set("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
      res.redirect(303, "/admin");
    }),
  );

  router.post(
    "/admin/codes",
    guarded(async (req, res, session) => {
      const orgId = String(req.body?.orgId ?? "");
      const newOrgName = String(req.body?.newOrgName ?? "").trim();
      if (orgId ? !UUID.test(orgId) : !newOrgName) {
        return void (await dashboard(res.status(400), session, `<p class="card err">Elige una empresa o escribe el nombre de la nueva.</p>`));
      }
      const { code, orgName } = await opts.store.createCode({
        orgId: orgId || undefined,
        newOrgName: newOrgName.slice(0, 80),
        note: String(req.body?.note ?? "").slice(0, 80),
      });
      const bot = opts.botUsername?.();
      const link = bot ? `https://t.me/${bot}?start=${code.replace(/-/g, "")}` : null;
      await dashboard(
        res,
        session,
        `<div class="card"><h2>Código creado para ${esc(orgName)}</h2><div class="code">${esc(code)}</div>
         <p class="err"><b>Cópialo ahora: no se vuelve a mostrar.</b> Sirve una sola vez.</p>
         <p>La persona debe escribirle el código al bot.${link ? ` O abrir este enlace:<br><b>${esc(link)}</b>` : ""}</p></div>`,
      );
    }),
  );

  router.post(
    "/admin/codes/:id/revoke",
    guarded(async (req, res) => {
      if (UUID.test(req.params.id)) await opts.store.revokeCode(req.params.id);
      res.redirect(303, "/admin");
    }),
  );

  router.post(
    "/admin/members/:id/revoke",
    guarded(async (req, res) => {
      if (UUID.test(req.params.id)) await opts.store.revokeMember(req.params.id);
      res.redirect(303, "/admin");
    }),
  );

  return router;
}
