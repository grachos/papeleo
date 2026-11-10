import { createHash } from "node:crypto";
import { extractCode } from "./access.js";
import { isSupportedMime } from "./extract.js";
import { expenseMessage, HELP, money, monthRange, summaryMessage, todayBogota } from "./format.js";
import { parseSheetId } from "./sheets.js";
import type { Deps, IncomingMessage, Member, Org } from "./types.js";

const MAX_BYTES = 15 * 1024 * 1024;
const DISCARD_PREFIX = "descartar:";
const FEEDBACK_PREFIX = "fb:";
const DEFAULT_DAILY_CAP = 40;
const MAX_QUESTION_CHARS = 500;
const MEMORY_MINUTES = 30; // la conversación se recuerda mientras no pasen más de 30 min entre mensajes
const MEMORY_TURNS = 6;

export async function handleMessage(msg: IncomingMessage, allDeps: Deps): Promise<void> {
  // Cada mensaje se responde por el mismo canal por el que llegó.
  let deps = allDeps;
  if (msg.channel === "telegram") {
    if (!allDeps.tg) throw new Error("Llegó un mensaje de Telegram pero el canal no está configurado");
    deps = { ...allDeps, wa: allDeps.tg };
  }
  const found = await deps.store.findMember(msg.from);
  if (!found) {
    // Sin acceso: solo se atiende un mensaje que traiga un código válido; todo lo demás se ignora en silencio.
    if (msg.kind === "text") await tryRedeem(msg, deps);
    return;
  }
  const { member, org } = found;

  switch (msg.kind) {
    case "media":
      return handleMedia(msg, member, org, deps);
    case "button":
      if (msg.buttonId?.startsWith(DISCARD_PREFIX)) {
        return discard(member, deps, msg.buttonId.slice(DISCARD_PREFIX.length));
      }
      if (msg.buttonId?.startsWith(FEEDBACK_PREFIX)) return feedback(msg.buttonId, member, deps);
      return;
    case "text":
      return handleText(msg.text ?? "", member, org, deps);
    default:
      return deps.wa.sendText(msg.from, "Solo puedo leer fotos y PDF por ahora.\n\n" + HELP);
  }
}

async function tryRedeem(msg: IncomingMessage, deps: Deps): Promise<void> {
  const code = extractCode(msg.text ?? "");
  if (!code || (deps.limiter && !deps.limiter.allowed(msg.from))) return;

  const joined = await deps.store.redeemCode(code, msg.from, msg.senderName);
  if (!joined) {
    deps.limiter?.fail(msg.from);
    return; // código inexistente, usado o revocado: sin respuesta
  }
  deps.limiter?.reset(msg.from);
  const hello = joined.member.name ? `, ${joined.member.name}` : "";
  await deps.wa.sendText(msg.from, `✅ Listo${hello}. Quedaste vinculado a ${joined.org.name}.\n\n${HELP}`);
}

async function handleText(text: string, member: Member, org: Org, deps: Deps): Promise<void> {
  // En Telegram los comandos llegan como «/resumen» o «/resumen@mi_bot».
  const command = text.trim().toLowerCase().replace(/^\/([a-z_]+)(@\w+)?/, "$1");

  if (command === "resumen") {
    const today = (deps.today ?? todayBogota)();
    const { from, to } = monthRange(today);
    const expenses = await deps.store.listExpenses(org.id, from, to);
    return deps.wa.sendText(member.phone, summaryMessage(expenses, today.slice(0, 7)));
  }

  if (command === "borrar") return discard(member, deps);

  if (command.startsWith("hoja")) {
    if (!deps.sheets.enabled) {
      return deps.wa.sendText(member.phone, "La conexión con Google Sheets aún no está activa en este servicio.");
    }
    const sheetId = parseSheetId(text);
    if (!sheetId) {
      return deps.wa.sendText(
        member.phone,
        `Comparte tu hoja de Google como *editor* con\n${deps.sheets.serviceAccountEmail}\ny envíame: hoja + el enlace de la hoja.`,
      );
    }
    await deps.store.setSheet(org.id, sheetId);
    return deps.wa.sendText(
      member.phone,
      `Listo. Cada gasto nuevo se copiará a esa hoja. Recuerda compartirla como editor con ${deps.sheets.serviceAccountEmail}.`,
    );
  }

  if (["start", "ayuda", "help", "menu", "menú"].includes(command)) return deps.wa.sendText(member.phone, HELP);

  return askAssistant(text, member, org, deps);
}

/** Cualquier otro texto es una pregunta en lenguaje natural sobre los gastos. */
async function askAssistant(text: string, member: Member, org: Org, deps: Deps): Promise<void> {
  const { assistant, query } = deps;
  if (!assistant || !query) return deps.wa.sendText(member.phone, HELP);

  const today = (deps.today ?? todayBogota)();
  const dayStart = `${today}T05:00:00Z`; // medianoche en Colombia (UTC-5)
  const cap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
  const used = await query.countSince(member.id, dayStart).catch((err) => {
    console.error("No se pudo contar las preguntas del día", err);
    return null;
  });
  if (used === null) return deps.wa.sendText(member.phone, "Tuve un problema para atender tu pregunta. Inténtalo de nuevo en unos minutos.");
  if (used >= cap) {
    return deps.wa.sendText(
      member.phone,
      `Hoy ya hiciste ${cap} preguntas, que es el máximo por día. Mañana puedes seguir preguntando. Mientras tanto, puedes enviarme facturas y escribir *resumen*.`,
    );
  }

  const question = text.trim().slice(0, MAX_QUESTION_CHARS);
  const since = new Date(Date.now() - MEMORY_MINUTES * 60_000).toISOString();
  // Sin memoria se puede seguir respondiendo; solo se pierde el contexto de la conversación.
  const history = await query.recentTurns(member.id, since, MEMORY_TURNS).catch((err) => {
    console.error("No se pudo leer la conversación reciente", err);
    return [];
  });
  const result = await assistant.answer({ orgId: org.id, question, today, history });

  // Se registra siempre: alimenta la memoria, el tope diario y el aprendizaje.
  const logId = await query
    .logQuery({
      orgId: org.id,
      memberId: member.id,
      question,
      answer: result.text,
      plan: result.plan,
      status: result.status,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    })
    .catch((err) => {
      console.error("No se pudo registrar la pregunta", err);
      return null;
    });

  if (result.status !== "ok" || !logId) return deps.wa.sendText(member.phone, result.text);

  const buttons = [
    { id: `${FEEDBACK_PREFIX}up:${logId}`, title: "👍 Sí" },
    { id: `${FEEDBACK_PREFIX}down:${logId}`, title: "👎 No" },
  ];
  // Los botones de WhatsApp admiten cuerpos de hasta 1024 caracteres: si la respuesta es larga, va aparte.
  if (result.text.length <= 900) return deps.wa.sendButtons(member.phone, `${result.text}\n\n¿Te sirvió?`, buttons);
  await deps.wa.sendText(member.phone, result.text);
  return deps.wa.sendButtons(member.phone, "¿Te sirvió esta respuesta?", buttons);
}

async function feedback(buttonId: string, member: Member, deps: Deps): Promise<void> {
  const [, value, logId] = buttonId.split(":");
  if ((value === "up" || value === "down") && logId) {
    await deps.query?.setFeedback(logId, member.id, value).catch((err) => console.error("No se pudo guardar la valoración", err));
    await deps.wa.sendText(member.phone, value === "up" ? "¡Gracias! 🙌" : "Gracias por avisarme. Voy a tratar de hacerlo mejor.");
  }
}

async function discard(member: Member, deps: Deps, expenseId?: string): Promise<void> {
  const removed = await deps.store.discardExpense(member.id, expenseId);
  const reply = removed
    ? `🗑️ Descarté el gasto de ${removed.proveedor ?? "proveedor no identificado"} por ${money(removed.total)}.`
    : "No encontré un gasto para descartar.";
  return deps.wa.sendText(member.phone, reply);
}

async function handleMedia(msg: IncomingMessage, member: Member, org: Org, deps: Deps): Promise<void> {
  const to = member.phone;
  if (!msg.mediaId || !msg.mimeType || !isSupportedMime(msg.mimeType)) {
    return deps.wa.sendText(to, "Ese tipo de archivo no lo puedo leer. Envíame una foto (JPG o PNG) o un PDF.");
  }

  const documentId = await deps.store.claimDocument(org.id, member.id, msg.id, msg.mimeType);
  if (!documentId) return; // reintento del mismo webhook: ya se está procesando

  try {
    const { data, mimeType } = await deps.wa.downloadMedia(msg.mediaId);
    if (data.length > MAX_BYTES) {
      await deps.store.finishDocument(documentId, "error");
      return deps.wa.sendText(to, "El archivo supera los 15 MB. Envíalo en menor tamaño.");
    }

    const sha256 = createHash("sha256").update(data).digest("hex");
    if (await deps.store.hashExists(org.id, sha256)) {
      await deps.store.finishDocument(documentId, "duplicado");
      return deps.wa.sendText(to, "Ese comprobante ya lo había registrado, así que no lo dupliqué.");
    }
    await deps.store.saveFile(org.id, documentId, data, mimeType, sha256);

    const { extraction, usage } = await deps.extractor.extract(data, mimeType);
    if (!extraction || !extraction.es_comprobante || extraction.total === null) {
      await deps.store.finishDocument(documentId, "no_reconocido", extraction ?? undefined, usage);
      return deps.wa.sendText(
        to,
        "Guardé el archivo, pero no pude leer en él un comprobante con valor total. Intenta con una foto más nítida y completa.",
      );
    }

    const today = (deps.today ?? todayBogota)();
    const fecha = extraction.fecha && /^\d{4}-\d{2}-\d{2}$/.test(extraction.fecha) ? extraction.fecha : today;
    const expense = await deps.store.saveExpense(org.id, member.id, documentId, {
      fecha,
      proveedor: extraction.proveedor,
      nit: extraction.nit,
      numero_factura: extraction.numero_factura,
      subtotal: extraction.subtotal,
      iva: extraction.iva,
      total: extraction.total,
      moneda: extraction.moneda || "COP",
      categoria: extraction.categoria,
      medio_pago: extraction.medio_pago,
      descripcion: extraction.descripcion,
      confianza: extraction.confianza,
    });
    await deps.store.finishDocument(documentId, "procesado", extraction, usage);

    let note = "";
    if (org.sheet_id && deps.sheets.enabled) {
      try {
        await deps.sheets.appendExpense(org.sheet_id, expense, member.name ?? member.phone);
      } catch (err) {
        console.error("Fallo al escribir en Google Sheets", err);
        note = "\n\n⚠️ Quedó guardado, pero no pude copiarlo a tu hoja de Google. Revisa que siga compartida.";
      }
    }

    await deps.wa.sendButtons(to, expenseMessage(expense) + note, [
      { id: DISCARD_PREFIX + expense.id, title: "Descartar" },
    ]);
  } catch (err) {
    console.error("Fallo procesando el documento", documentId, err);
    await deps.store.finishDocument(documentId, "error").catch(() => {});
    await deps.wa.sendText(to, "Tuve un problema procesando ese archivo. Inténtalo de nuevo en unos minutos.");
  }
}
