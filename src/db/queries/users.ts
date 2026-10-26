import { and, desc, eq } from "drizzle-orm";
import type { User as TelegramUser } from "grammy/types";
import { auditLogs, users } from "@/db/schema";
import type { Database } from "@/db/client";
import { userInput } from "@/lib/validation";
import { invariant } from "@/lib/errors";
import type { Lease } from "@/types/domain";
import { audit, countAll, mutate, pagination, pageResult, requireActor } from "./common";

export function userQueries(db: Database, bootstrapIds: readonly number[]) {
  return {
    async authenticate(from: TelegramUser) {
      const bootstrap = bootstrapIds.includes(from.id);
      // The role/active flag is set ONLY on insert. Revocations must survive /start.
      const [user] = await db
        .insert(users)
        .values({
          telegramId: from.id,
          firstName: from.first_name.slice(0, 100),
          lastName: from.last_name?.slice(0, 100) ?? null,
          username: from.username ?? null,
          role: bootstrap ? "super_admin" : "viewer",
          isActive: bootstrap,
        })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: {
            firstName: from.first_name.slice(0, 100),
            lastName: from.last_name?.slice(0, 100) ?? null,
            username: from.username ?? null,
          },
        })
        .returning();
      invariant(user, "USER_NOT_FOUND", "کاربر یافت نشد.");
      return user;
    },
    async list(actorId: string, requestedPage = 0) {
      await requireActor(db, actorId, "users:manage");
      const [row] = await db.select({ count: countAll }).from(users);
      const p = pagination(row?.count ?? 0, requestedPage);
      return pageResult(
        p,
        await db
          .select()
          .from(users)
          .orderBy(desc(users.createdAt), users.id)
          .limit(p.pageSize)
          .offset(p.offset),
      );
    },
    async get(actorId: string, id: string) {
      await requireActor(db, actorId, "users:manage");
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      invariant(user, "NOT_FOUND", "کاربر یافت نشد.");
      return user;
    },
    async save(actorId: string, input: unknown, key: string, lease?: Lease) {
      const value = userInput.parse(input);
      return mutate(db, actorId, "users:manage", key, lease, async (tx) => {
        const [existing] = await tx
          .select()
          .from(users)
          .where(eq(users.telegramId, value.telegramId))
          .limit(1);
        if (
          existing?.isActive &&
          existing.role === "super_admin" &&
          (!value.isActive || value.role !== "super_admin")
        ) {
          const [row] = await tx
            .select({ count: countAll })
            .from(users)
            .where(and(eq(users.role, "super_admin"), eq(users.isActive, true)));
          invariant(
            (row?.count ?? 0) > 1,
            "LAST_SUPER_ADMIN",
            "آخرین مدیرکل فعال را نمی‌توان حذف دسترسی یا غیرفعال کرد.",
          );
        }
        const [saved] = await tx
          .insert(users)
          .values(value)
          .onConflictDoUpdate({
            target: users.telegramId,
            set: { firstName: value.firstName, role: value.role, isActive: value.isActive },
          })
          .returning({ id: users.id });
        invariant(saved, "NOT_FOUND", "ذخیره کاربر ناموفق بود.");
        await audit(tx, actorId, existing ? "user.update" : "user.create", "user", saved.id, {
          previousRole: existing?.role ?? null,
          role: value.role,
          isActive: value.isActive,
        });
        return saved;
      });
    },
    async activity(actorId: string, requestedPage = 0) {
      await requireActor(db, actorId, "users:manage");
      const [row] = await db.select({ count: countAll }).from(auditLogs);
      const p = pagination(row?.count ?? 0, requestedPage);
      const items = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          userTelegramId: users.telegramId,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .innerJoin(users, eq(auditLogs.userId, users.id))
        .orderBy(desc(auditLogs.createdAt), auditLogs.id)
        .limit(p.pageSize)
        .offset(p.offset);
      return pageResult(p, items);
    },
  };
}
