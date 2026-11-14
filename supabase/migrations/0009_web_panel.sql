-- Etapa B del portal: panel web de solo lectura al que solo se entra desde Telegram.
--
-- Flujo: el bot entrega un enlace de entrada (un solo uso, 5 minutos) ligado a la persona. Al abrirlo y confirmar se
-- crea una sesión guardada en la base (no una cookie firmada), de modo que revocar a la persona corta el acceso en la
-- siguiente petición y la inactividad vence la sesión. Solo se guardan hashes de los tokens.
--
-- Migración aditiva: no toca ninguna función ni tabla existente, así que el servicio en marcha no se afecta.

create table papeleo_web_logins (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references papeleo_members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index papeleo_web_logins_member_idx on papeleo_web_logins(member_id);
alter table papeleo_web_logins enable row level security;

create table papeleo_web_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references papeleo_members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,          -- vence por inactividad y nunca pasa del tope absoluto
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index papeleo_web_sessions_member_idx on papeleo_web_sessions(member_id);
alter table papeleo_web_sessions enable row level security;

-- Crea el enlace de entrada de una persona activa. Devuelve false si la persona no existe o está revocada.
-- De paso borra lo vencido hace más de un día para que las tablas no crezcan sin fin.
create or replace function papeleo_web_login_create(p_member_id uuid, p_token_hash text, p_minutes integer default 5)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_n integer;
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 30 then
    raise exception 'minutos_invalidos';
  end if;

  delete from papeleo_web_logins where expires_at < now() - interval '1 day';
  delete from papeleo_web_sessions
   where expires_at < now() - interval '1 day' or revoked_at < now() - interval '1 day';

  insert into papeleo_web_logins (member_id, token_hash, expires_at)
  select m.id, p_token_hash, now() + make_interval(mins => p_minutes)
    from papeleo_members m
   where m.id = p_member_id and m.revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- Canjea el enlace (una sola vez, sin vencer, con la persona aún activa) y abre la sesión, todo en una transacción.
create or replace function papeleo_web_login_consume(p_token_hash text, p_session_hash text, p_idle_minutes integer default 30)
returns table (r_member_id uuid, r_org_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_member uuid;
  v_org uuid;
begin
  if p_idle_minutes is null or p_idle_minutes < 1 or p_idle_minutes > 120 then
    raise exception 'minutos_invalidos';
  end if;

  update papeleo_web_logins l
     set used_at = now()
    from papeleo_members m
   where l.token_hash = p_token_hash and l.used_at is null and l.expires_at > now()
     and m.id = l.member_id and m.revoked_at is null
  returning l.member_id, m.org_id into v_member, v_org;
  if not found then
    return;
  end if;

  insert into papeleo_web_sessions (member_id, token_hash, expires_at)
  values (v_member, p_session_hash, now() + make_interval(mins => p_idle_minutes));

  return query select v_member, v_org;
end;
$$;

-- Valida la sesión en cada petición y la prolonga. Falla si está revocada, venció por inactividad o por el tope
-- absoluto, o si la persona fue revocada. La empresa sale SOLO de aquí, nunca de la petición.
create or replace function papeleo_web_session_touch(p_session_hash text, p_idle_minutes integer default 30, p_max_hours integer default 8)
returns table (r_member_id uuid, r_org_id uuid, r_org_name text, r_member_name text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_member uuid;
  v_org uuid;
  v_name text;
begin
  if p_idle_minutes is null or p_idle_minutes < 1 or p_idle_minutes > 120
     or p_max_hours is null or p_max_hours < 1 or p_max_hours > 24 then
    raise exception 'minutos_invalidos';
  end if;

  update papeleo_web_sessions s
     set last_seen_at = now(),
         expires_at = least(now() + make_interval(mins => p_idle_minutes), s.created_at + make_interval(hours => p_max_hours))
    from papeleo_members m
   where s.token_hash = p_session_hash and s.revoked_at is null and s.expires_at > now()
     and s.created_at + make_interval(hours => p_max_hours) > now()
     and m.id = s.member_id and m.revoked_at is null
  returning s.member_id, m.org_id, m.name into v_member, v_org, v_name;
  if not found then
    return;
  end if;

  return query select v_member, v_org, o.name, v_name from papeleo_organizations o where o.id = v_org;
end;
$$;

create or replace function papeleo_web_session_end(p_session_hash text)
returns void
language sql
security invoker
set search_path = public
as $$
  update papeleo_web_sessions set revoked_at = now() where token_hash = p_session_hash and revoked_at is null;
$$;

-- Lista paginada para el panel: mismos filtros que papeleo_listar, con desplazamiento y tope de 50 por página.
create or replace function papeleo_panel_listar(
  p_org_id uuid,
  p_desde date default null,
  p_hasta date default null,
  p_categoria text default null,
  p_proveedor text default null,
  p_texto text default null,
  p_moneda text default null,
  p_orden text default 'fecha_desc',
  p_limite integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid, fecha date, proveedor text, nit text, numero_factura text, subtotal numeric, iva numeric, total numeric,
  moneda text, categoria text, medio_pago text, descripcion text, confianza text, total_filas bigint
)
language plpgsql
stable
security invoker
set search_path = public, extensions
set statement_timeout = '3s'
as $$
declare
  v_limite integer := least(greatest(coalesce(p_limite, 25), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
begin
  if coalesce(p_orden, '') not in ('fecha_desc', 'fecha_asc', 'total_desc', 'total_asc') then
    raise exception 'orden_invalido';
  end if;

  return query
  select e.id, e.fecha, e.proveedor, e.nit, e.numero_factura, e.subtotal, e.iva, e.total, e.moneda,
         e.categoria, e.medio_pago, e.descripcion, e.confianza, count(*) over ()
  from papeleo_expenses e
  where e.org_id = p_org_id
    and e.estado = 'registrado'
    and (p_desde is null or e.fecha >= p_desde)
    and (p_hasta is null or e.fecha <= p_hasta)
    and (p_categoria is null or e.categoria = p_categoria)
    and (p_proveedor is null
         or unaccent(lower(coalesce(e.proveedor, ''))) like '%' || unaccent(lower(papeleo_like_escape(p_proveedor))) || '%' escape '\')
    and (p_texto is null
         or unaccent(lower(coalesce(e.proveedor, '') || ' ' || coalesce(e.descripcion, ''))) like '%' || unaccent(lower(papeleo_like_escape(p_texto))) || '%' escape '\')
    and (p_moneda is null or e.moneda = upper(p_moneda))
  order by
    case p_orden when 'fecha_desc' then e.fecha end desc,
    case p_orden when 'fecha_asc' then e.fecha end asc,
    case p_orden when 'total_desc' then e.total end desc,
    case p_orden when 'total_asc' then e.total end asc,
    e.created_at desc, e.id
  limit v_limite offset v_offset;
end;
$$;

-- Solo el servidor (service_role) puede ejecutarlas.
revoke all on function papeleo_web_login_create(uuid, text, integer) from public, anon, authenticated;
revoke all on function papeleo_web_login_consume(text, text, integer) from public, anon, authenticated;
revoke all on function papeleo_web_session_touch(text, integer, integer) from public, anon, authenticated;
revoke all on function papeleo_web_session_end(text) from public, anon, authenticated;
revoke all on function papeleo_panel_listar(uuid, date, date, text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function papeleo_web_login_create(uuid, text, integer) to service_role;
grant execute on function papeleo_web_login_consume(text, text, integer) to service_role;
grant execute on function papeleo_web_session_touch(text, integer, integer) to service_role;
grant execute on function papeleo_web_session_end(text) to service_role;
grant execute on function papeleo_panel_listar(uuid, date, date, text, text, text, text, text, integer, integer) to service_role;
