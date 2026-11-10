import type { Expense } from "./types.js";

const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

export function money(value: number): string {
  return cop.format(value);
}

/** Fecha de hoy en Colombia (UTC-5, sin horario de verano) como AAAA-MM-DD. */
export function todayBogota(): string {
  return new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
}

export function monthRange(day: string): { from: string; to: string } {
  const [y, m] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prefix = day.slice(0, 7);
  return { from: `${prefix}-01`, to: `${prefix}-${String(last).padStart(2, "0")}` };
}

const label = (categoria: string) => categoria.replaceAll("_", " ");

export function expenseMessage(e: Expense): string {
  const lines = [
    "✅ *Gasto registrado*",
    `🏪 ${e.proveedor ?? "Proveedor no identificado"}${e.nit ? ` (NIT ${e.nit})` : ""}`,
    `📅 ${e.fecha}`,
    `💰 ${money(e.total)}${e.iva ? ` (IVA ${money(e.iva)})` : ""}`,
    `🏷️ ${label(e.categoria)}`,
  ];
  if (e.descripcion) lines.push(`📝 ${e.descripcion}`);
  if (e.confianza === "baja") lines.push("", "⚠️ La imagen no se lee bien. Revisa que el valor y la fecha sean correctos.");
  return lines.join("\n");
}

export function summaryMessage(expenses: Expense[], month: string): string {
  if (expenses.length === 0) return `No tienes gastos registrados en ${month}.`;
  const byCategory = new Map<string, number>();
  let total = 0;
  for (const e of expenses) {
    byCategory.set(e.categoria, (byCategory.get(e.categoria) ?? 0) + e.total);
    total += e.total;
  }
  const rows = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([categoria, sum]) => `• ${label(categoria)}: ${money(sum)}`);
  return [`📊 *Gastos de ${month}*`, ...rows, "", `*Total: ${money(total)}* en ${expenses.length} comprobantes`].join("\n");
}

export const HELP = [
  "Envíame la *foto o el PDF* de una factura, tiquete o recibo y lo registro.",
  "Si la foto sale borrosa, envíala como *archivo* (documento) para que no se comprima.",
  "",
  "También puedes escribir:",
  "• *resumen*: total del mes por categoría",
  "• *borrar*: descarta el último gasto",
  "• *hoja* + enlace: copia cada gasto a tu hoja de Google",
].join("\n");
