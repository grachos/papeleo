-- Acceso con enlace de invitación y ticket de 15 minutos (etapa A del portal por usuario).
--
-- Flujo: el administrador crea una invitación (enlace de un solo uso, vence a las 24 h). Con el enlace, la persona
-- genera un ticket de 15 minutos (puede generar otro si se le pasa el tiempo, y el anterior queda sin efecto).
-- La invitación se gasta cuando el ticket se canjea en el chat y la identidad queda vinculada.
--
-- Esta migración es aditiva: la función papeleo_redeem_code conserva su firma, así que el servidor que ya está
-- en marcha sigue funcionando al aplicarla; solo exige que el ticket no haya vencido.

alter table papeleo_access_codes add column if not exists expires_at timestamptz;

-- Los códigos anteriores no vencían. El ticket pasa a ser la única forma de entrar: se retiran los que sigan sin usar.
update papeleo_access_codes set status = 'revocado' where status = 'activo' and expires_at is null;

create table papeleo_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  token_hash text not null unique,        -- sha256 del token del enlace; el token en claro no se guarda
  note text,                              -- para quién es (lo escribe el administrador)
  status text not null default 'activa' check (status in ('activa', 'usada', 'revocada')),
  expires_at timestamptz not null,
  ticket_id uuid references papeleo_access_codes(id) on delete set null,   -- ticket vigente
  used_member_id uuid references papeleo_members(id) on delete set null,   -- quién se vinculó
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index papeleo_invitations_org_idx on papeleo_invitations(org_id);
create index papeleo_invitations_ticket_idx on papeleo_invitations(ticket_id);
alter table papeleo_invitations enable row level security;

-- Emite (o renueva) el ticket de una invitación vigente. Si ya había un ticket sin canjear, lo deja sin efecto.
-- No devuelve filas si la invitación no existe, venció, fue revocada o ya se usó.
create or replace function papeleo_issue_ticket(p_token_hash text, p_ticket_hash text, p_ticket_minutes integer default 15)
returns table (r_org_name text, r_expires_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inv papeleo_invitations%rowtype;
  v_ticket_id uuid;
  v_exp timestamptz;
begin
  if p_ticket_minutes is null or p_ticket_minutes < 1 or p_ticket_minutes > 60 then
    raise exception 'minutos_invalidos';
  end if;

  select * into v_inv
    from papeleo_invitations
   where token_hash = p_token_hash and status = 'activa' and expires_at > now()
   for update;
  if not found then
    return;
  end if;

  if v_inv.ticket_id is not null then
    update papeleo_access_codes set status = 'revocado' where id = v_inv.ticket_id and status = 'activo';
  end if;

  -- El ticket nunca dura más que la propia invitación.
  v_exp := least(now() + make_interval(mins => p_ticket_minutes), v_inv.expires_at);
  insert into papeleo_access_codes (org_id, code_hash, note, expires_at)
  values (v_inv.org_id, p_ticket_hash, v_inv.note, v_exp)
  returning id into v_ticket_id;

  update papeleo_invitations set ticket_id = v_ticket_id where id = v_inv.id;

  return query select o.name, v_exp from papeleo_organizations o where o.id = v_inv.org_id;
end;
$$;

-- Revoca una invitación que aún no se usó y el ticket que tuviera sin canjear, en una sola transacción.
create or replace function papeleo_revoke_invitation(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ticket uuid;
begin
  update papeleo_invitations set status = 'revocada'
   where id = p_id and status = 'activa'
  returning ticket_id into v_ticket;
  if found and v_ticket is not null then
    update papeleo_access_codes set status = 'revocado' where id = v_ticket and status = 'activo';
  end if;
end;
$$;

-- Canje de un ticket: misma firma que antes. Ahora exige que no haya vencido y marca la invitación como usada
-- en la misma transacción que vincula (o reactiva) a la persona.
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
   where code_hash = p_hash and status = 'activo' and expires_at > now()
  returning * into v_code;
  if not found then
    return;
  end if;

  select * into v_member from papeleo_members where phone = p_phone;
  if found then
    if v_member.revoked_at is null then
      raise exception 'ya_vinculado';   -- revierte también el canje del ticket
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
  update papeleo_invitations
     set status = 'usada', used_member_id = v_member_id, used_at = now()
   where ticket_id = v_code.id and status = 'activa';

  return query
    select v_member_id, o.id, o.name, o.sheet_id
      from papeleo_organizations o
     where o.id = v_code.org_id;
end;
$$;

-- Solo el servidor (service_role) puede ejecutarlas.
revoke all on function papeleo_issue_ticket(text, text, integer) from public, anon, authenticated;
revoke all on function papeleo_revoke_invitation(uuid) from public, anon, authenticated;
revoke all on function papeleo_redeem_code(text, text, text) from public, anon, authenticated;
grant execute on function papeleo_issue_ticket(text, text, integer) to service_role;
grant execute on function papeleo_revoke_invitation(uuid) to service_role;
grant execute on function papeleo_redeem_code(text, text, text) to service_role;
