import { JWT } from "google-auth-library";
import type { Expense, SheetsPort } from "./types.js";

/** Extrae el id de una URL de Google Sheets; null si el texto no contiene una. */
export function parseSheetId(text: string): string | null {
  return text.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? null;
}

export class GoogleSheets implements SheetsPort {
  private jwt: JWT | null = null;
  readonly serviceAccountEmail: string | null = null;

  /** Acepta el JSON de la cuenta de servicio tal cual o en base64. */
  constructor(serviceAccountJson: string | null) {
    if (!serviceAccountJson) return;
    const raw = serviceAccountJson.trim().startsWith("{")
      ? serviceAccountJson
      : Buffer.from(serviceAccountJson, "base64").toString("utf8");
    const creds = JSON.parse(raw) as { client_email: string; private_key: string };
    this.serviceAccountEmail = creds.client_email;
    this.jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  get enabled() {
    return this.jwt !== null;
  }

  async appendExpense(sheetId: string, e: Expense, memberName: string) {
    if (!this.jwt) return;
    const { token } = await this.jwt.getAccessToken();
    const row = [
      e.fecha,
      e.proveedor ?? "",
      e.nit ?? "",
      e.numero_factura ?? "",
      e.categoria,
      e.descripcion ?? "",
      e.subtotal ?? "",
      e.iva ?? "",
      e.total,
      e.medio_pago ?? "",
      memberName,
      e.id,
    ];
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) throw new Error(`Google Sheets respondió ${res.status}: ${await res.text()}`);
  }
}
