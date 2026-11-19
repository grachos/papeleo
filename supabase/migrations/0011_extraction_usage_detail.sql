-- Consumo de la lectura, por proveedor. Hasta ahora tokens_in/tokens_out sumaban todo el consumo de OpenAI.
-- Se conservan esas columnas (total de OpenAI) y se agrega el detalle:
--   * vision_tokens_in/out: la parte del total que fue la lectura de la imagen con visión (comprobantes manuscritos o sin fecha).
--     Lectura de texto = total - visión.
--   * llamaparse_pages/credits: LlamaParse no cobra por tokens sino por créditos por página.
--     Los créditos pueden venir vacíos si la facturación aún no los registró; las páginas siempre se cuentan.
-- Columnas opcionales: los documentos anteriores quedan en null.
alter table papeleo_documents
  add column if not exists vision_tokens_in integer,
  add column if not exists vision_tokens_out integer,
  add column if not exists llamaparse_pages integer,
  add column if not exists llamaparse_credits numeric(12, 4);
