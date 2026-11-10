function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

const WHATSAPP_VARS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
];

/** Telegram solo admite A-Z a-z 0-9 _ - (1 a 256 caracteres) en el secreto del webhook. */
function telegramSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET solo puede tener letras, números, _ y - (máx. 256 caracteres)");
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} debe ser un entero positivo`);
  return n;
}

export function loadConfig() {
  // Cada canal es opcional, pero debe haber al menos uno. Si se define alguna variable de un canal, hacen falta todas las suyas.
  const whatsapp = WHATSAPP_VARS.some((v) => process.env[v])
    ? {
        verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
        appSecret: required("WHATSAPP_APP_SECRET"),
        accessToken: required("WHATSAPP_ACCESS_TOKEN"),
        phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
        graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
      }
    : null;

  const telegram = process.env.TELEGRAM_BOT_TOKEN
    ? {
        botToken: required("TELEGRAM_BOT_TOKEN"),
        webhookSecret: telegramSecret(required("TELEGRAM_WEBHOOK_SECRET")),
        // Si se define, el servidor registra solo el webhook al arrancar. Render aporta RENDER_EXTERNAL_URL.
        publicUrl: process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? null,
      }
    : null;

  // Panel de administración (crea los códigos de acceso). Sin contraseña no hay panel y nadie puede entrar.
  const adminPassword = process.env.ADMIN_PASSWORD || null;
  if (adminPassword && adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres");
  }

  if (!whatsapp && !telegram) {
    throw new Error("Configura al menos un canal: variables WHATSAPP_* o TELEGRAM_BOT_TOKEN");
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    whatsapp,
    telegram,
    adminPassword,
    supabase: {
      url: required("SUPABASE_URL"),
      serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
      bucket: process.env.SUPABASE_BUCKET ?? "papeleo-documentos",
    },
    extractionModel: process.env.EXTRACTION_MODEL ?? "claude-opus-5-5",
    // Cada pregunta hace de 2 a 4 llamadas: si el costo pesa, QUERY_MODEL puede apuntar a un modelo más económico.
    queryModel: process.env.QUERY_MODEL ?? "claude-opus-5-5",
    queryDailyCap: positiveInt("QUERY_DAILY_CAP", 40),
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
  };
}

export type Config = ReturnType<typeof loadConfig>;
