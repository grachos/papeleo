import type { InvitationState } from "./types.js";

export interface InvitationRow {
  status: "activa" | "usada" | "revocada";
  expires_at: string;
}

export interface TicketRow {
  status: "activo" | "usado" | "revocado";
  expires_at: string | null;
}

/** Estado que ve el administrador, derivado de la invitación y de su ticket vigente. */
export function invitationState(
  inv: InvitationRow,
  ticket: TicketRow | null,
  now: number,
): { state: InvitationState; ticketExpiresAt: string | null } {
  if (inv.status === "revocada") return { state: "revocada", ticketExpiresAt: null };
  if (inv.status === "usada") return { state: "vinculada", ticketExpiresAt: null };
  if (new Date(inv.expires_at).getTime() <= now) return { state: "vencida", ticketExpiresAt: null };
  if (ticket?.status === "activo" && ticket.expires_at && new Date(ticket.expires_at).getTime() > now) {
    return { state: "ticket", ticketExpiresAt: ticket.expires_at };
  }
  return { state: "pendiente", ticketExpiresAt: null };
}
