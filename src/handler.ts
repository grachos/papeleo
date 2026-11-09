import { createHash } from "node:crypto";
import { isSupportedMime } from "./extract.js";
import { expenseMessage, HELP, money, monthRange, summaryMessage, todayBogota } from "./format.js";
import { parseSheetId } from "./sheets.js";
import type { Deps, IncomingMessage, Member, Org } from "./types.js";

const MAX_BYTES = 15 * 1024 * 1024;
const DISCARD_PREFIX = "descartar:";

export async function handleMessage(msg: IncomingMessage, deps: Deps): Promise<void> {
  const { member, org, isNew } = await deps.store.findOrCreateMember(msg.from, msg.senderName);
  if (isNew) {
    await deps.wa.sendText(msg.from, `👋 Hola${member.name ? `, ${member.name}` : ""}. Soy tu asistente de gastos.\n\n${HELP}`);
    if (msg.kind === "text") return;
  }

  switch (msg.kind) {
    case "media":
      return handleMedia(msg, member, org, deps);
    case "button":
      if (msg.buttonId?.startsWith(DISCARD_PREFIX)) {
        return discard(member, deps, msg.buttonId.slice(DISCARD_PREFIX.length));
      }
      return;
    case "text":
      return handleText(msg.text ?? "", member, org, deps);
    default:
      return deps.wa.sendText(msg.from, "Solo puedo leer fotos y PDF por ahora.\n\n" + HELP);
  }
}

async function handleText(text: string, member: Member, org: Org, deps: Deps): Promise<void> {
  const command = text.trim().toLowerCase();

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

  return deps.wa.sendText(member.phone, HELP);
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

    const extraction = await deps.extractor.extract(data, mimeType);
    if (!extraction || !extraction.es_comprobante || extraction.total === null) {
      await deps.store.finishDocument(documentId, "no_reconocido", extraction ?? undefined);
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
    await deps.store.finishDocument(documentId, "procesado", extraction);

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
