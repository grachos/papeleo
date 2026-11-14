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
  /** Mensaje con un botón que abre un enlace (en canales sin botón de enlace, el enlace va en el texto). */
  sendLink(to: string, body: string, label: string, url: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export type WhatsAppPort = MessengerPort;

export interface StorePort {
  /** Miembro vinculado y no revocado; null si no existe o se le quitó el acceso. */
  findMember(phone: string): Promise<{ member: Member; org: Org } | null>;
  /** Canjea un código (ya normalizado) por acceso. Null si no existe, ya se usó o fue revocado. */
  redeemCode(code: string, phone: string, name: string | null): Promise<{ member: Member; org: Org } | null>;
  /** Devuelve null si ese mensaje de WhatsApp ya se había recibido. */
  claimDocument(orgId: string, memberId: string, waMessageId: string, mime: string): Promise<string | null>;
  hashExists(orgId: string, sha256: string): Promise<boolean>;
  saveFile(orgId: string, documentId: string, data: Buffer, mime: string, sha256: string): Promise<void>;
  finishDocument(documentId: string, status: string, extraction?: Extraction, usage?: Usage): Promise<void>;
  saveExpense(orgId: string, memberId: string, documentId: string, expense: NewExpense): Promise<Expense>;
  /** Marca el gasto como descartado; sin expenseId descarta el último del miembro. */
  discardExpense(memberId: string, expenseId?: string): Promise<Expense | null>;
  listExpenses(orgId: string, from: string, to: string): Promise<Expense[]>;
  setSheet(orgId: string, sheetId: string): Promise<void>;
}

export type InvitationState = "pendiente" | "ticket" | "vinculada" | "vencida" | "revocada";

export interface AdminInvitation {
  id: string;
  note: string | null;
  org_name: string;
  state: InvitationState;
  created_at: string;
  expires_at: string;
  /** Cuando hay un ticket vigente sin canjear, hasta cuándo sirve. */
  ticket_expires_at: string | null;
  /** Quién se vinculó, si la invitación ya se usó. */
  linked_name: string | null;
  linked_at: string | null;
}

export interface AdminMember {
  id: string;
  name: string | null;
  phone: string;
  org_name: string;
  created_at: string;
  revoked_at: string | null;
}

/** Operaciones del panel de administración. */
export interface AdminPort {
  listOrgs(): Promise<{ id: string; name: string }[]>;
  /** Crea la invitación (y la empresa si se da `newOrgName`). El token del enlace en claro solo se devuelve aquí. */
  createInvitation(input: { orgId?: string; newOrgName?: string; note?: string }): Promise<{ token: string; orgName: string; expiresAt: string }>;
  listInvitations(): Promise<AdminInvitation[]>;
  /** Revoca una invitación sin usar y su ticket vigente. */
  revokeInvitation(id: string): Promise<void>;
  listMembers(): Promise<AdminMember[]>;
  revokeMember(id: string): Promise<void>;
}

export interface QueryFilters {
  desde?: string;
  hasta?: string;
  categoria?: string;
  proveedor?: string;
  texto?: string;
  valor_min?: number;
  valor_max?: number;
  moneda?: string;
}

export interface ResumenRow {
  grupo: string;
  moneda: string;
  valor: number;
  cantidad: number;
  /** Facturas que traen el dato pedido (el IVA o el subtotal no siempre están). */
  con_dato: number;
  total_grupos: number;
}

export interface Turn {
  question: string;
  answer: string;
}

export type QueryStatus = "ok" | "sin_respuesta" | "error";

export interface QueryLogEntry {
  orgId: string;
  memberId: string;
  question: string;
  answer: string;
  plan: unknown;
  status: QueryStatus;
  tokensIn: number;
  tokensOut: number;
}

/** Acceso de solo lectura a los gastos para el asistente. Todo se filtra por empresa; la IA nunca la elige. */
export interface QueryPort {
  resumir(
    orgId: string,
    a: QueryFilters & { medida: string; agrupar: string; orden: string; limite: number; campo: string },
  ): Promise<ResumenRow[]>;
  listar(orgId: string, a: QueryFilters & { orden: string; limite: number }): Promise<{ rows: Expense[]; total: number }>;
  detalle(orgId: string, id: string): Promise<Expense | null>;
  /** Devuelve el id del registro (para el 👍/👎). */
  logQuery(entry: QueryLogEntry): Promise<string>;
  recentTurns(memberId: string, sinceIso: string, limit: number): Promise<Turn[]>;
  countSince(memberId: string, sinceIso: string): Promise<number>;
  setFeedback(logId: string, memberId: string, value: "up" | "down"): Promise<void>;
}

export interface AssistantInput {
  orgId: string;
  question: string;
  today: string;
  history: Turn[];
}

export interface AssistantResult {
  text: string;
  status: QueryStatus;
  plan: unknown;
  tokensIn: number;
  tokensOut: number;
}

export interface AssistantPort {
  answer(input: AssistantInput): Promise<AssistantResult>;
}

/** Tokens que cobró la API por una llamada (entrada incluye los leídos y escritos en caché). */
export interface Usage {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ExtractionResult {
  /** null si el modelo no produjo una lectura válida (aun así hubo consumo). */
  extraction: Extraction | null;
  usage: Usage;
}

/** Operaciones de la página pública del enlace de invitación. */
export interface InvitePort {
  /** Genera (o renueva) el ticket de una invitación vigente; null si no existe, venció, se revocó o ya se usó. */
  issueTicket(token: string): Promise<{ ticket: string; orgName: string; expiresAt: string } | null>;
}

export interface PanelSession {
  memberId: string;
  orgId: string;
  orgName: string;
  memberName: string | null;
}

export interface PanelFilters {
  desde?: string;
  hasta?: string;
  categoria?: string;
  proveedor?: string;
  texto?: string;
}

/** Sesiones y listado del panel web. La empresa sale siempre de la sesión, nunca de la petición. */
export interface PanelPort {
  /** Canjea el enlace de entrada (un solo uso) y devuelve el token de sesión en claro, o null. */
  consumeLogin(token: string): Promise<string | null>;
  /** Valida la sesión y la prolonga; null si no existe, venció, se revocó o la persona perdió el acceso. */
  session(sessionToken: string): Promise<PanelSession | null>;
  endSession(sessionToken: string): Promise<void>;
  list(orgId: string, filters: PanelFilters, page: number, pageSize: number): Promise<{ rows: Expense[]; total: number }>;
}

/** Crea el enlace que el bot le entrega a una persona vinculada para abrir el panel. */
export interface PortalPort {
  createLoginLink(memberId: string): Promise<string | null>;
}

export interface ExtractorPort {
  extract(data: Buffer, mimeType: string): Promise<ExtractionResult>;
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
  /** Asistente de consultas en lenguaje natural (si falta, el texto libre recibe la ayuda). */
  assistant?: AssistantPort;
  /** Enlace de entrada al panel web (si falta, el comando «panel» responde que no está disponible). */
  portal?: PortalPort;
  query?: QueryPort;
  /** Máximo de preguntas por persona y día (por defecto 40). */
  dailyCap?: number;
  /** Límite de intentos de canje fallidos por remitente (opcional). */
  limiter?: { allowed(key: string): boolean; fail(key: string): void; reset(key: string): void };
}
