/** Un renglón de la factura (producto o servicio) tal como lo leyó el modelo. */
export interface ExpenseItem {
  descripcion: string;
  cantidad: number | null;
  valor_unitario: number | null;
  valor_linea: number;
}

/**
 * Compara la suma de los renglones con el total (o el subtotal, si la factura lo muestra así).
 * `revisar` es true cuando hay renglones y ninguna de las dos sumas cuadra, con una tolerancia de 1 peso
 * por redondeo. Sin renglones no hay nada que comparar: no se marca.
 */
export function checkItems(items: ExpenseItem[] | null | undefined, total: number, subtotal: number | null): { revisar: boolean; suma: number } {
  if (!items || items.length === 0) return { revisar: false, suma: 0 };
  const suma = Math.round(items.reduce((acc, i) => acc + i.valor_linea, 0) * 100) / 100;
  const cuadra = (contra: number) => Math.abs(suma - contra) <= 1;
  const coincide = cuadra(total) || (subtotal !== null && cuadra(subtotal));
  return { revisar: !coincide, suma };
}
