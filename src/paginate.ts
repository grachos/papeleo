/**
 * Lee una consulta completa por páginas. Pide rangos hasta que una página llega vacía, no al primer
 * resultado corto: así no se corta en silencio si el servidor limita las filas por respuesta a menos de `tam`.
 */
export async function todasLasPaginas<T>(pedir: (desde: number, hasta: number) => Promise<T[]>, tam = 1000): Promise<T[]> {
  const out: T[] = [];
  let desde = 0;
  for (;;) {
    const pagina = await pedir(desde, desde + tam - 1);
    if (pagina.length === 0) return out;
    out.push(...pagina);
    desde += pagina.length; // avanza por lo recibido: el servidor puede devolver menos que `tam`
  }
}
