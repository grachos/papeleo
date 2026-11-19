import { checkItems, type ExpenseItem } from "./items.js";
import type { Expense } from "./types.js";

const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

export function money(value: number): string {
  return cop.format(value);
}

/** Dinero en su moneda: pesos con formato colombiano; otras monedas con su código delante. */
export function moneyIn(value: number, moneda: string): string {
  return moneda === "COP" ? money(value) : `${moneda} ${value.toLocaleString("es-CO", { maximumFractionDigits: 2 })}`;
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

const MAX_RENGLONES_EN_MENSAJE = 8;

/** Líneas del detalle de una factura («6 × Rollo… $5.500 = $33.000»); vacío si no hay renglones. */
export function itemsLines(items: ExpenseItem[] | null | undefined, moneda = "COP"): string[] {
  if (!items || items.length === 0) return [];
  const fmt = (n: number) => moneyIn(n, moneda);
  const lines = items.slice(0, MAX_RENGLONES_EN_MENSAJE).map((i) => {
    const cantidad = i.cantidad !== null ? `${i.cantidad} × ` : "";
    const unitario = i.cantidad !== null && i.valor_unitario !== null ? ` (${fmt(i.valor_unitario)} c/u)` : "";
    return `• ${cantidad}${i.descripcion}${unitario} = ${fmt(i.valor_linea)}`;
  });
  if (items.length > MAX_RENGLONES_EN_MENSAJE) lines.push(`… y ${items.length - MAX_RENGLONES_EN_MENSAJE} más`);
  return lines;
}

export function expenseMessage(e: Expense, items?: ExpenseItem[] | null): string {
  const lines = [
    "✅ *Gasto registrado*",
    `🏪 ${e.proveedor ?? "Proveedor no identificado"}${e.nit ? ` (NIT ${e.nit})` : ""}`,
    `📅 ${e.fecha}`,
    `💰 ${money(e.total)}${e.iva ? ` (IVA ${money(e.iva)})` : ""}`,
    `🏷️ ${label(e.categoria)}`,
  ];
  if (e.descripcion) lines.push(`📝 ${e.descripcion}`);
  const detalle = itemsLines(items, e.moneda);
  if (detalle.length > 0) lines.push("", "🧾 Detalle:", ...detalle);
  const cuadre = checkItems(items, e.total, e.subtotal);
  if (cuadre.revisar) lines.push("", `⚠️ Los renglones suman ${moneyIn(cuadre.suma, e.moneda)} y no cuadran con el total. Revisa el detalle.`);
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
  "También puedes *preguntarme lo que quieras* sobre tus gastos, con tus palabras: «¿en qué gasté más este mes?», «¿cuál fue la factura más cara?», «¿cuánto llevo en gasolina?».",
  "",
  "Y estos atajos:",
  "• *resumen*: total del mes por categoría",
  "• *borrar*: descarta el último gasto",
  "• *panel*: abre tus facturas en una página web (solo lectura)",
  "• *hoja* + enlace: copia cada gasto a tu hoja de Google",
  "• *excel*: te envío tus facturas en Excel; puedes filtrar: «excel mes 2026-01», «excel rubro transporte», «excel proveedor Éxito»",
].join("\n");
