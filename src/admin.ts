import { createHmac } from "node:crypto";
import express, { type Request, type Response } from "express";
import { AttemptLimiter, INVITATION_TTL_HOURS, safeEqual, TICKET_TTL_MINUTES } from "./access.js";
import type { AdminInvitation, AdminPort } from "./types.js";
import { esc, fmt, hora, page, SECURITY_HEADERS } from "./web.js";

const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = "papeleo_admin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminOptions {
  store: AdminPort;
  password: string;
  /** Usuario del bot de Telegram. */
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
    res.set(SECURITY_HEADERS);
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
    const [orgs, invitations, members] = await Promise.all([opts.store.listOrgs(), opts.store.listInvitations(), opts.store.listMembers()]);
    const csrf = `<input type="hidden" name="csrf" value="${csrfOf(session)}">`;
    const stateBadge = (i: AdminInvitation) => {
      switch (i.state) {
        case "pendiente":
          return `<span class="badge">Pendiente · vence ${fmt(i.expires_at)}</span>`;
        case "ticket":
          return `<span class="badge ok">Ticket emitido · sirve hasta ${hora(i.ticket_expires_at!)}</span>`;
        case "vinculada":
          return `<span class="badge ok">Vinculada${i.linked_name ? ` · ${esc(i.linked_name)}` : ""}</span>`;
        case "vencida":
          return `<span class="badge">Vencida</span>`;
        case "revocada":
          return `<span class="badge bad">Revocada</span>`;
      }
    };
    const invitationRows = invitations
      .map(
        (i) => `<tr><td>${esc(i.note || "—")}</td><td>${esc(i.org_name)}</td><td>${stateBadge(i)}</td>
        <td>${fmt(i.created_at)}</td><td>${fmt(i.linked_at)}</td>
        <td>${i.state === "pendiente" || i.state === "ticket" ? `<form method="post" action="/admin/invitations/${i.id}/revoke">${csrf}<button class="danger">Revocar</button></form>` : ""}</td></tr>`,
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
         <form class="card" method="post" action="/admin/invitations"><h2>Crear enlace de acceso</h2>${csrf}
           <div class="row"><div><label for="o">Empresa</label><select id="o" name="orgId">
             <option value="">➕ Nueva empresa…</option>${orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</select></div>
           <div><label for="n">Nombre de la nueva empresa o cliente</label><input id="n" name="newOrgName" maxlength="80" placeholder="Solo si eliges «Nueva empresa»"></div></div>
           <label for="t">Nota (opcional): para quién es</label><input id="t" name="note" maxlength="80" placeholder="Ej.: Contadora, Juan Pérez">
           <p class="muted">Con el enlace, la persona genera un ticket de ${TICKET_TTL_MINUTES} minutos y un solo uso para entrar a Telegram. El enlace vence a las ${INVITATION_TTL_HOURS} horas y se gasta cuando la persona entra a Telegram con su ticket. Solo tú puedes revocarlo.</p><button>Crear enlace</button></form>
         <div class="card"><h2>Enlaces de acceso</h2><div class="tablewrap"><table><tr><th>Nota</th><th>Empresa</th><th>Estado</th><th>Creado</th><th>Vinculada</th><th></th></tr>${invitationRows || '<tr><td colspan="6" class="muted">Aún no hay enlaces.</td></tr>'}</table></div></div>
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
    "/admin/invitations",
    guarded(async (req, res, session) => {
      const orgId = String(req.body?.orgId ?? "");
      const newOrgName = String(req.body?.newOrgName ?? "").trim();
      if (orgId ? !UUID.test(orgId) : !newOrgName) {
        return void (await dashboard(res.status(400), session, `<p class="card err">Elige una empresa o escribe el nombre de la nueva.</p>`));
      }
      const { token, orgName, expiresAt } = await opts.store.createInvitation({
        orgId: orgId || undefined,
        newOrgName: newOrgName.slice(0, 80),
        note: String(req.body?.note ?? "").slice(0, 80),
      });
      const link = `${req.protocol}://${req.get("host")}/acceso/${token}`;
      await dashboard(
        res,
        session,
        `<div class="card"><h2>Enlace creado para ${esc(orgName)}</h2><div class="code" style="font-size:1rem;word-break:break-all">${esc(link)}</div>
         <p class="err"><b>Cópialo ahora: no se vuelve a mostrar.</b> Vence el ${fmt(expiresAt)} y se gasta cuando la persona entra a Telegram con su ticket.</p>
         <p>Mándaselo a la persona. Al abrirlo genera un ticket de ${TICKET_TTL_MINUTES} minutos para entrar al bot.</p></div>`,
      );
    }),
  );

  router.post(
    "/admin/invitations/:id/revoke",
    guarded(async (req, res) => {
      if (UUID.test(req.params.id)) await opts.store.revokeInvitation(req.params.id);
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
