import { and, desc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { inventoryLogs, orders, products, users } from "@/db/schema";
import type { Database } from "@/db/client";
import { invariant } from "@/lib/errors";
import { periodBounds } from "@/lib/time";
import { countAll, pagination, pageResult, requireActor } from "./common";

export function reportQueries(db: Database, timeZone: string) {
  return {
    async sales(actorId: string, period: "day" | "month", now = new Date()) {
      await requireActor(db, actorId, "reports:read");
      const { start, end } = periodBounds(now, period, timeZone);
      const [row] = await db
        .select({
          orderCount: countAll,
          total: sql<number>`coalesce(sum(${orders.totalAmount}), 0)`,
        })
        .from(orders)
        .where(
          and(
            gte(orders.createdAt, start),
            lt(orders.createdAt, end),
            eq(orders.paymentStatus, "paid"),
            ne(orders.status, "cancelled"),
          ),
        );
      const total = Number(row?.total ?? 0);
      invariant(
        Number.isSafeInteger(total),
        "AMOUNT_OVERFLOW",
        "مبلغ گزارش بیش از محدودهٔ مجاز است.",
      );
      return { orderCount: row?.orderCount ?? 0, total, start, end };
    },
    async lowStock(actorId: string, requestedPage = 0) {
      await requireActor(db, actorId, "reports:read");
      const where = and(
        eq(products.isActive, true),
        lte(products.stockQuantity, products.minStockLevel),
      );
      const [row] = await db.select({ count: countAll }).from(products).where(where);
      const p = pagination(row?.count ?? 0, requestedPage);
      return pageResult(
        p,
        await db
          .select({
            id: products.id,
            name: products.name,
            sku: products.sku,
            stock: products.stockQuantity,
            minimum: products.minStockLevel,
          })
          .from(products)
          .where(where)
          .orderBy(products.stockQuantity, products.id)
          .limit(p.pageSize)
          .offset(p.offset),
      );
    },
    async movements(actorId: string, requestedPage = 0) {
      await requireActor(db, actorId, "reports:read");
      const [row] = await db.select({ count: countAll }).from(inventoryLogs);
      const p = pagination(row?.count ?? 0, requestedPage);
      const items = await db
        .select({
          id: inventoryLogs.id,
          productName: products.name,
          changeType: inventoryLogs.changeType,
          change: inventoryLogs.quantityChange,
          previousStock: inventoryLogs.previousStock,
          newStock: inventoryLogs.newStock,
          createdAt: inventoryLogs.createdAt,
          actorTelegramId: users.telegramId,
          referenceId: inventoryLogs.referenceId,
        })
        .from(inventoryLogs)
        .innerJoin(products, eq(inventoryLogs.productId, products.id))
        .innerJoin(users, eq(inventoryLogs.userId, users.id))
        .orderBy(desc(inventoryLogs.createdAt), inventoryLogs.id)
        .limit(p.pageSize)
        .offset(p.offset);
      return pageResult(p, items);
    },
  };
}
