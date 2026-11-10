# Papeleo

Asistente de papeleo por mensajería. El usuario envía fotos o PDF de facturas y comprobantes; el servicio los lee con IA (Claude Opus, incluso si están borrosos), los registra en una base de datos y, más adelante, permite consultarlos en lenguaje natural desde el mismo chat. **El chat es el front** (no hay aplicación web). Canales: **Telegram activo para pruebas** y **WhatsApp, destino final, pendiente hasta tener el número de teléfono**.

## Estado actual

| Pieza | Estado |
|---|---|
| Webhook de WhatsApp (firma, idempotencia) | ✅ Hecho, 🕒 sin activar hasta tener el número |
| Canal de Telegram para pruebas | ✅ Hecho (fotos, PDF, texto, botón «Descartar»); sin probar contra Telegram real |
| Control de acceso por códigos + panel `/admin` | ✅ Hecho; migración `0002` aplicada el 2026-11-10 en el proyecto `real-samaria` de Supabase |
| Lectura de comprobantes con Claude (foto/PDF) | ✅ Hecho, **sin probar con una factura real** (los tests usan un lector simulado) |
| Registro en Supabase (esquema multiempresa, prefijo `papeleo_`) | ✅ Hecho |
| Detección de duplicados (sha256) | ✅ Hecho |
| Comandos `resumen`, `borrar`, `hoja` | ✅ Hecho |
| Copia opcional de cada gasto a Google Sheets | ✅ Hecho |
| Guardar el detalle por concepto de cada factura | ⏳ Pendiente (hoy solo hay un `descripcion` por factura) |
| Archivos en Google Drive (hoy van a Supabase Storage) | ⏳ Pendiente |
| Consultas libres en lenguaje natural (capa 1: `resumir_gastos`, `listar_gastos`, `detalle_gasto`) | ✅ Hecho en código, con 13 pruebas del SQL contra Postgres real; **falta aplicar la migración `0004` en Supabase** y probarlo con datos reales |
| Envío de archivos por el chat (`enviar_archivos`) | ⏳ Pendiente: va después de Google Drive |
| Base de conocimiento: el sistema aprende de las preguntas | ⏳ Pendiente (diseño en «Base de conocimiento») |
| Despliegue en Render | ⚠️ Servicio creado, `main` ya tiene el código nuevo, pero **faltan las variables de entorno** (ver «Dónde conseguir cada dato») |

## Arquitectura

```
Telegram ──► POST /telegram/webhook ─┐   (Express, Render; la respuesta sale
WhatsApp ──► POST /webhook ──────────┘    por el mismo canal por el que llegó)
                 │
                 ├─ descarga el archivo (Graph API)
                 ├─ sha256 → ¿duplicado? → responde y termina
                 ├─ guarda el archivo (hoy Supabase Storage → destino: Google Drive)
                 ├─ extrae datos con Claude Opus (salida validada con zod)
                 ├─ guarda en Supabase (papeleo_documents / papeleo_expenses)
                 ├─ opcional: agrega fila en Google Sheets
                 └─ responde por WhatsApp con botón «Descartar»
```

Código en `src/`: `server.ts` (rutas y firma), `handler.ts` (lógica de mensajes, independiente del canal), `extract.ts` (lectura con IA), `store.ts` (Supabase), `whatsapp.ts` y `telegram.ts` (adaptadores de canal), `sheets.ts` (Google Sheets), `format.ts`, `config.ts`, `types.ts`. Tests en `tests/`.

### Canales: Telegram y WhatsApp son herramientas equivalentes

Telegram y WhatsApp son dos **canales intercambiables** sobre el mismo núcleo: ambos pueden estar activos a la vez, usan el mismo `handler`, el mismo control de acceso y las mismas consultas, y cada respuesta sale por el canal por el que llegó la pregunta. Un canal es solo un adaptador que implementa `MessengerPort` (`sendText`, `sendButtons`, `downloadMedia`) más su lector de webhook y su ruta. Agregar otro canal no toca la lógica de negocio.

- **Telegram** se usa ya para probar. **WhatsApp** queda como canal definitivo para los clientes (se activa cuando llegue el número; el código ya existe pero está sin probar).
- Cada identidad (un teléfono de WhatsApp, un id de Telegram) es un miembro propio y entra con su propio código de acceso, aunque sean la misma persona.
- Pendiente al activar WhatsApp: migración que separe `channel` y `external_id` en `papeleo_members` (hoy el id de Telegram va en `phone` con prefijo `tg:`), cargar las variables `WHATSAPP_*` y apuntar el webhook de Meta.

### Canal de Telegram (temporal)

- Es un bot normal de Telegram (sin Meta ni App Review). Acepta **fotos y PDF**, comandos (`/resumen`, `/borrar`, `/hoja`) y el botón «Descartar» como teclado en línea. Los textos se parten en trozos de ≤4000 caracteres.
- Ruta propia `POST /telegram/webhook`. Telegram no firma el cuerpo: autentica con el `secret_token` que se le dio en `setWebhook`, enviado en la cabecera `X-Telegram-Bot-Api-Secret-Token` (se compara en tiempo constante).
- Idempotencia: el id del mensaje es `tg:<update_id>` (`message_id` solo es único por chat).
- Los usuarios se guardan en `papeleo_members.phone` con el prefijo `tg:` y el id del chat (sin migración). Cuando llegue WhatsApp conviene una migración que separe `channel` y `external_id`.
- **El bot es público**, pero ignora en silencio a cualquiera que no esté vinculado (ver «Control de acceso»).
- Los textos usan `*negrita*` al estilo WhatsApp; en Telegram se envían sin formato (se quitan los asteriscos).
- Para fotos borrosas, enviarlas como *archivo* (documento): Telegram comprime las fotos.
- El token del bot va en la URL de cada llamada a la API de Telegram: no se incluye en errores ni logs.

**Activarlo:**
1. En Telegram, hablar con **@BotFather** → `/newbot` → copiar el token.
2. Cargar en Render: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (inventado: letras, números, `_`, `-`), más las variables de Supabase y Anthropic. Si Render define `RENDER_EXTERNAL_URL`, el servidor registra solo el webhook al arrancar; si no, hacerlo a mano:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url=https://papeleo.onrender.com/telegram/webhook \
     -d secret_token=<TELEGRAM_WEBHOOK_SECRET> \
     -d 'allowed_updates=["message","callback_query"]'
   ```
3. Crear tu propio código en `/admin` y canjearlo en el bot (ver «Control de acceso»).
4. **Render despliega `main`**: nada de esta rama está en vivo hasta fusionar el PR (o apuntar el servicio a la rama).

### Control de acceso

Solo entra quien canjea un **código de acceso** creado por el administrador. Quien no está vinculado es **ignorado en silencio**: no recibe respuesta, no se gastan créditos de IA y nunca se le muestra su id.

- **Códigos:** formato `XXXX-XXXX-XXXX` (12 caracteres aleatorios, ~59 bits, sin `I L O 0 1`). **Un solo uso y sin vencimiento.** Solo el administrador los revoca. En la base se guarda únicamente su hash (sha256); el código en claro se muestra una vez al crearlo.
- **Canje:** la persona le escribe el código al bot, o abre el enlace `https://t.me/<bot>?start=CODIGO`. Se canjea en una transacción atómica (función SQL `papeleo_redeem_code`): dos personas no pueden usar el mismo código. Quedan vinculadas a la empresa del código.
- **Límite de intentos:** 5 códigos erróneos por hora y remitente; después ni se consulta la base. Los mensajes que no tienen forma de código no cuentan.
- **Quitar acceso:** el administrador revoca a la persona (`revoked_at`); desde ese momento es ignorada. Si luego recibe un código nuevo, se reactiva.
- **Varias personas por empresa:** se crea un código por persona, eligiendo la misma empresa.

**Panel de administración** (`https://papeleo.onrender.com/admin`, en el mismo servicio): entra con `ADMIN_PASSWORD` (mínimo 12 caracteres). Permite crear códigos (empresa nueva o existente, y una nota), revocar códigos sin usar y quitar el acceso a personas ya vinculadas. Sesión de 8 h en cookie `HttpOnly` + `SameSite=Strict` + token CSRF en cada acción; 5 intentos de contraseña fallidos bloquean la IP 15 minutos; todo lo que viene de la base se escapa en el HTML. Sin `ADMIN_PASSWORD` el panel no existe.

### Base de datos (Supabase)

Migraciones: `0001_init.sql` (esquema base), `0002_access_codes.sql` (códigos de acceso, `revoked_at` en miembros y la función de canje) y `0004_query_assistant.sql` (registro de preguntas y funciones de consulta; **pendiente de aplicar**). Todas las tablas, índices y el bucket llevan el prefijo `papeleo_` para convivir con otros proyectos en el mismo Supabase.

- `papeleo_organizations`: empresa (y `sheet_id` opcional).
- `papeleo_members`: personas vinculadas, identificadas por su teléfono de WhatsApp o su id de Telegram con prefijo `tg:` (único); `revoked_at` marca el acceso retirado.
- `papeleo_query_log`: cada pregunta al asistente (pregunta, respuesta, herramientas usadas, estado `ok`/`sin_respuesta`/`error`, 👍/👎, tokens). Alimenta la memoria de la conversación, el tope diario y el aprendizaje.
- `papeleo_access_codes`: códigos de acceso (hash, empresa, nota, estado `activo`/`usado`/`revocado`).
- `papeleo_documents`: archivo recibido (`wa_message_id` único, `sha256`, estado, extracción en JSON).
- `papeleo_expenses`: gasto registrado (fecha, proveedor, NIT, nº de factura, subtotal, IVA, total, categoría, medio de pago, confianza, estado).

## Hoja de ruta (en este orden)

0. ✅ Migración `0002` (códigos de acceso) aplicada en Supabase.
1. **Render arriba y una factura real probada, por Telegram.** Cargar las variables de entorno y validar la lectura con Opus (incluso con fotos borrosas).
2. **Detalle por concepto.** La extracción devuelve cada renglón (descripción, cantidad, valor unitario, valor de la línea); tabla nueva `papeleo_expense_items` (migración `0003`). Si la suma de renglones no coincide con el total, la factura se marca «revisar».
3. **Google Drive para los archivos** (hay 5 TB disponibles). Carpetas privadas `Empresa/AAAA/MM/` y nombre `{tipo}_{proveedor}_{fecha}_{consecutivo}`, p. ej. `fac_exito_2026-11-09_0001.jpg`. Prefijos de tipo: `fac` factura, `rec` recibo, `cc` cuenta de cobro, `tiq` tiquete (lista ajustable). En Supabase se guarda `drive_file_id`, no una ruta. Nada se comparte públicamente: el servidor lee de Drive con la cuenta de servicio y reenvía por el chat.
4. **Consultas libres en lenguaje natural** (capa 1, ver abajo). ✅ Código hecho: respuestas humanas, memoria de la conversación, registro en `papeleo_query_log`, «¿te sirvió? 👍 👎» y tope diario (migración `0004`, por aplicar). **El envío de archivos queda para después de Drive (paso 3)** para no escribirlo dos veces.
5. **Base de conocimiento** (ver abajo): glosario por empresa, ejemplos aprobados y panel «Aprendizaje» en `/admin` (migración `0005`).
6. **Activar WhatsApp** como segundo canal cuando llegue el número (variables `WHATSAPP_*`, webhook de Meta y migración `channel`/`external_id`). Habilita además los PDF por ese canal.

### Consultas en lenguaje natural

Pensadas para **gente del común**: nadie debe saber qué es una consulta ni usar comandos. Ejemplos: «¿en qué gasté más en noviembre?», «¿cuál fue la factura más cara y qué compré?», «¿cuánto llevo en gasolina este año?», «muéstrame las facturas de enero a marzo», «¿y el mes pasado?» (usa el contexto de lo anterior).

**Capa 1 (✅ implementada): consulta flexible, sin SQL escrito por la IA.** Claude recibe la pregunta y tres herramientas expresivas (`src/assistant.ts`). Se eligieron dos herramientas de consulta separadas (una de totales y otra de listas) en vez de una sola «mega-herramienta», porque dos esquemas simples producen menos combinaciones inválidas:

| Herramienta | Para |
|---|---|
| `resumir_gastos(medida, agrupar_por, orden, límite, filtros)` | totales: `suma`, `cuenta`, `promedio`, `maximo`, `minimo`; agrupados por mes, semana, categoría, proveedor o medio de pago. «¿En qué gasté más en noviembre?», «¿cuánto llevo en gasolina?» |
| `listar_gastos(orden, límite, filtros)` | facturas concretas y cuántas coinciden en total. «¿Cuál fue la factura más cara?», «las de enero a marzo» |
| `detalle_gasto(id)` | todos los datos de una factura |

Filtros comunes: `desde`, `hasta`, `categoria`, `proveedor`, `texto` (palabra en proveedor o descripción), `valor_min`, `valor_max`, `moneda`. La consulta real vive en las funciones de Postgres `papeleo_resumir` y `papeleo_listar` (migración `0004`); nunca mezclan monedas, ignoran tildes y mayúsculas, escapan los comodines de `LIKE` y devuelven el total de coincidencias.

**Recortes de alcance respecto al diseño original (deliberados):**
- **`buscar_conceptos`** no existe todavía: los renglones de cada factura llegan con la migración `0003`. Mientras tanto el filtro `texto` busca en el proveedor y la descripción; cuando existan los renglones se amplía ahí.
- **`enviar_archivos`** espera a Google Drive. Si piden una imagen, el bot dice con honestidad que aún no puede y ofrece los datos de la factura.

**Cómo funciona una pregunta (`src/handler.ts`):** el texto que no es un atajo (`resumen`, `borrar`, `hoja`, `/start`, `ayuda`) se envía al asistente. Antes se revisa el tope diario (`QUERY_DAILY_CAP`, por defecto 40 por persona y día, contado en la base de datos para que sobreviva a reinicios). La memoria sale de `papeleo_query_log` (últimos 6 turnos de la misma persona dentro de 30 minutos), no de la memoria del servidor: Render gratis duerme y «¿y el mes pasado?» dejaría de funcionar. Cada respuesta `ok` pregunta «¿Te sirvió?» con botones 👍/👎. El bucle de herramientas se limita a 4 vueltas; si el modelo manda parámetros inválidos recibe el error y puede corregirse una vez; si falla otra vez, responde «no pude» y queda registrado como `sin_respuesta`.

**Modelo y costo:** `QUERY_MODEL` (por defecto `claude-opus-5-5`, el modelo recomendado por defecto). Cada pregunta hace de 2 a 4 llamadas, así que es la variable que más pesa en el costo: si hace falta ahorrar, `QUERY_MODEL=claude-sonnet-5-5` cuesta la mitad. El mensaje de sistema y las herramientas son estables y se envían con caché de prompt. No se activó el reintento automático con otro modelo ante rechazos de seguridad (`fallbacks`): las preguntas sobre facturas no suelen activarlos y un rechazo se responde con «no pude responder eso».

**Capa 2 (solo si la capa 1 no alcanza, y solo con aprobación expresa): SQL generado por la IA** sobre *vistas de solo lectura* ya filtradas por empresa. Exigiría: rol de base de datos de solo lectura distinto del servicio, vistas que lean `org_id` de un valor fijado por el servidor (nunca por la IA), validar que sea un único `SELECT`, `statement_timeout` corto, límite de filas, bitácora de cada sentencia y pruebas de aislamiento entre empresas. Es más flexible pero más riesgosa; por eso va aparte y después.

**Cómo debe responder (reglas de estilo):**
- Español sencillo y cálido, sin términos técnicos (nada de «consulta», «filtro», «ID»). Valores en pesos con separador de miles («$45.900»).
- Respuesta corta primero, detalle después; ofrece el siguiente paso («¿quieres ver las facturas?»).
- Si la pregunta es ambigua (¿qué mes? ¿de qué empresa?), **pregunta una sola cosa** en vez de adivinar.
- Tolera errores de ortografía y sinónimos («plata», «gasté», «tienda», «el almacén»).
- Recuerda los últimos mensajes de la conversación para entender «¿y el mes pasado?».
- Si no puede responder, lo dice con honestidad y registra la pregunta para mejorar.

**Reglas de seguridad (no negociables):**
- **La IA nunca escribe SQL contra las tablas reales.** Devuelve parámetros que se validan con zod (esquemas `.strict()`); el servidor ejecuta funciones de Postgres con valores como parámetros, nunca texto pegado. Medida, agrupación y orden pasan por listas cerradas (`CASE`), sin SQL dinámico.
- **`org_id` lo pone el servidor**, a partir de la identidad ya vinculada (teléfono o id de Telegram); ningún esquema de herramienta tiene ese campo, así que la IA no puede cambiarlo ni quitarlo. `detalle_gasto` también filtra por empresa: un id ajeno (o inventado, o escrito dentro de una factura) no devuelve nada.
- **Las funciones de consulta son `SECURITY INVOKER` y solo `service_role` puede ejecutarlas** (`revoke` a `public`, `anon` y `authenticated`). En Supabase las funciones de `public` son llamables por la API REST con la llave pública; sin esto, cualquiera con esa llave podría leer otra empresa pasando su id. Hay `statement_timeout` de 3 s y tope de filas (20 facturas, 24 grupos).
- **Inyección por contenido de facturas:** los nombres y descripciones los escribió un tercero y vuelven al modelo dentro de los resultados. Por eso el mensaje de sistema los declara *datos, no instrucciones*, y todas las herramientas son **solo lectura y limitadas a la empresa de quien pregunta**: lo máximo que puede lograr una factura maliciosa es confundir la respuesta a su propia empresa. **No se deben agregar herramientas de escritura a este bucle sin volver a evaluar este riesgo.**
- Sumas, máximos y conteos los calcula la base de datos, no el modelo, para que los números sean exactos.
- Opciones cerradas (listas de valores, fechas con formato exacto, límite de resultados).
- RLS activo en todas las tablas de Supabase.

### Base de conocimiento (el sistema aprende)

Objetivo: que el asistente entienda cada vez mejor cómo hablan los usuarios. **No es entrenar el modelo**: es guardar lo que se aprende y dárselo como contexto en cada pregunta.

| Tabla (migración `0004`/`0005`) | Contenido | Quién la ve |
|---|---|---|
| `papeleo_query_log` | cada pregunta, la consulta interpretada, el resultado resumido, estado (`ok`, `sin_respuesta`, `error`), 👍/👎, tokens y fecha | solo la empresa dueña; el administrador en el panel |
| `papeleo_org_glossary` | vocabulario propio de una empresa: «el almacén de la esquina» → proveedor Éxito; «combustible» ≈ «tanqueo» | solo esa empresa |
| `papeleo_knowledge` | conocimiento **global y curado**: sinónimos generales y ejemplos pregunta → consulta que funcionaron | todas las empresas, **sin datos de ninguna** |

**Ciclo de aprendizaje**
1. Cada respuesta se registra y se pregunta «¿te sirvió? 👍 👎».
2. Si el usuario corrige («no, el almacén es Éxito»), el bot propone guardarlo en el glosario de su empresa y lo guarda al confirmar.
3. Las preguntas con 👍 se vuelven candidatas a ejemplos; las que quedaron `sin_respuesta` o con 👎 aparecen en la pantalla **Aprendizaje** del panel `/admin`.
4. El administrador revisa: aprueba un ejemplo para el conocimiento global (se anonimiza: sin nombres, valores ni NIT), descarta, o decide agregar una capacidad nueva.
5. En cada pregunta nueva se recuperan los ejemplos aprobados más parecidos y el glosario de esa empresa, y se inyectan en el prompt. Primero con búsqueda de texto completo de Postgres en español (sin proveedor extra); si hace falta, `pgvector` más adelante.

**Privacidad:** las preguntas crudas nunca salen de su empresa; solo lo que el administrador aprueba y anonimiza llega al conocimiento global. Hay que informar a los usuarios que las preguntas se guardan para mejorar el servicio (Ley 1581 de 2012, Habeas Data) y definir cuánto tiempo se conservan.

## Desarrollo

Requiere Node 22.

```bash
npm install
npm test        # vitest (incluye pruebas del SQL contra Postgres real en memoria con PGlite)
npm run build   # tsc → dist/
npm run dev     # tsx watch con .env
```

Copia `.env.example` a `.env` y completa los valores.

### Variables de entorno

| Variable | Uso |
|---|---|
| `PORT` | Puerto (Render lo define solo) |
| `TELEGRAM_BOT_TOKEN` | Activa el canal de Telegram (lo da @BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | Secreto del webhook: solo `A-Z a-z 0-9 _ -` |
| `ADMIN_PASSWORD` | Contraseña del panel `/admin` (mín. 12 caracteres). Sin ella no hay panel |
| `PUBLIC_URL` | Opcional; por defecto `RENDER_EXTERNAL_URL`. Con ella se registra solo el webhook |
| `WHATSAPP_VERIFY_TOKEN` | (Pendiente) Texto propio; se pega igual en el webhook de Meta |
| `WHATSAPP_APP_SECRET` | (Pendiente) App Secret de la app de Meta (valida la firma) |
| `WHATSAPP_ACCESS_TOKEN` | (Pendiente) Token de usuario del sistema |
| `WHATSAPP_PHONE_NUMBER_ID` | (Pendiente) Número que envía las respuestas |
| `WHATSAPP_GRAPH_VERSION` | Por defecto `v21.0` |
| `SUPABASE_URL` | Dirección del proyecto de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Llave de servidor de Supabase (solo en el servidor, nunca en un cliente) |
| `SUPABASE_BUCKET` | Por defecto `papeleo-documentos` (se reemplazará por Drive) |
| `ANTHROPIC_API_KEY` | Lectura de facturas y consultas |
| `EXTRACTION_MODEL` | Modelo que lee las facturas. Por defecto `claude-opus-5-5` |
| `QUERY_MODEL` | Modelo del asistente de consultas. Por defecto `claude-opus-5-5`; cada pregunta hace 2 a 4 llamadas (ver «Modelo y costo») |
| `QUERY_DAILY_CAP` | Preguntas máximas por persona y día. Por defecto 40 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Opcional. JSON de la cuenta de servicio, tal cual o en base64 |

Debe haber al menos un canal configurado. Si se define alguna variable de un canal, hacen falta todas las suyas.

### Dónde conseguir cada dato

Todo se pega en Render: panel del servicio `papeleo` → **Environment** → *Add Environment Variable*; al guardar, Render vuelve a desplegar. (Los nombres de los menús de cada plataforma pueden cambiar.)

| Variable | De dónde sale |
|---|---|
| `SUPABASE_URL` | Proyecto **`real-samaria`** (donde ya están las tablas `papeleo_`). Panel de Supabase → *Project Settings* → *API*, campo *Project URL*. Tiene la forma `https://xaenkjvyehpwwhuzdxyz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Misma pantalla, sección de llaves: la llave **`service_role`** (en el esquema nuevo, la *Secret key* `sb_secret_…`). **No** uses la `anon`/*publishable*. Da acceso total: no se comparte ni se sube al repo |
| `ANTHROPIC_API_KEY` | console.anthropic.com → *API Keys* → *Create Key*. Es independiente de la suscripción de chat: la cuenta de la consola necesita saldo/crédito |
| `TELEGRAM_BOT_TOKEN` | En Telegram, hablar con **@BotFather** → `/newbot` → copiar el token que entrega |
| `TELEGRAM_WEBHOOK_SECRET` | Lo inventas tú: solo `A-Z a-z 0-9 _ -`. Por ejemplo, generado con `openssl rand -hex 24` |
| `ADMIN_PASSWORD` | La inventas tú, mínimo 12 caracteres. Es la contraseña de `/admin` |
| `WHATSAPP_*` | Más adelante, del panel de Meta (ver «Canales») |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Más adelante, para Drive/Sheets: Google Cloud → cuenta de servicio → crear clave JSON |

Los secretos los pega el dueño del proyecto: nadie más debe verlos ni escribirlos en el código, en commits o en chats.

## Despliegue (Render)

Servicio web `papeleo` (plan free, región Virginia) conectado a la rama `main` de este repositorio, con despliegue automático.

- Build: `npm ci --include=dev && npm run build`
- Start: `npm start`
- URL: `https://papeleo.onrender.com` · health check: `GET /health`
- Webhooks: WhatsApp `https://papeleo.onrender.com/webhook`, Telegram `https://papeleo.onrender.com/telegram/webhook`

**Estado al 2026-11-10:** el único despliegue (de un commit anterior) falló al arrancar con `Falta la variable de entorno WHATSAPP_APP_SECRET`: no hay variables cargadas en Render. Además corrió con Node 26, antes de fijar Node 22 (`engines`). `main` ya tiene el código nuevo (Telegram + control de acceso + panel). Hay que cargar las variables de «Dónde conseguir cada dato» (mínimo: Supabase, Anthropic, Telegram y `ADMIN_PASSWORD`) y redesplegar. Con Telegram ya no se exigen las de WhatsApp.

Nota: el plan free de Render duerme el servicio tras un rato sin tráfico; el primer mensaje de WhatsApp después de eso puede tardar en responder. Considerar un plan de pago antes de usarlo en producción.
