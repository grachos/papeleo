import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Sin I, L, O, 0 ni 1 para evitar confusiones al dictar o copiar. 31^12 ≈ 7,9·10^17 combinaciones.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

/** Cuánto vive el enlace de invitación y cuánto el ticket que se genera con él. */
export const INVITATION_TTL_HOURS = 24;
export const TICKET_TTL_MINUTES = 15;

/** Token del enlace de invitación: 256 bits aleatorios en base64url (43 caracteres). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Ticket nuevo con formato XXXX-XXXX-XXXX (el mismo formato que canjea el bot). */
export function generateCode(): string {
  const raw = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Normaliza lo que escribió el usuario; null si no tiene forma de código (no se consulta la base). */
export function normalizeCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  return new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(cleaned) ? cleaned : null;
}

/** Saca el código de «/start CODIGO» (enlace profundo de Telegram) o de un mensaje que sea solo el código. */
export function extractCode(text: string): string | null {
  return normalizeCode(text.trim().replace(/^\/start(@\w+)?\s*/i, ""));
}

export function hashCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/** Compara dos textos en tiempo constante. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Limita intentos fallidos por clave (en memoria; suficiente para una sola instancia). */
export class AttemptLimiter {
  private fails = new Map<string, { count: number; since: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  allowed(key: string): boolean {
    const f = this.fails.get(key);
    if (!f) return true;
    if (this.now() - f.since >= this.windowMs) {
      this.fails.delete(key);
      return true;
    }
    return f.count < this.max;
  }

  fail(key: string): void {
    const f = this.fails.get(key);
    if (!f || this.now() - f.since >= this.windowMs) this.fails.set(key, { count: 1, since: this.now() });
    else f.count += 1;
  }

  reset(key: string): void {
    this.fails.delete(key);
  }
}
