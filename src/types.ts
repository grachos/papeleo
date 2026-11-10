import type { Extraction } from "./extract.js";

export interface Org {
  id: string;
  name: string;
  sheet_id: string | null;
}

export interface Member {
  id: string;
  org_id: string;
  phone: string;
  name: string | null;
}

export interface Expense {
  id: string;
  fecha: string;
  proveedor: string | null;
  nit: string | null;
  numero_factura: string | null;
  subtotal: number | null;
  iva: number | null;
  total: number;
  moneda: string;
  categoria: string;
  medio_pago: string | null;
  descripcion: string | null;
  confianza: string;
}

export type NewExpense = Omit<Expense, "id">;

export type Channel = "whatsapp" | "telegram";

/**
 * Mensaje entrante ya normalizado desde el webhook del canal.
 * `from` identifica al remitente: teléfono en WhatsApp; en Telegram, el id del chat con prefijo `tg:`.
 */
export interface IncomingMessage {
  id: string;
  channel?: Channel; // por defecto, whatsapp
  from: string;
  senderName: string | null;
  kind: "text" | "media" | "button" | "other";
  text?: string;
  /** Id del archivo en el canal (WhatsApp: id del medio; Telegram: file_id). */
  mediaId?: string;
  mimeType?: string;
  buttonId?: string;
}

export interface Button {
  id: string;
  title: string;
}

/** Canal de mensajería (WhatsApp o Telegram). */
export interface MessengerPort {
  sendText(to: string, body: string): Promise<void>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export type WhatsAppPort = MessengerPort;

export interface StorePort {
  findOrCreateMember(
    phone: string,
    name: string | null,
  ): Promise<{ member: Member; org: Org; isNew: boolean }>;
  /** Devuelve null si ese mensaje de WhatsApp ya se había recibido. */
  claimDocument(orgId: string, memberId: string, waMessageId: string, mime: string): Promise<string | null>;
  hashExists(orgId: string, sha256: string): Promise<boolean>;
  saveFile(orgId: string, documentId: string, data: Buffer, mime: string, sha256: string): Promise<void>;
  finishDocument(documentId: string, status: string, extraction?: Extraction): Promise<void>;
  saveExpense(orgId: string, memberId: string, documentId: string, expense: NewExpense): Promise<Expense>;
  /** Marca el gasto como descartado; sin expenseId descarta el último del miembro. */
  discardExpense(memberId: string, expenseId?: string): Promise<Expense | null>;
  listExpenses(orgId: string, from: string, to: string): Promise<Expense[]>;
  setSheet(orgId: string, sheetId: string): Promise<void>;
}

export interface ExtractorPort {
  extract(data: Buffer, mimeType: string): Promise<Extraction | null>;
}

export interface SheetsPort {
  readonly enabled: boolean;
  readonly serviceAccountEmail: string | null;
  appendExpense(sheetId: string, expense: Expense, memberName: string): Promise<void>;
}

export interface Deps {
  /** Canal de WhatsApp (el de por defecto). */
  wa: MessengerPort;
  /** Canal de Telegram, si está configurado. */
  tg?: MessengerPort;
  store: StorePort;
  extractor: ExtractorPort;
  sheets: SheetsPort;
  today?: () => string;
}
