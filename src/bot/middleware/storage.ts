import { eq } from "drizzle-orm";
import type {
  ConversationData,
  ConversationStorage,
  VersionedState,
} from "@grammyjs/conversations";
import { botConversations } from "@/db/schema";
import type { Database } from "@/db/client";
import { assertLease, writeTransaction } from "@/db/queries/common";
import type { BotContext } from "@/types/bot";
import { conversationKey } from "./reliability";

export function conversationStorage(
  db: Database,
  version: string,
): ConversationStorage<BotContext, ConversationData> {
  return {
    type: "context",
    version,
    adapter: {
      async read(ctx) {
        await assertLease(db, ctx.lease);
        const [row] = await db
          .select()
          .from(botConversations)
          .where(eq(botConversations.key, conversationKey(ctx)));
        return row && row.expiresAt > Date.now()
          ? (row.value as VersionedState<ConversationData>)
          : undefined;
      },
      async write(ctx, value) {
        await writeTransaction(db, async (tx) => {
          await assertLease(tx, ctx.lease);
          await tx
            .insert(botConversations)
            .values({ key: conversationKey(ctx), value, expiresAt: Date.now() + 86_400_000 })
            .onConflictDoUpdate({
              target: botConversations.key,
              set: { value, expiresAt: Date.now() + 86_400_000 },
            });
        });
      },
      async delete(ctx) {
        await writeTransaction(db, async (tx) => {
          await assertLease(tx, ctx.lease);
          await tx.delete(botConversations).where(eq(botConversations.key, conversationKey(ctx)));
        });
      },
    },
  };
}
