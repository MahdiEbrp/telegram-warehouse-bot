import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDatabase } from "../src/db/client";
import { parseDatabaseEnv } from "../src/lib/env";

const env = parseDatabaseEnv(process.env);
if (env.TURSO_DATABASE_URL.startsWith("file:") && env.TURSO_DATABASE_URL !== "file::memory:")
  await mkdir(dirname(env.TURSO_DATABASE_URL.slice(5)), { recursive: true });
const connection = await createDatabase({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});
try {
  await migrate(connection.db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} finally {
  connection.close();
}
