function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    whatsapp: {
      verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
      appSecret: required("WHATSAPP_APP_SECRET"),
      accessToken: required("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
      graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
    },
    supabase: {
      url: required("SUPABASE_URL"),
      serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
      bucket: process.env.SUPABASE_BUCKET ?? "documentos",
    },
    extractionModel: process.env.EXTRACTION_MODEL ?? "claude-opus-5-5",
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
  };
}

export type Config = ReturnType<typeof loadConfig>;
