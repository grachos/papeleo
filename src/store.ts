import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Extraction } from "./extract.js";
import type { Expense, Member, NewExpense, Org, StorePort } from "./types.js";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

const EXPENSE_COLUMNS =
  "id, fecha, proveedor, nit, numero_factura, subtotal, iva, total, moneda, categoria, medio_pago, descripcion, confianza";

function toExpense(row: any): Expense {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { ...row, subtotal: num(row.subtotal), iva: num(row.iva), total: Number(row.total) };
}

export class SupabaseStore implements StorePort {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, private bucket: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async findOrCreateMember(
    phone: string,
    name: string | null,
  ): Promise<{ member: Member; org: Org; isNew: boolean }> {
    const found = await this.db
      .from("papeleo_members")
      .select("id, org_id, phone, name, organization:papeleo_organizations(id, name, sheet_id)")
      .eq("phone", phone)
      .maybeSingle();
    if (found.error) throw found.error;
    if (found.data) {
      const { organization, ...member } = found.data as any;
      return { member: member as Member, org: organization as Org, isNew: false };
    }

    // Número desconocido: se le crea su propia organización (registro autoservicio).
    const org = await this.db
      .from("papeleo_organizations")
      .insert({ name: name ?? phone })
      .select("id, name, sheet_id")
      .single();
    if (org.error) throw org.error;

    const member = await this.db
      .from("papeleo_members")
      .insert({ org_id: org.data.id, phone, name })
      .select("id, org_id, phone, name")
      .single();
    if (member.error) {
      await this.db.from("papeleo_organizations").delete().eq("id", org.data.id);
      // Dos mensajes simultáneos del mismo número nuevo: el otro ganó, se reutiliza.
      if (member.error.code === "23505") return this.findOrCreateMember(phone, name);
      throw member.error;
    }
    return { member: member.data as Member, org: org.data as Org, isNew: true };
  }

  async claimDocument(orgId: string, memberId: string, waMessageId: string, mime: string) {
    const res = await this.db
      .from("papeleo_documents")
      .insert({ org_id: orgId, member_id: memberId, wa_message_id: waMessageId, mime_type: mime })
      .select("id")
      .single();
    if (res.error?.code === "23505") return null;
    if (res.error) throw res.error;
    return res.data.id as string;
  }

  async hashExists(orgId: string, sha256: string) {
    const res = await this.db
      .from("papeleo_documents")
      .select("id")
      .eq("org_id", orgId)
      .eq("sha256", sha256)
      .eq("status", "procesado")
      .limit(1);
    if (res.error) throw res.error;
    return res.data.length > 0;
  }

  async saveFile(orgId: string, documentId: string, data: Buffer, mime: string, sha256: string) {
    const path = `${orgId}/${new Date().toISOString().slice(0, 7)}/${documentId}.${EXT[mime] ?? "bin"}`;
    const up = await this.db.storage.from(this.bucket).upload(path, data, { contentType: mime });
    if (up.error) throw up.error;
    const res = await this.db.from("papeleo_documents").update({ storage_path: path, sha256 }).eq("id", documentId);
    if (res.error) throw res.error;
  }

  async finishDocument(documentId: string, status: string, extraction?: Extraction) {
    const res = await this.db
      .from("papeleo_documents")
      .update({ status, extraction: extraction ?? null, doc_type: extraction?.tipo ?? null })
      .eq("id", documentId);
    if (res.error) throw res.error;
  }

  async saveExpense(orgId: string, memberId: string, documentId: string, expense: NewExpense) {
    const res = await this.db
      .from("papeleo_expenses")
      .insert({ ...expense, org_id: orgId, member_id: memberId, document_id: documentId })
      .select(EXPENSE_COLUMNS)
      .single();
    if (res.error) throw res.error;
    return toExpense(res.data);
  }

  async discardExpense(memberId: string, expenseId?: string) {
    let target = expenseId;
    if (!target) {
      const last = await this.db
        .from("papeleo_expenses")
        .select("id")
        .eq("member_id", memberId)
        .eq("estado", "registrado")
        .order("created_at", { ascending: false })
        .limit(1);
      if (last.error) throw last.error;
      target = last.data[0]?.id;
      if (!target) return null;
    }
    // El filtro por member_id impide descartar gastos de otra persona con un id ajeno.
    const res = await this.db
      .from("papeleo_expenses")
      .update({ estado: "descartado" })
      .eq("id", target)
      .eq("member_id", memberId)
      .eq("estado", "registrado")
      .select(EXPENSE_COLUMNS)
      .maybeSingle();
    if (res.error) throw res.error;
    return res.data ? toExpense(res.data) : null;
  }

  async listExpenses(orgId: string, from: string, to: string) {
    const res = await this.db
      .from("papeleo_expenses")
      .select(EXPENSE_COLUMNS)
      .eq("org_id", orgId)
      .eq("estado", "registrado")
      .gte("fecha", from)
      .lte("fecha", to);
    if (res.error) throw res.error;
    return res.data.map(toExpense);
  }

  async setSheet(orgId: string, sheetId: string) {
    const res = await this.db.from("papeleo_organizations").update({ sheet_id: sheetId }).eq("id", orgId);
    if (res.error) throw res.error;
  }
}
