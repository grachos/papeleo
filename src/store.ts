import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Extraction } from "./extract.js";
import { generateCode, hashCode, normalizeCode } from "./access.js";
import type { AdminCode, AdminMember, AdminPort, Expense, Member, NewExpense, Org, StorePort } from "./types.js";

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

export class SupabaseStore implements StorePort, AdminPort {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, private bucket: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async findMember(phone: string): Promise<{ member: Member; org: Org } | null> {
    const found = await this.db
      .from("papeleo_members")
      .select("id, org_id, phone, name, organization:papeleo_organizations(id, name, sheet_id)")
      .eq("phone", phone)
      .is("revoked_at", null)
      .maybeSingle();
    if (found.error) throw found.error;
    if (!found.data) return null;
    const { organization, ...member } = found.data as any;
    return { member: member as Member, org: organization as Org };
  }

  async redeemCode(code: string, phone: string, name: string | null) {
    const res = await this.db.rpc("papeleo_redeem_code", { p_hash: hashCode(code), p_phone: phone, p_name: name });
    // «ya_vinculado»: carrera con otro mensaje del mismo usuario; el canje se revirtió.
    if (res.error?.message?.includes("ya_vinculado")) return null;
    if (res.error) throw res.error;
    const row = (res.data as any[] | null)?.[0];
    if (!row) return null;
    return {
      member: { id: row.r_member_id, org_id: row.r_org_id, phone, name },
      org: { id: row.r_org_id, name: row.r_org_name, sheet_id: row.r_sheet_id },
    };
  }

  // --- Panel de administración ---

  async listOrgs() {
    const res = await this.db.from("papeleo_organizations").select("id, name").order("name");
    if (res.error) throw res.error;
    return res.data as { id: string; name: string }[];
  }

  async createCode(input: { orgId?: string; newOrgName?: string; note?: string }) {
    let orgId = input.orgId;
    let createdOrg = false;
    if (!orgId) {
      const name = input.newOrgName?.trim();
      if (!name) throw new Error("Falta el nombre de la empresa");
      const org = await this.db.from("papeleo_organizations").insert({ name }).select("id").single();
      if (org.error) throw org.error;
      orgId = org.data.id as string;
      createdOrg = true;
    }
    const code = generateCode();
    const ins = await this.db
      .from("papeleo_access_codes")
      .insert({ org_id: orgId, code_hash: hashCode(normalizeCode(code)!), note: input.note?.trim() || null })
      .select("org:papeleo_organizations(name)")
      .single();
    if (ins.error) {
      if (createdOrg) await this.db.from("papeleo_organizations").delete().eq("id", orgId);
      throw ins.error;
    }
    return { code, orgName: (ins.data as any).org.name as string };
  }

  async listCodes() {
    const res = await this.db
      .from("papeleo_access_codes")
      .select("id, note, status, created_at, used_at, org:papeleo_organizations(name)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (res.error) throw res.error;
    return (res.data as any[]).map(({ org, ...c }) => ({ ...c, org_name: org?.name ?? "" })) as AdminCode[];
  }

  async revokeCode(id: string) {
    // Solo se revoca un código que aún no se usó; para quitar a alguien ya vinculado se revoca su acceso.
    const res = await this.db.from("papeleo_access_codes").update({ status: "revocado" }).eq("id", id).eq("status", "activo");
    if (res.error) throw res.error;
  }

  async listMembers() {
    const res = await this.db
      .from("papeleo_members")
      .select("id, name, phone, created_at, revoked_at, org:papeleo_organizations(name)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (res.error) throw res.error;
    return (res.data as any[]).map(({ org, ...m }) => ({ ...m, org_name: org?.name ?? "" })) as AdminMember[];
  }

  async revokeMember(id: string) {
    const res = await this.db.from("papeleo_members").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
    if (res.error) throw res.error;
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
