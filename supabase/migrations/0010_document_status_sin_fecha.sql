-- Estado «sin_fecha»: la factura se leyó pero no trae fecha; el bot pregunta la fecha al usuario
-- y, si responde, completa el gasto con la lectura ya guardada (sin volver a leer el archivo).
alter table papeleo_documents drop constraint if exists papeleo_documents_status_check;
alter table papeleo_documents add constraint papeleo_documents_status_check
  check (status in ('procesando', 'procesado', 'duplicado', 'no_reconocido', 'error', 'sin_fecha'));

-- Búsqueda de duplicados (número de factura + NIT) y de la fecha pendiente por miembro.
create index if not exists papeleo_documents_member_status_idx on papeleo_documents(org_id, member_id, status, created_at desc);
create index if not exists papeleo_expenses_org_numero_idx on papeleo_expenses(org_id, numero_factura);
