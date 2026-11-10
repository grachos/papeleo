-- Asistente de consultas en lenguaje natural (capa 1): registro de preguntas y funciones de consulta.
-- La IA nunca escribe SQL: el servidor llama estas funciones con parámetros ya validados.
--
-- Seguridad de las funciones:
--  * SECURITY INVOKER (no DEFINER) y EXECUTE solo para service_role: ni anon ni authenticated pueden llamarlas
--    por PostgREST, así que nadie puede leer otra empresa pasando su org_id.
--  * Siempre filtran por org_id y por estado = 'registrado'.
--  * Medida, agrupación y orden pasan por listas cerradas (CASE); no hay SQL dinámico.
--  * statement_timeout de 3 s y tope de filas.

create extension if not exists unaccent with schema extensions;

-- Registro de cada pregunta: memoria de la conversación, tope diario y base del aprendizaje.
create table papeleo_query_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  member_id uuid not null references papeleo_members(id) on delete cascade,
  question text not null,
  answer text,
  plan jsonb,                              -- herramientas llamadas y sus parámetros
  status text not null check (status in ('ok', 'sin_respuesta', 'error')),
  feedback text check (feedback in ('up', 'down')),
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz not null default now()
);
create index papeleo_query_log_member_idx on papeleo_query_log(member_id, created_at desc);
create index papeleo_query_log_org_idx on papeleo_query_log(org_id, created_at desc);
alter table papeleo_query_log enable row level security;

-- Escapa % _ \ para usar un valor del usuario dentro de LIKE.
create or replace function papeleo_like_escape(t text)
returns text
language sql
immutable
as $$ select replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') $$;

-- Resumen: una medida (suma, cuenta, promedio, máximo, mínimo), opcionalmente agrupada.
-- Nunca mezcla monedas: siempre agrupa también por moneda.
create or replace function papeleo_resumir(
  p_org_id uuid,
  p_medida text,
  p_agrupar text default 'ninguno',
  p_desde date default null,
  p_hasta date default null,
  p_categoria text default null,
  p_proveedor text default null,
  p_texto text default null,
  p_valor_min numeric default null,
  p_valor_max numeric default null,
  p_moneda text default null,
  p_orden text default 'valor_desc',
  p_limite integer default 12,
  p_campo text default 'total'
)
returns table (grupo text, moneda text, valor numeric, cantidad bigint, con_dato bigint, total_grupos bigint)
language plpgsql
stable
security invoker
set search_path = public, extensions
set statement_timeout = '3s'
as $$
declare
  v_limite integer := least(greatest(coalesce(p_limite, 12), 1), 24);
begin
  if coalesce(p_medida, '') not in ('suma', 'cuenta', 'promedio', 'maximo', 'minimo') then
    raise exception 'medida_invalida';
  end if;
  if coalesce(p_agrupar, '') not in ('ninguno', 'mes', 'semana', 'categoria', 'proveedor', 'medio_pago') then
    raise exception 'agrupar_invalido';
  end if;
  if coalesce(p_orden, '') not in ('valor_desc', 'valor_asc', 'grupo_asc', 'grupo_desc') then
    raise exception 'orden_invalido';
  end if;
  if coalesce(p_campo, '') not in ('total', 'subtotal', 'iva') then
    raise exception 'campo_invalido';
  end if;

  return query
  with base as (
    select e.*,
      case p_campo when 'subtotal' then e.subtotal when 'iva' then e.iva else e.total end as v_campo,
      case p_agrupar
        when 'mes' then to_char(e.fecha, 'YYYY-MM')
        when 'semana' then to_char(date_trunc('week', e.fecha), 'YYYY-MM-DD')
        when 'categoria' then e.categoria
        when 'proveedor' then unaccent(lower(coalesce(e.proveedor, '')))
        when 'medio_pago' then coalesce(e.medio_pago, '(sin dato)')
        else 'total'
      end as g_key
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
      and (p_valor_min is null or e.total >= p_valor_min)
      and (p_valor_max is null or e.total <= p_valor_max)
      and (p_moneda is null or e.moneda = upper(p_moneda))
  ),
  agg as (
    select
      b.g_key,
      case when p_agrupar = 'proveedor'
           then coalesce(nullif(min(b.proveedor), ''), '(sin proveedor)')
           else b.g_key end as g_label,
      b.moneda as g_moneda,
      case p_medida
        when 'suma' then sum(b.v_campo)
        when 'promedio' then round(avg(b.v_campo), 2)
        when 'maximo' then max(b.v_campo)
        when 'minimo' then min(b.v_campo)
        else count(*)::numeric
      end as v,
      count(*) as n,
      count(b.v_campo) as n_dato   -- facturas que sí traen ese dato (el IVA, p. ej., no siempre está)
    from base b
    group by b.g_key, b.moneda
  )
  select a.g_label, a.g_moneda, a.v, a.n, a.n_dato, count(*) over ()
  from agg a
  order by
    case p_orden when 'valor_desc' then a.v end desc nulls last,
    case p_orden when 'valor_asc' then a.v end asc nulls last,
    case p_orden when 'grupo_asc' then a.g_label end asc,
    case p_orden when 'grupo_desc' then a.g_label end desc,
    a.g_moneda
  limit v_limite;
end;
$$;

-- Lista de gastos con los mismos filtros, con el total de coincidencias para poder decir «hay 37, te muestro 10».
create or replace function papeleo_listar(
  p_org_id uuid,
  p_desde date default null,
  p_hasta date default null,
  p_categoria text default null,
  p_proveedor text default null,
  p_texto text default null,
  p_valor_min numeric default null,
  p_valor_max numeric default null,
  p_moneda text default null,
  p_orden text default 'fecha_desc',
  p_limite integer default 10
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
  v_limite integer := least(greatest(coalesce(p_limite, 10), 1), 20);
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
    and (p_valor_min is null or e.total >= p_valor_min)
    and (p_valor_max is null or e.total <= p_valor_max)
    and (p_moneda is null or e.moneda = upper(p_moneda))
  order by
    case p_orden when 'fecha_desc' then e.fecha end desc,
    case p_orden when 'fecha_asc' then e.fecha end asc,
    case p_orden when 'total_desc' then e.total end desc,
    case p_orden when 'total_asc' then e.total end asc,
    e.created_at desc
  limit v_limite;
end;
$$;

-- Solo el servidor (service_role) puede ejecutarlas.
revoke all on function papeleo_like_escape(text) from public, anon, authenticated;
revoke all on function papeleo_resumir(uuid, text, text, date, date, text, text, text, numeric, numeric, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function papeleo_listar(uuid, date, date, text, text, text, numeric, numeric, text, text, integer)
  from public, anon, authenticated;
grant execute on function papeleo_like_escape(text) to service_role;
grant execute on function papeleo_resumir(uuid, text, text, date, date, text, text, text, numeric, numeric, text, text, integer, text) to service_role;
grant execute on function papeleo_listar(uuid, date, date, text, text, text, numeric, numeric, text, text, integer) to service_role;
