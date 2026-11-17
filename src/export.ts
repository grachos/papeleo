import ExcelJS from "exceljs";
import { CATEGORIAS } from "./extract.js";
import { monthRange } from "./format.js";
import { checkItems, type ExpenseItem } from "./items.js";
import type { Expense, PanelFilters } from "./types.js";

/** Tope de facturas por archivo: más que esto hay que acotar las fechas (un Excel enorme no sirve en un chat). */
export const EXPORT_MAX_ROWS = 1000;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const AYUDA = [
  "Puedes pedir el Excel con filtros, por ejemplo:",
  "• excel mes 2026-01",
  "• excel desde 2026-01-01 hasta 2026-03-31",
  "• excel rubro transporte",
  "• excel proveedor Éxito",
  "Sin filtros, te envío todas tus facturas.",
].join("\n");

const CLAVES = ["desde", "hasta", "mes", "rubro", "proveedor"] as const;
type Clave = (typeof CLAVES)[number];

export type ExportParse =
  | { ok: true; filters: PanelFilters; descripcion: string }
  | { ok: false; mensaje: string };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-\d{2}$/;

function esFechaReal(s: string): boolean {
  if (!FECHA.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

/** Quita tildes y pasa a minúsculas con guiones bajos, para comparar con los rubros (p. ej. «Mercado hogar» → mercado_hogar). */
function normalizarRubro(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, "_");
}

/**
 * Interpreta los filtros del comando «excel» (el primer token es el propio comando).
 * Lo escrito por la persona se valida aquí; nunca llega a la base sin pasar por estas reglas.
 */
export function parseExportArgs(text: string): ExportParse {
  const tokens = text.trim().split(/\s+/).slice(1);
  const valores: Partial<Record<Clave, string[]>> = {};
  let clave: Clave | null = null;

  for (const t of tokens) {
    const minuscula = t.toLowerCase();
    if ((CLAVES as readonly string[]).includes(minuscula)) {
      clave = minuscula as Clave;
      valores[clave] ??= [];
      continue;
    }
    if (!clave) return { ok: false, mensaje: AYUDA };
    valores[clave]!.push(t);
  }

  const campo = (c: Clave): string | undefined => {
    const v = valores[c];
    if (v === undefined) return undefined;
    const s = v.join(" ").trim();
    return s || undefined;
  };
  for (const c of CLAVES) if (valores[c] && !campo(c)) return { ok: false, mensaje: AYUDA };

  const mes = campo("mes");
  const desde = campo("desde");
  const hasta = campo("hasta");
  const rubro = campo("rubro");
  const proveedor = campo("proveedor");

  const filters: PanelFilters = {};
  const partes: string[] = [];

  if (mes) {
    if (desde || hasta) return { ok: false, mensaje: "Usa «mes» o «desde/hasta», no los dos.\n\n" + AYUDA };
    if (!MES.test(mes) || !esFechaReal(`${mes}-01`)) return { ok: false, mensaje: "El mes debe ir como AAAA-MM, por ejemplo: excel mes 2026-01" };
    const r = monthRange(`${mes}-01`);
    filters.desde = r.from;
    filters.hasta = r.to;
    partes.push(`de ${mes}`);
  } else {
    if (desde) {
      if (!esFechaReal(desde)) return { ok: false, mensaje: "La fecha «desde» debe ir como AAAA-MM-DD, por ejemplo: desde 2026-01-01" };
      filters.desde = desde;
      partes.push(`desde ${desde}`);
    }
    if (hasta) {
      if (!esFechaReal(hasta)) return { ok: false, mensaje: "La fecha «hasta» debe ir como AAAA-MM-DD, por ejemplo: hasta 2026-03-31" };
      filters.hasta = hasta;
      partes.push(`hasta ${hasta}`);
    }
    if (filters.desde && filters.hasta && filters.desde > filters.hasta) {
      return { ok: false, mensaje: "La fecha «desde» es posterior a «hasta». Revisa las fechas." };
    }
  }

  if (rubro) {
    const cat = normalizarRubro(rubro);
    if (!(CATEGORIAS as readonly string[]).includes(cat)) {
      return { ok: false, mensaje: `No conozco el rubro «${rubro}». Puedes usar: ${CATEGORIAS.join(", ")}.` };
    }
    filters.categoria = cat;
    partes.push(`del rubro ${cat}`);
  }

  if (proveedor) {
    if (proveedor.length > 60) return { ok: false, mensaje: "El nombre del proveedor es demasiado largo para filtrar." };
    filters.proveedor = proveedor;
    partes.push(`del proveedor «${proveedor}»`);
  }

  return { ok: true, filters, descripcion: partes.length ? partes.join(", ") : "de todo el registro" };
}

/**
 * Las celdas de texto que empiezan con = + - @ (o tabulador/retorno) se leen como fórmulas en Excel.
 * Se anteponen con una comilla simple para que se muestren como texto. Evita que una factura inyecte fórmulas.
 */
export function neutralizar(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const aTexto = (v: string | null | undefined) => (v === null || v === undefined ? null : neutralizar(v));
const aFecha = (f: string) => new Date(`${f}T12:00:00Z`); // mediodía UTC: ninguna zona horaria cambia el día

/** Arma el libro: una hoja de facturas y otra de renglones (con fecha y proveedor para filtrar en Excel). */
export async function construirExcel(rows: Expense[], items: Map<string, ExpenseItem[]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Papeleo";

  const hojaFacturas = wb.addWorksheet("Facturas");
  hojaFacturas.columns = [
    { header: "Fecha", key: "fecha", width: 12 },
    { header: "Proveedor", key: "proveedor", width: 28 },
    { header: "NIT", key: "nit", width: 16 },
    { header: "Número de factura", key: "numero", width: 18 },
    { header: "Rubro", key: "rubro", width: 16 },
    { header: "Medio de pago", key: "medio", width: 16 },
    { header: "Descripción", key: "descripcion", width: 36 },
    { header: "Subtotal", key: "subtotal", width: 14 },
    { header: "IVA", key: "iva", width: 12 },
    { header: "Total", key: "total", width: 14 },
    { header: "Moneda", key: "moneda", width: 9 },
    { header: "Confianza", key: "confianza", width: 11 },
    { header: "Revisar", key: "revisar", width: 9 },
  ];
  for (const e of rows) {
    const renglones = items.get(e.id) ?? [];
    const revisar = renglones.length > 0 && checkItems(renglones, e.total, e.subtotal).revisar;
    hojaFacturas.addRow({
      fecha: aFecha(e.fecha),
      proveedor: aTexto(e.proveedor),
      nit: aTexto(e.nit),
      numero: aTexto(e.numero_factura),
      rubro: aTexto(e.categoria),
      medio: aTexto(e.medio_pago),
      descripcion: aTexto(e.descripcion),
      subtotal: e.subtotal,
      iva: e.iva,
      total: e.total,
      moneda: aTexto(e.moneda),
      confianza: aTexto(e.confianza),
      revisar: revisar ? "sí" : "no",
    });
  }
  formatearHoja(hojaFacturas, ["subtotal", "iva", "total"]);

  const hojaRenglones = wb.addWorksheet("Renglones");
  hojaRenglones.columns = [
    { header: "Fecha", key: "fecha", width: 12 },
    { header: "Proveedor", key: "proveedor", width: 28 },
    { header: "Número de factura", key: "numero", width: 18 },
    { header: "Concepto", key: "concepto", width: 40 },
    { header: "Cantidad", key: "cantidad", width: 10 },
    { header: "Valor unitario", key: "unitario", width: 14 },
    { header: "Valor de línea", key: "linea", width: 14 },
  ];
  for (const e of rows) {
    for (const r of items.get(e.id) ?? []) {
      hojaRenglones.addRow({
        fecha: aFecha(e.fecha),
        proveedor: aTexto(e.proveedor),
        numero: aTexto(e.numero_factura),
        concepto: aTexto(r.descripcion),
        cantidad: r.cantidad,
        unitario: r.valor_unitario,
        linea: r.valor_linea,
      });
    }
  }
  formatearHoja(hojaRenglones, ["unitario", "linea"]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function formatearHoja(ws: ExcelJS.Worksheet, dinero: string[]) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  ws.getColumn("fecha").numFmt = "yyyy-mm-dd";
  for (const key of dinero) ws.getColumn(key).numFmt = "#,##0";
}

// --- Periodos en lenguaje natural («antes de noviembre», «de enero a marzo») -------------------

export type PeriodoNatural =
  | { tipo: "todo" }
  | { tipo: "filtros"; filters: PanelFilters; descripcion: string }
  | { tipo: "no_entiendo" };

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_NOMBRE = `(${MESES.join("|")}|setiembre)`;

const quitarTildes = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const diasDelMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fechaISO = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const numeroMes = (nombre: string) => (nombre === "setiembre" ? 9 : MESES.indexOf(nombre) + 1);

/**
 * Interpreta el periodo de una frase libre. Lo que no entiende (semanas, «ayer», rubros, proveedores,
 * fechas sueltas) NO se exporta completo: se pide usar el comando con filtros.
 * Un mes sin año usa el año actual, o el anterior si ese mes aún no ha llegado.
 */
export function interpretarPeriodo(texto: string, hoy: string): PeriodoNatural {
  const n = quitarTildes(texto);
  const [hy, hm] = hoy.split("-").map(Number);

  if (/\d{4}-\d{2}-\d{2}/.test(n)) return { tipo: "no_entiendo" };
  if (/\b(semana|ayer|hoy|trimestre|quincena|hace|dias?|anos?|anio|rubro|categoria|proveedor)\b/.test(n)) return { tipo: "no_entiendo" };

  const anioExplicito = n.match(/\b(20\d{2})\b/);
  const anio = anioExplicito ? Number(anioExplicito[1]) : undefined;
  const anioDelMes = (mes: number) => anio ?? (mes > hm ? hy - 1 : hy);
  const rango = (desde: string, hasta: string, descripcion: string): PeriodoNatural => ({
    tipo: "filtros",
    filters: { desde, hasta },
    descripcion,
  });
  const mesCompleto = (y: number, m: number) => rango(fechaISO(y, m, 1), fechaISO(y, m, diasDelMes(y, m)), `de ${fechaISO(y, m, 1).slice(0, 7)}`);

  if (/\beste mes\b/.test(n)) return mesCompleto(hy, hm);
  if (/\bmes pasado\b/.test(n)) return hm === 1 ? mesCompleto(hy - 1, 12) : mesCompleto(hy, hm - 1);

  const deAmes = n.match(new RegExp(`\\b(?:de|desde) ${MES_NOMBRE} (?:a|hasta|y) ${MES_NOMBRE}\\b`));
  if (deAmes) {
    const m1 = numeroMes(deAmes[1]);
    const m2 = numeroMes(deAmes[2]);
    const y1 = anioDelMes(m1);
    const y2 = y1 + (m2 < m1 ? 1 : 0);
    return rango(fechaISO(y1, m1, 1), fechaISO(y2, m2, diasDelMes(y2, m2)), `de ${fechaISO(y1, m1, 1).slice(0, 7)} a ${fechaISO(y2, m2, 1).slice(0, 7)}`);
  }

  const antes = n.match(new RegExp(`\\bantes de ${MES_NOMBRE}\\b`));
  if (antes) {
    let m = numeroMes(antes[1]) - 1;
    let y = anioDelMes(numeroMes(antes[1]));
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    return { tipo: "filtros", filters: { hasta: fechaISO(y, m, diasDelMes(y, m)) }, descripcion: `hasta ${fechaISO(y, m, diasDelMes(y, m))}` };
  }

  const despues = n.match(new RegExp(`\\bdespues de ${MES_NOMBRE}\\b`));
  if (despues) {
    let m = numeroMes(despues[1]) + 1;
    let y = anioDelMes(numeroMes(despues[1]));
    if (m === 13) {
      m = 1;
      y += 1;
    }
    return { tipo: "filtros", filters: { desde: fechaISO(y, m, 1) }, descripcion: `desde ${fechaISO(y, m, 1)}` };
  }

  const unMes = n.match(new RegExp(`\\b${MES_NOMBRE}\\b`));
  if (unMes) {
    const m = numeroMes(unMes[1]);
    return mesCompleto(anioDelMes(m), m);
  }

  // Palabras de periodo que no supimos interpretar: no exportar todo en silencio.
  if (/\b(antes|despues|desde|hasta|mes|meses)\b/.test(n)) return { tipo: "no_entiendo" };
  return { tipo: "todo" };
}
