import { and, eq, sql } from "drizzle-orm";
import { auditLogs, chatLocks, mutationKeys, users, type User } from "@/db/schema";
import type { Database, Executor, Transaction } from "@/db/client";
import { authorize, type Permission } from "@/lib/permissions";
import { DomainError, invariant, RetryableError } from "@/lib/errors";
import { PAGE_SIZE, type Json, type Lease, type Page } from "@/types/domain";

export async function assertLease(tx: Executor, lease?: Lease): Promise<void> {
  if (!lease) return; // Only trusted CLI/tests call services without a webhook lease.
  const [row] = await tx
    .select()
    .from(chatLocks)
    .where(and(eq(chatLocks.key, lease.key), eq(chatLocks.owner, lease.owner)))
    .limit(1);
  if (!row || row.expiresAt <= Date.now()) throw new RetryableError("LEASE_EXPIRED");
}
export async function requireActor(
  tx: Executor,
  id: string,
  permission: Permission,
): Promise<User> {
  const [actor] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  invariant(actor?.isActive, "INACTIVE", "⛔ حساب شما فعال نیست.");
  authorize(actor.role, permission);
  return actor;
}
export async function writeTransaction<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  // No Telegram/HTTP I/O inside these short write transactions.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work, { behavior: "immediate" });
    } catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error;
      const code =
        typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
      if (attempt < 3 && ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"].includes(code)) {
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
}
export async function mutate<T extends Json>(
  db: Database,
  actorId: string,
  permission: Permission,
  key: string,
  lease: Lease | undefined,
  work: (tx: Transaction, actor: User) => Promise<T>,
): Promise<T> {
  invariant(key.length >= 3 && key.length <= 200, "BAD_KEY", "شناسه عملیات نامعتبر است.");
  try {
    return await writeTransaction(db, async (tx) => {
      await assertLease(tx, lease);
      const actor = await requireActor(tx, actorId, permission);
      const [existing] = await tx
        .select()
        .from(mutationKeys)
        .where(eq(mutationKeys.key, key))
        .limit(1);
      if (existing) {
        invariant(existing.userId === actorId, "KEY_COLLISION", "تداخل شناسه عملیات.");
        return existing.result as T;
      }
      const value = await work(tx, actor);
      await tx.insert(mutationKeys).values({ key, userId: actorId, result: value });
      return value;
    });
  } catch (error) {
    if (error instanceof DomainError || error instanceof RetryableError) throw error;
    const cause = error instanceof Error && error.cause ? error.cause : error;
    const code =
      typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
    if (
      code.includes("CONSTRAINT_UNIQUE") ||
      (code === "SQLITE_CONSTRAINT" && cause instanceof Error && cause.message.includes("UNIQUE"))
    )
      throw new DomainError(
        "DUPLICATE",
        "مقدار تکراری است؛ SKU، نام دسته‌بندی یا کد رهگیری این شرکت حمل قبلاً ثبت شده است.",
      );
    throw error;
  }
}
export async function audit(
  tx: Transaction,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Json,
) {
  await tx.insert(auditLogs).values({ userId, action, entityType, entityId, details });
}
export function pagination(total: number, requestedPage: number) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(
    pages - 1,
    Math.max(0, Math.trunc(Number.isFinite(requestedPage) ? requestedPage : 0)),
  );
  return { total, page, pages, pageSize: PAGE_SIZE, offset: page * PAGE_SIZE };
}
export function pageResult<T>(info: ReturnType<typeof pagination>, items: T[]): Page<T> {
  return { total: info.total, page: info.page, pages: info.pages, pageSize: info.pageSize, items };
}
export const countAll = sql<number>`count(*)`;
