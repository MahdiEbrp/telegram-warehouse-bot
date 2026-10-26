import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { parseDatabaseEnv } from "./src/lib/env";

const env = parseDatabaseEnv(process.env);
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN },
  strict: true,
  verbose: true,
});
