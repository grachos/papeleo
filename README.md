# Papeleo

Asistente de papeleo por WhatsApp. El usuario envía fotos o PDF de facturas y comprobantes; el servicio los lee con IA (Claude Opus, incluso si están borrosos), los registra en una base de datos y, más adelante, permite consultarlos en lenguaje natural desde el mismo chat. **WhatsApp es el front**: no hay aplicación web.

## Estado actual

| Pieza | Estado |
|---|---|
| Webhook de WhatsApp (firma, idempotencia) | ✅ Hecho |
| Lectura de comprobantes con Claude (foto/PDF) | ✅ Hecho, **sin probar con una factura real** (los tests usan un lector simulado) |
| Registro en Supabase (esquema multiempresa, prefijo `papeleo_`) | ✅ Hecho |
| Detección de duplicados (sha256) | ✅ Hecho |
| Comandos `resumen`, `borrar`, `hoja` | ✅ Hecho |
| Copia opcional de cada gasto a Google Sheets | ✅ Hecho |
| Guardar el detalle por concepto de cada factura | ⏳ Pendiente (hoy solo hay un `descripcion` por factura) |
| Archivos en Google Drive (hoy van a Supabase Storage) | ⏳ Pendiente |
| Consultas en lenguaje natural y envío de archivos por WhatsApp | ⏳ Pendiente |
| Códigos de invitación para vincular números a una empresa | ⏳ Pendiente |
| Despliegue en Render | ⚠️ Servicio creado pero caído: faltan variables de entorno |

## Arquitectura

```
WhatsApp ──► POST /webhook (Express, Render)
                 │
                 ├─ descarga el archivo (Graph API)
                 ├─ sha256 → ¿duplicado? → responde y termina
                 ├─ guarda el archivo (hoy Supabase Storage → destino: Google Drive)
                 ├─ extrae datos con Claude Opus (salida validada con zod)
                 ├─ guarda en Supabase (papeleo_documents / papeleo_expenses)
                 ├─ opcional: agrega fila en Google Sheets
                 └─ responde por WhatsApp con botón «Descartar»
```

Código en `src/`: `server.ts` (rutas y firma), `handler.ts` (lógica de mensajes), `extract.ts` (lectura con IA), `store.ts` (Supabase), `whatsapp.ts` (Graph API), `sheets.ts` (Google Sheets), `format.ts`, `config.ts`, `types.ts`. Tests en `tests/`.

### Base de datos (Supabase)

Migración: `supabase/migrations/0001_init.sql`. Todas las tablas, índices y el bucket llevan el prefijo `papeleo_` para convivir con otros proyectos en el mismo Supabase.

- `papeleo_organizations`: empresa (y `sheet_id` opcional).
- `papeleo_members`: personas, identificadas por su teléfono de WhatsApp (único).
- `papeleo_documents`: archivo recibido (`wa_message_id` único, `sha256`, estado, extracción en JSON).
- `papeleo_expenses`: gasto registrado (fecha, proveedor, NIT, nº de factura, subtotal, IVA, total, categoría, medio de pago, confianza, estado).

## Hoja de ruta (en este orden)

1. **Render arriba y una factura real probada.** Cargar las variables de entorno y validar la lectura con Opus.
2. **Detalle por concepto.** La extracción devuelve cada renglón (descripción, cantidad, valor unitario, valor de la línea); tabla nueva `papeleo_expense_items` (migración `0002`). Si la suma de renglones no coincide con el total, la factura se marca «revisar».
3. **Google Drive para los archivos** (hay 5 TB disponibles). Carpetas privadas `Empresa/AAAA/MM/` y nombre `{tipo}_{proveedor}_{fecha}_{consecutivo}`, p. ej. `fac_exito_2026-11-09_0001.jpg`. Prefijos de tipo: `fac` factura, `rec` recibo, `cc` cuenta de cobro, `tiq` tiquete (lista ajustable). En Supabase se guarda `drive_file_id`, no una ruta. Nada se comparte públicamente: el servidor lee de Drive con la cuenta de servicio y reenvía por WhatsApp.
4. **Consultas en lenguaje natural** con herramientas (ver abajo) y envío de los archivos por WhatsApp.
5. **Códigos de invitación**: un código por persona para vincular su número a una empresa. Hoy un número nuevo se da de alta automáticamente, lo cual no sirve cuando hay archivos de por medio.

### Consultas en lenguaje natural

Ejemplos: «¿en qué gasté más en noviembre?», «¿cuál fue la factura más cara y qué compré?», «muéstrame las facturas de enero a marzo».

Claude recibe la pregunta y un conjunto pequeño de **herramientas**, cada una una consulta ya escrita y parametrizada:

| Herramienta | Para |
|---|---|
| `listar_gastos(filtro, orden, límite)` | la factura más cara, facturas de un periodo |
| `totales(agrupar_por, filtro)` | totales por mes, categoría o proveedor |
| `detalle_gasto(id)` | los conceptos de una factura |
| `buscar_conceptos(texto, filtro)` | cuánto se gastó en «gasolina» |

Reglas de seguridad (no negociables):

- **La IA nunca escribe SQL.** Devuelve parámetros que se validan con zod y el código arma la consulta con `supabase-js` (valores como parámetros, nunca texto pegado).
- **`org_id` sale del número de WhatsApp que escribe**, ya vinculado a su empresa; lo agrega el código en cada herramienta y la IA no puede quitarlo.
- Sumas y máximos los calcula la base de datos, no el modelo, para que los números sean exactos.
- Opciones cerradas (tipos en lista, fechas con formato exacto, límite de resultados). Si una pregunta no encaja en ninguna herramienta, el bot lo dice y se agrega la herramienta.
- Defensa adicional prevista: RLS en Supabase.

## Desarrollo

Requiere Node 22.

```bash
npm install
npm test        # vitest (16 tests)
npm run build   # tsc → dist/
npm run dev     # tsx watch con .env
```

Copia `.env.example` a `.env` y completa los valores.

### Variables de entorno

| Variable | Uso |
|---|---|
| `PORT` | Puerto (Render lo define solo) |
| `WHATSAPP_VERIFY_TOKEN` | Texto propio; se pega igual en la configuración del webhook de Meta |
| `WHATSAPP_APP_SECRET` | App Secret de la app de Meta (valida la firma del webhook) |
| `WHATSAPP_ACCESS_TOKEN` | Token de usuario del sistema |
| `WHATSAPP_PHONE_NUMBER_ID` | Número que envía las respuestas |
| `WHATSAPP_GRAPH_VERSION` | Por defecto `v21.0` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Base de datos (la service role solo en el servidor) |
| `SUPABASE_BUCKET` | Por defecto `papeleo-documentos` (se reemplazará por Drive) |
| `ANTHROPIC_API_KEY` | Lectura de facturas |
| `EXTRACTION_MODEL` | Por defecto `claude-opus-5-5` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Opcional. JSON de la cuenta de servicio, tal cual o en base64 |

## Despliegue (Render)

Servicio web `papeleo` (plan free, región Virginia) conectado a la rama `main` de este repositorio, con despliegue automático.

- Build: `npm ci --include=dev && npm run build`
- Start: `npm start`
- URL: `https://papeleo.onrender.com` · health check: `GET /health`
- Webhook de Meta: `https://papeleo.onrender.com/webhook`

**Estado al 2026-11-10:** el único despliegue falló al arrancar con `Falta la variable de entorno WHATSAPP_APP_SECRET`: no hay variables cargadas en Render. Además corrió con Node 26, antes de fijar Node 22 (`engines`). Hay que cargar todas las variables de la tabla anterior y volver a desplegar `main`.

Nota: el plan free de Render duerme el servicio tras un rato sin tráfico; el primer mensaje de WhatsApp después de eso puede tardar en responder. Considerar un plan de pago antes de usarlo en producción.
