import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  asc,
  eq,
  gte,
  sql,
  or,
  isNull,
  inArray,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import {
  inventoryLogs,
  orderItems,
  orders,
  products,
  users,
  shipments,
  orderReferences,
} from "@/db/schema";
import type { Database } from "@/db/client";
import { orderInput, uuid, normalizeDigits } from "@/lib/validation";
import { calculateTotal, lineTotal, validateStock } from "@/lib/money";
import { invariant } from "@/lib/errors";
import {
  MAX_STOCK,
  orderStatuses,
  orderListFilters,
  type OrderListFilter,
  paymentStatuses,
  type Lease,
  type OrderStatus,
} from "@/types/domain";
import { audit, mutate, pagination, pageResult, requireActor } from "./common";

import { allocateOrderReference } from "./references";
import { recordShipmentStatus } from "./shipments";
import { shipmentReady } from "@/lib/shipping";
import { compactReference, escapeLike } from "@/lib/reference";

export const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};
export function orderQueries(db: Database) {
  return {
    async list(actorId: string, requestedPage = 0, filter: OrderListFilter = "all", search = "") {
      await requireActor(db, actorId, "orders:read");
      z.enum(orderListFilters).parse(filter);
      const conditions: SQL[] = [];
      if (filter === "ready")
        conditions.push(and(eq(orders.status, "processing"), eq(orders.paymentStatus, "paid"))!);
      if (filter === "shipped") conditions.push(eq(orders.status, "shipped"));
      if (filter === "untracked")
        conditions.push(
          and(inArray(orders.status, ["shipped", "delivered"]), isNull(shipments.id))!,
        );
      const term = z.string().trim().max(100).parse(search);
      if (term) {
        const plain = `%${escapeLike(term)}%`;
        const tracking = `%${escapeLike(term.replace(/\s/g, ""))}%`;
        const compact = `%${escapeLike(compactReference(term))}%`;
        // Normalize Persian digits for codes/phones but preserve the name search as typed.
        const numeric = `%${escapeLike(normalizeDigits(term).replace(/\s/g, ""))}%`;
        conditions.push(
          or(
            sql`${orders.orderNumber} like ${plain} escape '\\'`,
            and(
              sql`${compactReference(term).length} > 0`,
              sql`replace(${orderReferences.code}, '-', '') like ${compact} escape '\\'`,
            ),
            sql`${shipments.trackingNumber} like ${tracking} escape '\\'`,
            sql`${shipments.trackingNumber} like ${numeric} escape '\\'`,
            sql`${orders.customerName} like ${plain} escape '\\'`,
            sql`${orders.customerPhone} like ${numeric} escape '\\'`,
          )!,
        );
      }
      const where = and(...conditions);
      const [row] = await db
        .select({ count: sql<number>`count(distinct ${orders.id})` })
        .from(orders)
        .leftJoin(orderReferences, eq(orderReferences.orderId, orders.id))
        .leftJoin(shipments, eq(shipments.orderId, orders.id))
        .where(where);
      const p = pagination(row?.count ?? 0, requestedPage);
      return pageResult(
        p,
        await db
          .selectDistinct({ ...getTableColumns(orders), referenceCode: orderReferences.code })
          .from(orders)
          .leftJoin(orderReferences, eq(orderReferences.orderId, orders.id))
          .leftJoin(shipments, eq(shipments.orderId, orders.id))
          .where(where)
          .orderBy(desc(orders.createdAt), orders.id)
          .limit(p.pageSize)
          .offset(p.offset),
      );
    },
    async get(actorId: string, id: string) {
      await requireActor(db, actorId, "orders:read");
      uuid.parse(id);
      const [order] = await db.select().from(orders).where(eq(orders.id, id));
      invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
      const items = await db
        .select({
          id: orderItems.id,
          productId: orderItems.productId,
          name: products.name,
          sku: products.sku,
          quantity: orderItems.quantity,
          unitPrice: orderItems.unitPrice,
          totalPrice: orderItems.totalPrice,
        })
        .from(orderItems)
        .innerJoin(products, eq(orderItems.productId, products.id))
        .where(eq(orderItems.orderId, id));
      const [reference] = await db
        .select()
        .from(orderReferences)
        .where(eq(orderReferences.orderId, id));
      const parcels = await db
        .select()
        .from(shipments)
        .where(eq(shipments.orderId, id))
        .orderBy(asc(shipments.parcelNumber));
      return {
        ...order,
        items,
        referenceCode: reference?.code ?? order.orderNumber,
        // Compatibility only: a multi-parcel order has no single shipment.
        shipment: parcels.length === 1 ? parcels[0]! : null,
        shipments: parcels,
      };
    },
    async create(actorId: string, input: unknown, key: string, lease?: Lease) {
      const value = orderInput.parse(input);
      return mutate(db, actorId, "orders:create", key, lease, async (tx) => {
        const grouped = new Map<string, { quantity: number; expectedUnitPrice: number }>();
        for (const item of value.items) {
          const old = grouped.get(item.productId);
          invariant(
            !old || old.expectedUnitPrice === item.expectedUnitPrice,
            "PRICE_CHANGED",
            "قیمت انتخاب‌های تکراری یکسان نیست.",
          );
          const quantity = (old?.quantity ?? 0) + item.quantity;
          invariant(quantity <= MAX_STOCK, "BAD_QUANTITY", "تعداد بیش از حد مجاز است.");
          grouped.set(item.productId, { quantity, expectedUnitPrice: item.expectedUnitPrice });
        }
        const lines: {
          productId: string;
          quantity: number;
          unitPrice: number;
          previousStock: number;
        }[] = [];
        for (const [productId, item] of [...grouped.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const [product] = await tx
            .select()
            .from(products)
            .where(and(eq(products.id, productId), eq(products.isActive, true)));
          invariant(product, "NOT_FOUND", "یکی از محصولات دیگر فعال نیست.");
          invariant(
            product.price === item.expectedUnitPrice,
            "PRICE_CHANGED",
            "قیمت محصول تغییر کرده است؛ سفارش را دوباره ثبت کنید.",
          );
          validateStock(product.stockQuantity, item.quantity);
          lines.push({
            productId,
            quantity: item.quantity,
            unitPrice: product.price,
            previousStock: product.stockQuantity,
          });
        }
        const totalAmount = calculateTotal(lines);
        // A customer row is inactive and has no staff access; existing staff are never downgraded.
        await tx
          .insert(users)
          .values({
            telegramId: value.customer.telegramId,
            firstName: value.customer.name,
            role: "viewer",
            isActive: false,
          })
          .onConflictDoNothing({ target: users.telegramId });
        const id = randomUUID();
        const orderNumber = `ORD-${id.replaceAll("-", "").toUpperCase()}`;
        await tx.insert(orders).values({
          id,
          orderNumber,
          customerTelegramId: value.customer.telegramId,
          customerName: value.customer.name,
          customerPhone: value.customer.phone,
          shippingAddress: value.customer.address,
          totalAmount,
          notes: value.notes,
        });
        const referenceCode = await allocateOrderReference(tx, id);
        for (const line of lines) {
          const [reserved] = await tx
            .update(products)
            .set({
              stockQuantity: sql`${products.stockQuantity} - ${line.quantity}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(products.id, line.productId),
                eq(products.isActive, true),
                gte(products.stockQuantity, line.quantity),
              ),
            )
            .returning({ stock: products.stockQuantity });
          invariant(reserved, "INSUFFICIENT_STOCK", "موجودی برای ثبت سفارش کافی نیست.");
          await tx.insert(orderItems).values({
            orderId: id,
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            totalPrice: lineTotal(line.unitPrice, line.quantity),
          });
          await tx.insert(inventoryLogs).values({
            productId: line.productId,
            changeType: "out",
            quantityChange: -line.quantity,
            previousStock: line.previousStock,
            newStock: reserved.stock,
            referenceId: id,
            userId: actorId,
            note: "رزرو سفارش",
          });
        }
        await audit(tx, actorId, "order.create", "order", id, {
          totalAmount,
          lineCount: lines.length,
        });
        return { id, orderNumber, referenceCode, totalAmount };
      });
    },
    async setStatus(actorId: string, id: string, status: OrderStatus, key: string, lease?: Lease) {
      uuid.parse(id);
      z.enum(orderStatuses).parse(status);
      return mutate(db, actorId, "orders:status", key, lease, async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, id));
        invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
        if (order.status === status) return { id, status };
        invariant(
          transitions[order.status].includes(status),
          "INVALID_TRANSITION",
          "این تغییر وضعیت مجاز نیست یا سفارش هم‌زمان تغییر کرده است.",
        );
        if (status === "shipped") {
          invariant(
            order.paymentStatus === "paid",
            "UNPAID",
            "پیش از ارسال، پرداخت باید توسط مدیر تأیید شود.",
          );
          const parcels = await tx.select().from(shipments).where(eq(shipments.orderId, id));
          invariant(
            parcels.length > 0 && parcels.every(shipmentReady),
            "SHIPPING_REQUIRED",
            "پیش از ارسال، شرکت حمل و کد رهگیری معتبر ساختاری را ثبت کنید؛ برای پیک/تحویل حضوری کد اجباری نیست.",
          );
          await recordShipmentStatus(tx, actorId, id, "dispatched", new Date());
        }
        if (status === "delivered")
          await recordShipmentStatus(tx, actorId, id, "delivered", new Date());
        if (status === "cancelled") {
          const sent = await tx
            .select({ id: shipments.id })
            .from(shipments)
            .where(
              and(eq(shipments.orderId, id), inArray(shipments.state, ["dispatched", "delivered"])),
            )
            .limit(1);
          invariant(
            sent.length === 0,
            "PARTIALLY_SHIPPED",
            "بخشی از سفارش ارسال شده است؛ لغو و بازگرداندن کل موجودی مجاز نیست.",
          );
          const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
          for (const item of items) {
            const [product] = await tx
              .select()
              .from(products)
              .where(eq(products.id, item.productId));
            invariant(
              product && product.stockQuantity + item.quantity <= MAX_STOCK,
              "STOCK_OVERFLOW",
              "بازگردانی موجودی از سقف مجاز بیشتر می‌شود.",
            );
            const newStock = product.stockQuantity + item.quantity;
            await tx
              .update(products)
              .set({ stockQuantity: newStock, updatedAt: new Date() })
              .where(eq(products.id, product.id));
            await tx.insert(inventoryLogs).values({
              productId: product.id,
              changeType: "in",
              quantityChange: item.quantity,
              previousStock: product.stockQuantity,
              newStock,
              referenceId: id,
              userId: actorId,
              note: "بازگشت موجودی سفارش لغوشده",
            });
          }
        }
        await tx.update(orders).set({ status, updatedAt: new Date() }).where(eq(orders.id, id));
        await audit(tx, actorId, "order.status", "order", id, { from: order.status, to: status });
        return { id, status };
      });
    },
    async setPayment(
      actorId: string,
      id: string,
      status: "paid" | "refunded",
      key: string,
      lease?: Lease,
    ) {
      uuid.parse(id);
      z.enum(paymentStatuses).parse(status);
      return mutate(db, actorId, "orders:payment", key, lease, async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, id));
        invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
        if (order.paymentStatus === status) return { id, status };
        if (status === "paid")
          invariant(
            order.paymentStatus === "unpaid" && order.status !== "cancelled",
            "INVALID_PAYMENT",
            "تأیید پرداخت این سفارش ممکن نیست.",
          );
        else
          invariant(
            order.paymentStatus === "paid" && order.status === "cancelled",
            "INVALID_REFUND",
            "ثبت بازپرداخت فقط برای سفارش لغوشده و پرداخت‌شده ممکن است.",
          );
        await tx
          .update(orders)
          .set({ paymentStatus: status, updatedAt: new Date() })
          .where(eq(orders.id, id));
        await audit(tx, actorId, "order.payment", "order", id, {
          from: order.paymentStatus,
          to: status,
          manual: true,
        });
        return { id, status };
      });
    },
  };
}
