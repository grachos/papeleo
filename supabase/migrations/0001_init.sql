-- Núcleo multiempresa + módulo de gastos.
-- Todo cuelga de papeleo_organizations; el servidor usa la service role key.
-- RLS queda activo y sin políticas: ningún cliente anónimo puede leer nada.

create extension if not exists pgcrypto;

create table papeleo_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sheet_id text,                       -- hoja de Google donde se copian los gastos (opcional)
  created_at timestamptz not null default now()
);

create table papeleo_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  phone text not null unique,          -- formato WhatsApp: 573001234567
  name text,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now()
);
create index papeleo_members_org_idx on papeleo_members(org_id);

-- Un registro por archivo recibido, sea del módulo que sea.
create table papeleo_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  member_id uuid not null references papeleo_members(id),
  wa_message_id text not null unique,  -- idempotencia: Meta reintenta los webhooks
  mime_type text not null,
  storage_path text,
  sha256 text,
  doc_type text,
  status text not null default 'procesando'
    check (status in ('procesando', 'procesado', 'duplicado', 'no_reconocido', 'error')),
  extraction jsonb,
  created_at timestamptz not null default now()
);
create index papeleo_documents_org_hash_idx on papeleo_documents(org_id, sha256);

create table papeleo_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  member_id uuid not null references papeleo_members(id),
  document_id uuid not null references papeleo_documents(id) on delete cascade,
  fecha date not null,
  proveedor text,
  nit text,
  numero_factura text,
  subtotal numeric(14, 2),
  iva numeric(14, 2),
  total numeric(14, 2) not null,
  moneda text not null default 'COP',
  categoria text not null,
  medio_pago text,
  descripcion text,
  confianza text not null,
  estado text not null default 'registrado' check (estado in ('registrado', 'descartado')),
  created_at timestamptz not null default now()
);
create index papeleo_expenses_org_fecha_idx on papeleo_expenses(org_id, fecha);
create index papeleo_expenses_member_idx on papeleo_expenses(member_id, created_at desc);

alter table papeleo_organizations enable row level security;
alter table papeleo_members enable row level security;
alter table papeleo_documents enable row level security;
alter table papeleo_expenses enable row level security;

-- Bucket privado para los archivos originales.
insert into storage.buckets (id, name, public)
values ('papeleo-documentos', 'papeleo-documentos', false)
on conflict (id) do nothing;
