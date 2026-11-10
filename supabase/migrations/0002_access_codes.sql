-- Control de acceso: solo entran quienes canjean un código creado por el administrador.
-- Cada código es de un solo uso y no vence; solo el administrador los revoca.

alter table papeleo_members add column if not exists revoked_at timestamptz;

create table papeleo_access_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  code_hash text not null unique,        -- sha256 del código; el código en claro no se guarda
  note text,                             -- para quién es (lo escribe el administrador)
  status text not null default 'activo' check (status in ('activo', 'usado', 'revocado')),
  used_by_member_id uuid references papeleo_members(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index papeleo_access_codes_org_idx on papeleo_access_codes(org_id);

alter table papeleo_access_codes enable row level security;

-- Canje atómico: marca el código como usado y vincula (o reactiva) al miembro en una sola transacción.
-- No devuelve filas si el código no existe, ya se usó o fue revocado.
create or replace function papeleo_redeem_code(p_hash text, p_phone text, p_name text)
returns table (r_member_id uuid, r_org_id uuid, r_org_name text, r_sheet_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code papeleo_access_codes%rowtype;
  v_member papeleo_members%rowtype;
  v_member_id uuid;
begin
  update papeleo_access_codes
     set status = 'usado', used_at = now()
   where code_hash = p_hash and status = 'activo'
  returning * into v_code;
  if not found then
    return;
  end if;

  select * into v_member from papeleo_members where phone = p_phone;
  if found then
    if v_member.revoked_at is null then
      raise exception 'ya_vinculado';   -- revierte también el canje del código
    end if;
    update papeleo_members
       set revoked_at = null, org_id = v_code.org_id, name = coalesce(p_name, name)
     where id = v_member.id;
    v_member_id := v_member.id;
  else
    insert into papeleo_members (org_id, phone, name)
    values (v_code.org_id, p_phone, p_name)
    returning id into v_member_id;
  end if;

  update papeleo_access_codes set used_by_member_id = v_member_id where id = v_code.id;

  return query
    select v_member_id, o.id, o.name, o.sheet_id
      from papeleo_organizations o
     where o.id = v_code.org_id;
end;
$$;

revoke all on function papeleo_redeem_code(text, text, text) from public, anon, authenticated;
