import dotenv from "dotenv";
import path from "node:path";

// Carrega sempre o .env da raiz do projeto antes de construir o objeto ENV.
// Isso evita que módulos importados pelo servidor inicializem o SDK OAuth
// enquanto process.env ainda está vazio, inclusive quando o comando é aberto
// a partir de outro diretório.
dotenv.config({
  path: path.resolve(import.meta.dirname, "../../.env"),
  quiet: true,
});

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
