-- Consumo de la lectura de cada comprobante (tokens que cobra la API), para conocer el costo real.
-- Columnas opcionales: los documentos anteriores quedan en null. Costo de ejemplo en el README.
alter table papeleo_documents
  add column if not exists extraction_model text,
  add column if not exists tokens_in integer,
  add column if not exists tokens_out integer;
