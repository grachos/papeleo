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
- **Consultas libres y humanas** (usuarios sin conocimientos técnicos): sin comandos ni frases fijas; respuestas en español sencillo, cortas, con pesos formateados, una sola pregunta aclaratoria si hay ambigüedad, memoria de la conversación. Capa 1 (✅ implementada, `src/assistant.ts`): `resumir_gastos`, `listar_gastos`, `detalle_gasto` sobre las funciones de Postgres `papeleo_resumir`/`papeleo_listar` (migración `0004`, aplicada). `buscar_conceptos` espera a la migración `0003`; `enviar_archivos` espera a Drive. **Capa 2 (SQL generado por la IA sobre vistas de solo lectura) solo con aprobación expresa del usuario.** Ver README.
- **Base de conocimiento (el sistema aprende):** no es entrenar el modelo, es recuperar contexto. `papeleo_query_log` (por empresa), `papeleo_org_glossary` (por empresa), `papeleo_knowledge` (global, curado y anonimizado por el administrador, sin datos de ninguna empresa). Las preguntas crudas nunca salen de su empresa. Ver README «Base de conocimiento».
- **Datos en Supabase; archivos en Google Drive** (5 TB del usuario). Hoy los archivos van a Supabase Storage: es deuda a migrar. En BD se guarda `drive_file_id`, no rutas. Drive es privado; el servidor reenvía los archivos por el chat, nunca enlaces públicos.
- **Nombre de archivo:** `{tipo}_{proveedor}_{fecha}_{consecutivo}`, p. ej. `fac_exito_2026-11-09_0001.jpg`; carpetas `Empresa/AAAA/MM/`. Prefijos: `fac`, `rec`, `cc`, `tiq`.
- **Cada factura guarda su detalle por concepto** (tabla `papeleo_expense_items`) para no tener que abrir el PDF. Si la suma de renglones ≠ total, marcar «revisar».
- **Portal por usuario y acceso con ticket** (pedido del 2026-11-14; detalle en README): el administrador genera un enlace; con él el usuario genera un **ticket de 15 minutos y un solo uso**, único modo de entrar al bot; el administrador puede revocar y **ve todos los registros**. El usuario hace todo desde Telegram: facturas, consultas, **Excel** y una **página HTML de solo lectura que solo abre quien se autenticó desde Telegram**. No es un programa externo ni scraping. **Etapa A (ticket) en código; B (portal web), C (Excel) y D (vista del administrador) por construir.** Reglas: sesiones y tokens solo como hash, todo filtrado en el servidor por la empresa de la sesión, enlaces de un solo uso, neutralizar fórmulas en el Excel, escapar el HTML y revocar cierra las sesiones.
- **Despliegue en Render** (servicio `papeleo`, id `srv-dbp5b0u1egvs73b3r4e0`, rama `main`, autodeploy).
- Todas las tablas, índices y buckets llevan prefijo `papeleo_` (el Supabase se comparte con otros proyectos).

## Reglas de seguridad

- **La IA nunca escribe SQL contra las tablas reales** (salvo la capa 2, si el usuario la aprueba). Las consultas usan *tool use* con herramientas expresivas pero fijas; los parámetros se validan con zod `.strict()` **sin campo `org_id`** y el servidor ejecuta funciones de Postgres parametrizadas, `SECURITY INVOKER` y solo ejecutables por `service_role`. Las herramientas del bucle son SOLO LECTURA: no agregar herramientas de escritura sin reevaluar la inyección por contenido de facturas (README «Reglas de seguridad»).
- **`org_id` siempre lo pone el código**, a partir de la identidad ya vinculada (teléfono o id de Telegram); nunca del texto del usuario ni de la IA.
- Sumas, máximos y conteos los calcula la base de datos, no el modelo.
- **Acceso solo por ticket** (ver README «Control de acceso»): el administrador crea un **enlace de invitación** (24 h, un solo uso, se gasta al vincularse); con él la persona genera un **ticket de 15 minutos y un solo uso**, que es la única forma de entrar. El no vinculado es ignorado **en silencio** (nunca responderle ni mostrarle su id). Solo hashes en la base; `GET /acceso/<token>` nunca cambia estado; las páginas con token no cachean ni envían referer; el canje es la función SQL atómica `papeleo_redeem_code` (firma estable). Panel `/admin` con `ADMIN_PASSWORD`. No volver a crear códigos que no vencen.
- Nunca escribir secretos (tokens, service role, JSON de cuenta de servicio) en el repo, en commits ni en variables de entorno vía herramientas. Se cargan en el panel de Render; el usuario los pone.
- `SUPABASE_SERVICE_ROLE_KEY` solo en el servidor.

## Relevo de sesión (2026-11-10, noche)

El usuario descansó entre el 2026-11-10 y el 2026-11-14 y ya volvió; aquellas reglas aplican **cada vez que esté ausente**: **mientras no responda, no se hacen acciones externas que requieren su visto bueno:** no aplicar migraciones, no fusionar PR, no cambiar variables de Render ni lanzar despliegues. Sí se puede revisar logs y datos (solo lectura) y preparar trabajo en local. Estado y pendientes detallados: README «Punto de partida para la próxima sesión».

Lecciones operativas de esta sesión:
- Render **no despliega solo** al fusionar a `main`: lanzar un despliegue (con aprobación) y verificar logs. Cambiar una variable por la API de Render sí dispara un despliegue.
- Si alguna variable `WHATSAPP_*` está definida en Render, el código exige las cuatro; con solo Telegram deben estar todas borradas. `ADMIN_PASSWORD` exige 12 caracteres o más.
- Tras fusionar un PR, la rama de trabajo se reinicia desde `main` y su siguiente push es forzado: **requiere permiso explícito del usuario cada vez** (el sistema lo bloquea hasta entonces). Dejar el commit en local y pedirlo.
- Siempre aplicar la migración a Supabase **antes** de fusionar/desplegar código que dependa de ella, y verificar con una transacción cancelada (sin dejar datos).

## Hoja de ruta (orden acordado)

0. ✅ **Migración `0008_invitations_tickets.sql` (etapa A) aplicada y verificada el 2026-11-14 en `real-samaria`; falta fusionar a `main` y desplegar el código** (mientras tanto el bot en vivo sigue funcionando: la función de canje conserva su firma, y los tickets sin vencimiento ya no sirven). ✅ Migraciones `0002_access_codes.sql`, `0004_query_assistant.sql` y `0005_harden_like_escape.sql` aplicadas (proyecto Supabase `real-samaria`, 2026-11-10). `0006_extraction_usage.sql` (consumo de la lectura) también aplicada y en vivo.
1. ✅ **Render arriba y probado por Telegram** (2026-11-10, servicio en vivo): código de acceso → recibo leído con Opus → pregunta respondida con la API real. Pendiente: más facturas (borrosas, PDF, con IVA) y la prueba de modelos para las preguntas (Haiku 5.5 vs Sonnet 5.5; `QUERY_MODEL` en Render está en `claude-haiku-5-5` para esa prueba). Guardar variables en Render no siempre redespliega; verificar que haya un despliegue nuevo tras cada fusión a `main`.
2. Extracción con conceptos + migración `0003` (`papeleo_expense_items`, `tipo_documento`, nombre de archivo).
3. Almacenamiento en Google Drive (el usuario crea una carpeta y la comparte como editor con la cuenta de servicio).
4. ✅ Consultas libres en lenguaje natural (capa 1) en código, con `papeleo_query_log`, 👍/👎, memoria y tope diario (incluye `campo` iva/subtotal). **Migración `0004` aplicada y verificada el 2026-11-10 en `real-samaria`** (detalle en README); falta fusionar a `main` y cargar las variables en Render. El aviso del linter sobre `papeleo_like_escape` se corrigió con la migración `0005`. La petición real a la API de Claude no se ha probado (sin credenciales en el entorno de desarrollo). El envío de archivos va después de Drive.
5. Base de conocimiento: glosario por empresa, ejemplos aprobados, pantalla «Aprendizaje» en `/admin` (migración `0007`).
6. Activar WhatsApp como segundo canal cuando llegue el número (y PDF por ese canal).

## Convenciones

- Español en mensajes al usuario, comentarios y commits. Código e identificadores técnicos como están.
- Los tests usan dependencias simuladas inyectadas (`Deps`); mantener ese patrón. El SQL de las migraciones se prueba contra Postgres real en memoria (PGlite, `tests/migrations.test.ts`): toda función SQL nueva lleva pruebas de aislamiento entre empresas y de permisos.
- Modelos (variables que mandan sobre el código): `QUERY_MODEL` (consultas; defecto `claude-opus-5-5`, en Render `claude-haiku-5-5` para la prueba) y `EXTRACTION_MODEL` (lectura de facturas; defecto `claude-opus-5-5`). **Desde el 2026-11-14 el usuario decidió leer facturas con `claude-haiku-5-5` en Render para ahorrar costo; no está verificado.** Vigilar `confianza` baja, totales/fechas erróneos y lecturas `no_reconocido`/`error` en facturas legibles; si aparecen, volver a Opus o leer con Haiku y repetir con Opus solo con confianza baja (idea no implementada). Costos medidos y comparación en el README «Modelo y costo».
- **Consumo de la lectura**: cada lectura registra modelo y tokens en `papeleo_documents` (`extraction_model`, `tokens_in`, `tokens_out`, migración `0006`). Ese registro es tolerante a fallos y nunca debe impedir procesar una factura. Consulta de costo mensual en el README «Costo real de leer facturas».
- Migraciones nuevas en `supabase/migrations/000N_*.sql`; no editar `0001_init.sql` ya aplicada.
- Trabajar en la rama indicada por la sesión; no abrir PR sin que el usuario lo pida. Si su PR ya se fusionó, reiniciar la rama desde `main` antes de seguir.
- **Documentar siempre** (orden del usuario): cada cambio de código, decisión, variable de entorno, migración o cambio de estado se refleja en `README.md` y `CLAUDE.md` en el mismo commit. Al decidir algo nuevo con el usuario, escribirlo aquí antes de dar la tarea por cerrada.
- Los secretos los carga el usuario en Render; nunca se piden ni se escriben en el repo, commits o chats.
