import "dotenv/config";
import { eq } from "drizzle-orm";
import { getEnv } from "../src/lib/env";
import { getDatabase } from "../src/db";
import { auditLogs, users } from "../src/db/schema";
import { writeTransaction } from "../src/db/queries/common";

// This is an explicit, trusted offline recovery operation, never run on deployment.
if (!process.argv.includes("--confirm")) {
  console.error(
    "This grants super_admin to all SUPER_ADMIN_TELEGRAM_IDS. Run admin:bootstrap -- --confirm only intentionally.",
  );
  process.exitCode = 1;
} else {
  const env = getEnv();
  const connection = await getDatabase();
  try {
    await writeTransaction(connection.db, async (tx) => {
      for (const telegramId of new Set(env.SUPER_ADMIN_TELEGRAM_IDS)) {
        const [existing] = await tx.select().from(users).where(eq(users.telegramId, telegramId));
        const [user] = await tx
          .insert(users)
          .values({ telegramId, firstName: "مدیرکل", role: "super_admin", isActive: true })
          .onConflictDoUpdate({
            target: users.telegramId,
            set: { role: "super_admin", isActive: true },
          })
          .returning();
        if (!user) throw new Error("Bootstrap failed");
        if (!existing || existing.role !== "super_admin" || !existing.isActive)
          await tx.insert(auditLogs).values({
            userId: user.id,
            action: "user.bootstrap_cli",
            entityType: "user",
            entityId: user.id,
            details: {
              source: "trusted-cli",
              previousRole: existing?.role ?? null,
              role: "super_admin",
            },
          });
      }
    });
    console.log(
      "Explicit admin bootstrap completed and audited. This command is not part of normal deployment.",
    );
  } finally {
    connection.close();
  }
}
