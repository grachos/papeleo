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

  const instagram = process.env.INSTAGRAM_ACCESS_TOKEN
    ? {
        accessToken: required("INSTAGRAM_ACCESS_TOKEN"),
        // Pueden reutilizar los de WhatsApp si es la misma app de Meta.
        verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN ?? required("WHATSAPP_VERIFY_TOKEN"),
        appSecret: process.env.INSTAGRAM_APP_SECRET ?? required("WHATSAPP_APP_SECRET"),
        graphVersion: process.env.INSTAGRAM_GRAPH_VERSION ?? "v21.0",
      }
    : null;

  if (!whatsapp && !instagram) {
    throw new Error("Configura al menos un canal: variables WHATSAPP_* o INSTAGRAM_ACCESS_TOKEN");
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    whatsapp,
    instagram,
    supabase: {
      url: required("SUPABASE_URL"),
      serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
      bucket: process.env.SUPABASE_BUCKET ?? "papeleo-documentos",
    },
    extractionModel: process.env.EXTRACTION_MODEL ?? "claude-opus-5-5",
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
  };
}

export type Config = ReturnType<typeof loadConfig>;
