import { createClient } from "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot/node_modules/@libsql/client/lib-esm/http.js";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config({ path: "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot/.env" });

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

if (!url?.startsWith("libsql://")) {
  console.error("TURSO_DATABASE_URL must be a libsql:// URL for HTTP client");
  process.exit(1);
}

const client = createClient({ url, authToken });

async function runMigration(filePath) {
  const sql = await readFile(filePath, "utf-8");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

  for (const stmt of statements) {
    if (!stmt) continue;
    try {
      const result = await client.execute(stmt);
      console.log(`  OK: ${stmt.slice(0, 60).replace(/\s+/g, " ")}... (${result.rows.length} rows)`);
    } catch (err) {
      console.error(`  FAILED: ${stmt.slice(0, 80)}...`);
      console.error(`  Error: ${err}`);
      throw err;
    }
  }
}

async function main() {
  const base = "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot";
  const migrations = [
    `${base}/drizzle/0000_initial.sql`,
    `${base}/drizzle/0001_tracking.sql`,
    `${base}/drizzle/0002_parcels.sql`,
  ];

  for (const m of migrations) {
    console.log(`Running ${m}...`);
    await runMigration(m);
  }

  // Verify tables exist
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log("\nTables created:", tables.rows.map((r) => r.name).join(", "));

  client.close();
  console.log("\nAll migrations applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
