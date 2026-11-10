-- Aviso del linter de Supabase (function_search_path_mutable): papeleo_like_escape no tenía search_path fijo.
-- Es una función pura que solo usa replace() (pg_catalog, siempre disponible), así que un search_path vacío es seguro.
alter function papeleo_like_escape(text) set search_path = '';
