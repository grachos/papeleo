/**
 * Clave de identidad de una factura: NIT (solo dígitos, sin dígito de verificación) + número de factura.
 * Sirve para no registrar dos veces la misma factura.
 */

/** «900.155.107-1» → «900155107». Vacío o sin dígitos → null. */
export function normalizarNit(nit: string | null | undefined): string | null {
  if (!nit) return null;
  const digitos = nit.split("-")[0].replace(/\D/g, "");
  return digitos.length > 0 ? digitos : null;
}

/** Número de factura sin espacios ni mayúsculas/minúsculas. Vacío → null. */
export function normalizarNumero(numero: string | null | undefined): string | null {
  const limpio = (numero ?? "").replace(/\s+/g, "").toUpperCase();
  return limpio.length > 0 ? limpio : null;
}

function fechaReal(y: number, m: number, d: number): string | null {
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Fecha que escribe la persona: «hoy», AAAA-MM-DD o DD/MM/AAAA. Devuelve AAAA-MM-DD o null si no es una fecha válida. */
export function leerRespuestaFecha(texto: string, hoy: string): string | null {
  const t = texto.trim().toLowerCase();
  if (t === "hoy") return hoy;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return fechaReal(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return fechaReal(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  return null;
}

/** Fecha leída de la factura, si viene completa y válida (AAAA-MM-DD). */
export function fechaLeida(fecha: string | null | undefined): string | null {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const [y, m, d] = fecha.split("-").map(Number);
  return fechaReal(y, m, d);
}
