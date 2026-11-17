-- Renglones de cada factura (productos o servicios con su valor), para ver el detalle sin abrir el archivo.
-- Migración aditiva: no toca las tablas existentes. El servidor escribe los renglones después de guardar el gasto,
-- y si esta tabla no existe el gasto se guarda igual (el error queda en el log).

create table papeleo_expense_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references papeleo_organizations(id) on delete cascade,
  expense_id uuid not null references papeleo_expenses(id) on delete cascade,
  orden integer not null,
  descripcion text not null,
  cantidad numeric(14, 3),
  valor_unitario numeric(14, 2),
  valor_linea numeric(14, 2) not null,
  created_at timestamptz not null default now()
);
create index papeleo_expense_items_expense_idx on papeleo_expense_items(expense_id, orden);
create index papeleo_expense_items_org_idx on papeleo_expense_items(org_id);
alter table papeleo_expense_items enable row level security;

-- Solo el servidor (service_role) puede leerlos o escribirlos.
revoke all on papeleo_expense_items from public, anon, authenticated;
grant select, insert, delete on papeleo_expense_items to service_role;
