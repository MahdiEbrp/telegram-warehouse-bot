import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { MiddlewareFn } from "grammy";
import type { Database } from "@/db/client";
import { chatLocks, processedUpdates } from "@/db/schema";
import { assertLease, writeTransaction } from "@/db/queries/common";
import { ZodError } from "zod";
import { DomainError, RetryableError } from "@/lib/errors";
import type { BotContext } from "@/types/bot";
import type { Lease } from "@/types/domain";

// Longer than Vercel's maxDuration=60s. Fencing also rejects stale writers.
const LEASE_MS = 120_000;
export function conversationKey(ctx: Pick<BotContext, "from" | "chat">) {
  return `user:${ctx.from?.id}:chat:${ctx.chat?.id}`;
}
export async function acquireLease(db: Database, key: string): Promise<Lease> {
  const owner = randomUUID();
  const now = Date.now();
  const [lock] = await db
    .insert(chatLocks)
    .values({ key, owner, expiresAt: now + LEASE_MS })
    .onConflictDoUpdate({
      target: chatLocks.key,
      set: { owner, expiresAt: now + LEASE_MS },
      setWhere: lt(chatLocks.expiresAt, now),
    })
    .returning();
  if (!lock) throw new RetryableError("CHAT_BUSY");
  return { key, owner };
}
export async function releaseLease(db: Database, lease: Lease) {
  await db
    .delete(chatLocks)
    .where(and(eq(chatLocks.key, lease.key), eq(chatLocks.owner, lease.owner)));
}
export function reliability(db: Database): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return;
    const [done] = await db
      .select()
      .from(processedUpdates)
      .where(eq(processedUpdates.updateId, ctx.update.update_id));
    if (done) return;
    const lease = await acquireLease(db, conversationKey(ctx));
    ctx.lease = lease;
    try {
      const [again] = await db
        .select()
        .from(processedUpdates)
        .where(eq(processedUpdates.updateId, ctx.update.update_id));
      if (again) return;
      // Permanent validation/authorization denials are receipts too. An old denied update
      // must not become actionable after a later permission grant. Transient errors still retry.
      let permanent: DomainError | ZodError | undefined;
      try {
        await next();
      } catch (error) {
        if (error instanceof DomainError || error instanceof ZodError) permanent = error;
        else throw error;
      } // Includes durable conversation persistence before marking success.
      await writeTransaction(db, async (tx) => {
        await assertLease(tx, lease);
        await tx
          .insert(processedUpdates)
          .values({ updateId: ctx.update.update_id, processedAt: Date.now() })
          .onConflictDoNothing();
      });
      if (permanent) throw permanent;
    } finally {
      await releaseLease(db, lease);
    }
  };
}
