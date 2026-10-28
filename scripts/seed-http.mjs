import { createClient } from "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot/node_modules/@libsql/client/lib-esm/http.js";
import dotenv from "dotenv";

dotenv.config({ path: "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot/.env" });

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient({ url, authToken });

async function main() {
  const now = Date.now();

  // Insert default category "عمومی" (idempotent)
  await client.execute({
    sql: "INSERT OR IGNORE INTO categories (id, name, parent_id) VALUES (?, ?, NULL)",
    args: ["cat_general", "عمومی"],
  });
  console.log("  OK: category 'عمومی' ensured");

  // Insert store settings (idempotent)
  const defaultStore = JSON.stringify({
    name: "Anbar",
    timezone: "Asia/Tehran",
    currency: "IRR",
    low_stock_threshold: 5,
  });
  await client.execute({
    sql: "INSERT OR IGNORE INTO store_settings (id, value, updated_at) VALUES (?, ?, ?)",
    args: ["store", defaultStore, now],
  });
  console.log("  OK: store settings ensured");

  // Verify
  const cats = await client.execute("SELECT * FROM categories");
  console.log("Categories:", cats.rows.map((r) => r.name).join(", "));

  const settings = await client.execute("SELECT * FROM store_settings");
  console.log("Store settings:", settings.rows.length, "row(s)");

  client.close();
  console.log("\nSeed applied successfully.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
