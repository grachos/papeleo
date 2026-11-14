import express from "express";
import { AttemptLimiter, INVITE_TOKEN_RE, TICKET_TTL_MINUTES } from "./access.js";
import type { InvitePort } from "./types.js";
import { esc, hora, page, SECURITY_HEADERS } from "./web.js";

export interface InviteOptions {
  store: InvitePort;
  /** Usuario del bot de Telegram, para armar el enlace «Abrir en Telegram». */
  botUsername?: () => string | null;
  now?: () => number;
}

const INVALID =
  "Este enlace no es válido o ya no sirve (venció, se revocó o ya se usó). Pídele uno nuevo al administrador.";

/**
 * Página pública del enlace de invitación: `/acceso/<token>`.
 * - GET solo muestra el botón y nunca cambia nada: los previsualizadores de enlaces (Telegram, WhatsApp, correo) lo abren.
 * - POST genera el ticket de 15 minutos. Cualquier enlace malo (inexistente, vencido, revocado, ya usado) recibe la misma respuesta.
 * - El token va en la ruta: nunca se registra, y la página no carga nada externo ni envía referer.
 */
export function createInviteRouter(opts: InviteOptions) {
  const now = opts.now ?? Date.now;
  const limiter = new AttemptLimiter(10, 15 * 60 * 1000, now);
  const router = express.Router();

  router.use("/acceso", (_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  const invalidPage = (res: express.Response, status = 404) =>
    res.status(status).send(page("Papeleo · Acceso", `<h1>Papeleo</h1><div class="card"><p class="err">${esc(INVALID)}</p></div>`));

  router.get("/acceso/:token", (req, res) => {
    // Sin consultar la base: la misma página para cualquier token con forma válida.
    if (!INVITE_TOKEN_RE.test(req.params.token)) return void invalidPage(res);
    res.send(
      page(
        "Papeleo · Acceso",
        `<h1>Papeleo</h1><form class="card" method="post" action="/acceso/${esc(req.params.token)}">
         <h2>Te invitaron a usar el asistente de gastos</h2>
         <p>Pulsa el botón para generar tu <b>ticket de acceso</b>. Dura <b>${TICKET_TTL_MINUTES} minutos</b> y sirve <b>una sola vez</b>:
         tendrás que usarlo en Telegram.</p>
         <p class="muted">Tu enlace deja de servir cuando entras a Telegram con el ticket. Si el ticket vence antes, vuelve a abrir este enlace y genera otro.</p>
         <button>Generar mi ticket</button></form>`,
      ),
    );
  });

  router.post("/acceso/:token", async (req, res) => {
    const ip = req.ip ?? "?";
    if (!limiter.allowed(ip)) return void invalidPage(res, 429);
    if (!INVITE_TOKEN_RE.test(req.params.token)) {
      limiter.fail(ip);
      return void invalidPage(res);
    }

    let issued: Awaited<ReturnType<InvitePort["issueTicket"]>>;
    try {
      issued = await opts.store.issueTicket(req.params.token);
    } catch (err) {
      console.error("Fallo generando un ticket", err instanceof Error ? err.message : "error");
      return void res.status(500).send(page("Papeleo · Acceso", `<h1>Papeleo</h1><div class="card"><p class="err">Algo salió mal. Inténtalo de nuevo en unos minutos.</p></div>`));
    }
    if (!issued) {
      limiter.fail(ip);
      return void invalidPage(res);
    }

    const bot = opts.botUsername?.();
    const deepLink = bot ? `https://t.me/${bot}?start=${issued.ticket.replace(/-/g, "")}` : null;
    res.send(
      page(
        "Papeleo · Tu ticket",
        `<h1>Papeleo</h1><div class="card"><h2>Tu ticket para ${esc(issued.orgName)}</h2>
         <div class="code">${esc(issued.ticket)}</div>
         <p>Sirve hasta las <b>${esc(hora(issued.expiresAt))}</b> (hora de Colombia) y una sola vez.</p>
         ${deepLink ? `<p><a href="${esc(deepLink)}"><button type="button">Abrir en Telegram</button></a></p><p class="muted">O escríbele este ticket al bot en Telegram.</p>` : `<p>Escríbele este ticket al bot en Telegram.</p>`}
         <p class="muted">Si se te pasa el tiempo, vuelve a abrir tu enlace y genera otro ticket; el anterior queda sin efecto.</p></div>`,
      ),
    );
  });

  return router;
}
