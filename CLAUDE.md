# CLAUDE.md

Papeleo: asistente de papeleo por WhatsApp (Node 22, TypeScript, Express). Lee facturas con Claude Opus, las guarda en Supabase y, en el futuro, las consulta en lenguaje natural. Ver `README.md` para estado, arquitectura y hoja de ruta; aquí van solo las reglas de trabajo.

## Comandos

```bash
npm install
npm test         # vitest
npm run build    # tsc
npm run dev      # requiere .env
```

Antes de dar algo por terminado: `npm test`, `npm run build` y `npm audit` sin errores.

## Decisiones del proyecto (no re-discutir sin que el usuario lo pida)

- **El chat es el front; WhatsApp es el destino final, pendiente hasta que el usuario consiga el número.** Mientras tanto se prueba por **Telegram** (bot normal; ruta `/telegram/webhook`, secreto en cabecera), mismo `handler` y respuesta por el mismo canal. Lo de WhatsApp se deja para después (variables `WHATSAPP_*`, webhook, migración `channel`/`external_id`). Telegram: fotos y PDF, botones en línea, ids con prefijo `tg:` en `papeleo_members.phone`, y **solo atiende a quien canjeó un código de acceso** (el bot es público y cada foto gasta créditos). (No confundir: antes se construyó por error un canal de Instagram; ya se eliminó.) No hay app web ni comando `ver`: el usuario pide en lenguaje natural («facturas de enero a marzo», “¿cuál fue la factura más cara?”).
- **Datos en Supabase; archivos en Google Drive** (5 TB del usuario). Hoy los archivos van a Supabase Storage: es deuda a migrar. En BD se guarda `drive_file_id`, no rutas. Drive es privado; el servidor reenvía los archivos por WhatsApp, nunca enlaces públicos.
- **Nombre de archivo:** `{tipo}_{proveedor}_{fecha}_{consecutivo}`, p. ej. `fac_exito_2026-11-09_0001.jpg`; carpetas `Empresa/AAAA/MM/`. Prefijos: `fac`, `rec`, `cc`, `tiq`.
- **Cada factura guarda su detalle por concepto** (tabla `papeleo_expense_items`) para no tener que abrir el PDF. Si la suma de renglones ≠ total, marcar «revisar».
- **Despliegue en Render** (servicio `papeleo`, id `srv-dbp5b0u1egvs73b3r4e0`, rama `main`, autodeploy).
- Todas las tablas, índices y buckets llevan prefijo `papeleo_` (el Supabase se comparte con otros proyectos).

## Reglas de seguridad

- **La IA nunca escribe SQL.** Las consultas en lenguaje natural usan *tool use* con herramientas fijas y parametrizadas (`listar_gastos`, `totales`, `detalle_gasto`, `buscar_conceptos`). Los parámetros se validan con zod y el código arma la consulta con `supabase-js`.
- **`org_id` siempre lo pone el código**, a partir del número de WhatsApp ya vinculado; nunca del texto del usuario ni de la IA.
- Sumas, máximos y conteos los calcula la base de datos, no el modelo.
- **Acceso solo por código** (ver README «Control de acceso»): código de 1 uso, sin vencimiento, solo el administrador revoca; el no vinculado es ignorado **en silencio** (nunca responderle ni mostrarle su id). Se guarda el hash, no el código. Panel `/admin` con `ADMIN_PASSWORD`; el canje es la función SQL atómica `papeleo_redeem_code`.
- Nunca escribir secretos (tokens, service role, JSON de cuenta de servicio) en el repo, en commits ni en variables de entorno vía herramientas. Se cargan en el panel de Render; el usuario los pone.
- `SUPABASE_SERVICE_ROLE_KEY` solo en el servidor.

## Hoja de ruta (orden acordado)

0. **Aplicar la migración `0002_access_codes.sql` en Supabase** (sin ella el bot no deja entrar a nadie) y poner `ADMIN_PASSWORD`.
1. Render arriba (cargar variables) y probar una factura real con Opus **por Telegram**. **Estado: despliegue caído por falta de variables de entorno; el código de Telegram ya está, sin probar contra Telegram real. Render despliega `main`: fusionar el PR antes de probar.**
2. Extracción con conceptos + migración `0003` (`papeleo_expense_items`, `tipo_documento`, nombre de archivo).
3. Almacenamiento en Google Drive (el usuario crea una carpeta y la comparte como editor con la cuenta de servicio).
4. Consultas en lenguaje natural con herramientas + envío de archivos por WhatsApp (si hay más de ~5 resultados, mandar lista y preguntar).
5. Activar WhatsApp cuando llegue el número.

## Convenciones

- Español en mensajes al usuario, comentarios y commits. Código e identificadores técnicos como están.
- Los tests (`tests/handler.test.ts`) usan dependencias simuladas inyectadas (`Deps`); mantener ese patrón para lo nuevo.
- Migraciones nuevas en `supabase/migrations/000N_*.sql`; no editar `0001_init.sql` ya aplicada.
- Trabajar en la rama indicada por la sesión; no abrir PR sin que el usuario lo pida.
