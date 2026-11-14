/** Ayudas de HTML compartidas por el panel de administración y las páginas públicas. */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" }) : "—";

export const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f24;--card:#fff;--line:#dfe3e8;--muted:#667085;--accent:#1f6feb;--danger:#c62828;--ok:#1b7f3b}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ee;--card:#1d2127;--line:#2e343c;--muted:#98a2b3;--accent:#5b9dff;--danger:#ef6b6b;--ok:#4cc27a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:.2rem 0 1rem}h2{font-size:1.1rem;margin:0 0 .75rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
label{display:block;font-size:.85rem;color:var(--muted);margin:.6rem 0 .2rem}
input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button.danger{background:var(--danger)}button.link{background:none;color:var(--muted);text-decoration:underline;padding:0}
.top{display:flex;justify-content:space-between;align-items:center}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.row{grid-template-columns:1fr}}
.tablewrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600}.muted{color:var(--muted)}.err{color:var(--danger)}
.code{font:600 1.6rem ui-monospace,monospace;letter-spacing:.08em;padding:12px;background:var(--bg);border:1px dashed var(--accent);border-radius:8px;text-align:center;user-select:all}
.badge{padding:2px 8px;border-radius:99px;border:1px solid var(--line);font-size:.8rem}.ok{color:var(--ok)}.bad{color:var(--danger)}
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

/** Hora de Colombia (HH:MM) de una fecha ISO. */
export const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });

/** Encabezados de seguridad de las páginas con datos sensibles (sin scripts ni recursos externos, sin caché, sin referer). */
export const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
