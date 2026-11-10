# CLAUDE.md

Papeleo: asistente de papeleo por chat (Telegram y WhatsApp), en Node 22, TypeScript y Express. Lee facturas con Claude Opus, las guarda en Supabase y las consulta en lenguaje natural para gente del común. Ver `README.md` para estado, arquitectura y hoja de ruta; aquí van solo las reglas de trabajo.

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
- **Telegram y WhatsApp son canales equivalentes** (herramientas intercambiables sobre el mismo núcleo): ambos activos a la vez, mismo `handler`, mismo acceso, respuesta por el canal de origen. Un canal nuevo = adaptador `MessengerPort` + lector de webhook + ruta; nunca tocar la lógica de negocio por un canal.
- **Consultas libres y humanas** (usuarios sin conocimientos técnicos): sin comandos ni frases fijas; respuestas en español sencillo, cortas, con pesos formateados, una sola pregunta aclaratoria si hay ambigüedad, memoria de la conversación. Capa 1 (✅ implementada, `src/assistant.ts`): `resumir_gastos`, `listar_gastos`, `detalle_gasto` sobre las funciones de Postgres `papeleo_resumir`/`papeleo_listar` (migración `0004`, por aplicar). `buscar_conceptos` espera a la migración `0003`; `enviar_archivos` espera a Drive. **Capa 2 (SQL generado por la IA sobre vistas de solo lectura) solo con aprobación expresa del usuario.** Ver README.
- **Base de conocimiento (el sistema aprende):** no es entrenar el modelo, es recuperar contexto. `papeleo_query_log` (por empresa), `papeleo_org_glossary` (por empresa), `papeleo_knowledge` (global, curado y anonimizado por el administrador, sin datos de ninguna empresa). Las preguntas crudas nunca salen de su empresa. Ver README «Base de conocimiento».
- **Datos en Supabase; archivos en Google Drive** (5 TB del usuario). Hoy los archivos van a Supabase Storage: es deuda a migrar. En BD se guarda `drive_file_id`, no rutas. Drive es privado; el servidor reenvía los archivos por el chat, nunca enlaces públicos.
- **Nombre de archivo:** `{tipo}_{proveedor}_{fecha}_{consecutivo}`, p. ej. `fac_exito_2026-11-09_0001.jpg`; carpetas `Empresa/AAAA/MM/`. Prefijos: `fac`, `rec`, `cc`, `tiq`.
- **Cada factura guarda su detalle por concepto** (tabla `papeleo_expense_items`) para no tener que abrir el PDF. Si la suma de renglones ≠ total, marcar «revisar».
- **Despliegue en Render** (servicio `papeleo`, id `srv-dbp5b0u1egvs73b3r4e0`, rama `main`, autodeploy).
- Todas las tablas, índices y buckets llevan prefijo `papeleo_` (el Supabase se comparte con otros proyectos).

## Reglas de seguridad

- **La IA nunca escribe SQL contra las tablas reales** (salvo la capa 2, si el usuario la aprueba). Las consultas usan *tool use* con herramientas expresivas pero fijas; los parámetros se validan con zod `.strict()` **sin campo `org_id`** y el servidor ejecuta funciones de Postgres parametrizadas, `SECURITY INVOKER` y solo ejecutables por `service_role`. Las herramientas del bucle son SOLO LECTURA: no agregar herramientas de escritura sin reevaluar la inyección por contenido de facturas (README «Reglas de seguridad»).
- **`org_id` siempre lo pone el código**, a partir de la identidad ya vinculada (teléfono o id de Telegram); nunca del texto del usuario ni de la IA.
- Sumas, máximos y conteos los calcula la base de datos, no el modelo.
- **Acceso solo por código** (ver README «Control de acceso»): código de 1 uso, sin vencimiento, solo el administrador revoca; el no vinculado es ignorado **en silencio** (nunca responderle ni mostrarle su id). Se guarda el hash, no el código. Panel `/admin` con `ADMIN_PASSWORD`; el canje es la función SQL atómica `papeleo_redeem_code`.
- Nunca escribir secretos (tokens, service role, JSON de cuenta de servicio) en el repo, en commits ni en variables de entorno vía herramientas. Se cargan en el panel de Render; el usuario los pone.
- `SUPABASE_SERVICE_ROLE_KEY` solo en el servidor.

## Hoja de ruta (orden acordado)

0. ✅ Migración `0002_access_codes.sql` aplicada (proyecto Supabase `real-samaria`, 2026-11-10).
1. **Render arriba**: `main` ya tiene el código; faltan las variables de entorno (README «Dónde conseguir cada dato») y probar una factura real con Opus **por Telegram**. Sin probar contra Telegram real.
2. Extracción con conceptos + migración `0003` (`papeleo_expense_items`, `tipo_documento`, nombre de archivo).
3. Almacenamiento en Google Drive (el usuario crea una carpeta y la comparte como editor con la cuenta de servicio).
4. ✅ Consultas libres en lenguaje natural (capa 1) en código, con `papeleo_query_log`, 👍/👎, memoria y tope diario (incluye `campo` iva/subtotal). **Orden obligatorio: aplicar `0004` → verificarla → recién entonces fusionar a `main`** (si no, el bot no responde preguntas libres). La petición real a la API de Claude no se ha probado (sin credenciales en el entorno de desarrollo). El envío de archivos va después de Drive.
5. Base de conocimiento: glosario por empresa, ejemplos aprobados, pantalla «Aprendizaje» en `/admin` (migración `0005`).
6. Activar WhatsApp como segundo canal cuando llegue el número (y PDF por ese canal).

## Convenciones

- Español en mensajes al usuario, comentarios y commits. Código e identificadores técnicos como están.
- Los tests usan dependencias simuladas inyectadas (`Deps`); mantener ese patrón. El SQL de las migraciones se prueba contra Postgres real en memoria (PGlite, `tests/migrations.test.ts`): toda función SQL nueva lleva pruebas de aislamiento entre empresas y de permisos.
- Modelo de las consultas: variable `QUERY_MODEL` (por defecto `claude-opus-5-5`); `claude-sonnet-5-5` es la opción más económica si el usuario lo decide.
- Migraciones nuevas en `supabase/migrations/000N_*.sql`; no editar `0001_init.sql` ya aplicada.
- Trabajar en la rama indicada por la sesión; no abrir PR sin que el usuario lo pida. Si su PR ya se fusionó, reiniciar la rama desde `main` antes de seguir.
- **Documentar siempre** (orden del usuario): cada cambio de código, decisión, variable de entorno, migración o cambio de estado se refleja en `README.md` y `CLAUDE.md` en el mismo commit. Al decidir algo nuevo con el usuario, escribirlo aquí antes de dar la tarea por cerrada.
- Los secretos los carga el usuario en Render; nunca se piden ni se escriben en el repo, commits o chats.
