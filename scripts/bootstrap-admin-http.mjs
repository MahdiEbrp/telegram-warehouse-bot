import { createClient } from "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot/node_modules/@libsql/client/lib-esm/http.js";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

dotenv.config({ path: "/run/media/mahdi/Archive/Project/NextJS/telegram-warehouse-bot/.env" });

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
const adminIdsRaw = process.env.SUPER_ADMIN_TELEGRAM_IDS || "";

if (!url?.startsWith("libsql://")) {
  console.error("TURSO_DATABASE_URL must be a libsql:// URL for HTTP client");
  process.exit(1);
}

if (!adminIdsRaw) {
  console.error("SUPER_ADMIN_TELEGRAM_IDS is required");
  process.exit(1);
}

const adminIds = adminIdsRaw.split(",").map((x) => Number(x.trim())).filter((n) => n > 0);

if (adminIds.length === 0) {
  console.error("No valid admin IDs found in SUPER_ADMIN_TELEGRAM_IDS");
  process.exit(1);
}

if (!process.argv.includes("--confirm")) {
  console.error(
    "This grants super_admin to all SUPER_ADMIN_TELEGRAM_IDS. Run with --confirm only intentionally.",
  );
  process.exit(1);
}

const client = createClient({ url, authToken });

async function main() {
  const now = Date.now();

  for (const telegramId of new Set(adminIds)) {
    // Check if user exists
    const existing = await client.execute({
      sql: "SELECT * FROM users WHERE telegram_id = ?",
      args: [telegramId],
    });

    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      // Update existing user to super_admin
      await client.execute({
        sql: "UPDATE users SET role = 'super_admin', is_active = 1 WHERE telegram_id = ?",
        args: [telegramId],
      });
      console.log(`  OK: Updated user ${telegramId} to super_admin (id: ${userId})`);
    } else {
      // Insert new user
      userId = randomUUID();
      await client.execute({
        sql: "INSERT INTO users (id, telegram_id, first_name, role, is_active, created_at) VALUES (?, ?, ?, 'super_admin', 1, ?)",
        args: [userId, telegramId, "مدیرکل", now],
      });
      console.log(`  OK: Created super_admin user ${telegramId} (id: ${userId})`);
    }

    // Insert audit log if role changed or new user
    const auditId = randomUUID();
    const details = JSON.stringify({
      source: "trusted-cli",
      previousRole: existing.rows.length > 0 ? existing.rows[0].role : null,
      role: "super_admin",
    });
    await client.execute({
      sql: "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [auditId, userId, "user.bootstrap_cli", "user", userId, details, now],
    });
    console.log(`  OK: Audit log recorded for user ${telegramId}`);
  }

  // Verify
  const users = await client.execute("SELECT telegram_id, role, is_active FROM users WHERE role = 'super_admin'");
  console.log("\nSuper admins:", users.rows.map((r) => `${r.telegram_id} (active: ${r.is_active})`).join(", "));

  client.close();
  console.log("\nAdmin bootstrap completed and audited.");
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
