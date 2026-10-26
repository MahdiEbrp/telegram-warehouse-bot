import "dotenv/config";
import { lt } from "drizzle-orm";
import { getDatabase } from "../src/db";
import { botConversations, chatLocks, processedUpdates } from "../src/db/schema";

const connection = await getDatabase();
try {
  const now = Date.now();
  await connection.db.delete(botConversations).where(lt(botConversations.expiresAt, now));
  await connection.db.delete(chatLocks).where(lt(chatLocks.expiresAt, now));
  await connection.db
    .delete(processedUpdates)
    .where(lt(processedUpdates.processedAt, now - 30 * 86_400_000));
  // Domain mutation keys and audit logs are never pruned by this job.
  console.log("Expired conversations/leases and 30-day-old receipts removed.");
} finally {
  connection.close();
}
