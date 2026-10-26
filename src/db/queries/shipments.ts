import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  orders,
  shipments,
  shipmentSequences,
  users,
  orderReferences,
  type Shipment,
} from "@/db/schema";
import type { Database, Transaction } from "@/db/client";
import {
  shipmentInput,
  shipmentReady,
  shipmentRevision,
  type ShipmentInput,
  type ShipmentRevision,
} from "@/lib/shipping";
import { uuid } from "@/lib/validation";
import { authorize } from "@/lib/permissions";
import { invariant } from "@/lib/errors";
import { MAX_SHIPMENTS_PER_ORDER, type Json, type Lease, type ShipmentState } from "@/types/domain";
import { audit, countAll, mutate, pagination, pageResult, requireActor } from "./common";

export function shipmentSnapshot(row: Shipment) {
  return {
    id: row.id,
    parcelNumber: row.parcelNumber,
    state: row.state,
    carrier: row.carrier,
    carrierName: row.carrierName,
    trackingNumber: row.trackingNumber,
    trackingUrl: row.trackingUrl,
    postalCode: row.postalCode,
    shippingCost: row.shippingCost,
    note: row.note,
    version: row.version,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  } satisfies Json;
}
function checkRevision(existing: Shipment | undefined, revision: ShipmentRevision) {
  invariant(
    revision !== null && existing?.id === revision.id && existing.version === revision.version,
    "SHIPMENT_CHANGED",
    "اطلاعات ارسال هم‌زمان تغییر کرده است؛ صفحه را دوباره باز کنید.",
  );
}
function sameData(existing: Shipment, input: ShipmentInput): boolean {
  return (
    existing.carrier === input.carrier &&
    existing.carrierName === input.carrierName &&
    existing.trackingNumber === input.trackingNumber &&
    existing.trackingUrl === input.trackingUrl &&
    existing.postalCode === input.postalCode &&
    existing.shippingCost === input.shippingCost &&
    existing.note === input.note
  );
}
async function nextParcelNumber(tx: Transaction, orderId: string) {
  // Allocation stays inside the enclosing write transaction; no independent counter commit.
  const [counter] = await tx
    .select()
    .from(shipmentSequences)
    .where(eq(shipmentSequences.orderId, orderId));
  const next = (counter?.lastNumber ?? 0) + 1;
  invariant(Number.isSafeInteger(next), "PARCEL_OVERFLOW", "سقف شماره‌گذاری مرسوله رد شده است.");
  if (counter)
    await tx
      .update(shipmentSequences)
      .set({ lastNumber: next })
      .where(eq(shipmentSequences.orderId, orderId));
  else await tx.insert(shipmentSequences).values({ orderId, lastNumber: next });
  return next;
}
async function updateParcelStatus(
  tx: Transaction,
  actorId: string,
  current: Shipment,
  event: "dispatched" | "delivered",
  now: Date,
  reason: string,
) {
  if (current.state === event || current.state === "delivered") return current;
  invariant(
    event === "dispatched" ? current.state === "draft" : current.state === "dispatched",
    "INVALID_PARCEL_TRANSITION",
    "ابتدا ارسال مرسوله را ثبت کنید؛ برگشت وضعیت مجاز نیست.",
  );
  const [updated] = await tx
    .update(shipments)
    .set({
      state: event,
      ...(event === "dispatched"
        ? { dispatchedAt: current.dispatchedAt ?? now }
        : { deliveredAt: current.deliveredAt ?? now }),
      updatedAt: now,
      updatedBy: actorId,
      version: current.version + 1,
    })
    .where(eq(shipments.id, current.id))
    .returning();
  invariant(updated, "NOT_FOUND", "مرسوله یافت نشد.");
  await audit(tx, actorId, `shipment.${event}`, "shipment", current.orderId, {
    before: shipmentSnapshot(current),
    after: shipmentSnapshot(updated),
    reason,
  });
  return updated;
}
// Bulk order transitions operate on every current parcel in the same transaction.
export async function recordShipmentStatus(
  tx: Transaction,
  actorId: string,
  orderId: string,
  event: "dispatched" | "delivered",
  now: Date,
) {
  const current = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId))
    .orderBy(asc(shipments.parcelNumber));
  for (const parcel of current)
    await updateParcelStatus(tx, actorId, parcel, event, now, "تغییر وضعیت کل سفارش");
}
async function syncOrderStatus(tx: Transaction, actorId: string, orderId: string, now: Date) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
  const rows = await tx
    .select({ state: shipments.state })
    .from(shipments)
    .where(eq(shipments.orderId, orderId));
  let status = order.status;
  if (rows.length && rows.every((row) => row.state !== "draft") && status === "processing") {
    await tx
      .update(orders)
      .set({ status: "shipped", updatedAt: now })
      .where(eq(orders.id, orderId));
    await audit(tx, actorId, "order.status", "order", orderId, {
      from: status,
      to: "shipped",
      reason: "همهٔ مرسوله‌های جاری ارسال شده‌اند",
    });
    status = "shipped";
  }
  if (rows.length && rows.every((row) => row.state === "delivered") && status === "shipped") {
    await tx
      .update(orders)
      .set({ status: "delivered", updatedAt: now })
      .where(eq(orders.id, orderId));
    await audit(tx, actorId, "order.status", "order", orderId, {
      from: status,
      to: "delivered",
      reason: "همهٔ مرسوله‌های جاری تحویل شده‌اند",
    });
    status = "delivered";
  }
  return status;
}
export function shipmentQueries(db: Database) {
  return {
    async get(actorId: string, orderId: string, shipmentId?: string) {
      await requireActor(db, actorId, "orders:read");
      uuid.parse(orderId);
      if (shipmentId) uuid.parse(shipmentId);
      const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
      invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
      const rows = await db
        .select()
        .from(shipments)
        .where(
          and(
            eq(shipments.orderId, orderId),
            shipmentId ? eq(shipments.id, shipmentId) : undefined,
          ),
        )
        .orderBy(asc(shipments.parcelNumber));
      invariant(
        shipmentId || rows.length <= 1,
        "SHIPMENT_AMBIGUOUS",
        "این سفارش چند مرسوله دارد؛ مرسولهٔ مشخص را انتخاب کنید.",
      );
      if (shipmentId) invariant(rows[0], "NOT_FOUND", "مرسوله یافت نشد.");
      return rows[0] ?? null;
    },
    async getById(actorId: string, shipmentId: string) {
      await requireActor(db, actorId, "orders:read");
      uuid.parse(shipmentId);
      const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId));
      invariant(row, "NOT_FOUND", "مرسوله یافت نشد.");
      return row;
    },
    async list(actorId: string, orderId: string) {
      await requireActor(db, actorId, "orders:read");
      uuid.parse(orderId);
      const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
      invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
      return db
        .select()
        .from(shipments)
        .where(eq(shipments.orderId, orderId))
        .orderBy(asc(shipments.parcelNumber));
    },
    async save(
      actorId: string,
      orderId: string,
      input: unknown,
      expected: ShipmentRevision,
      reason: string,
      key: string,
      lease?: Lease,
    ) {
      uuid.parse(orderId);
      const value = shipmentInput.parse(input);
      const revision = shipmentRevision.parse(expected);
      const explanation = z.string().trim().max(200).parse(reason);
      return mutate(db, actorId, "orders:shipping", key, lease, async (tx, actor) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
        invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
        invariant(
          order.status !== "cancelled",
          "ORDER_CANCELLED",
          "اطلاعات ارسال سفارش لغوشده فقط قابل مشاهده است.",
        );
        const rows = await tx.select().from(shipments).where(eq(shipments.orderId, orderId));
        const existing = revision ? rows.find((row) => row.id === revision.id) : undefined;
        if (revision) checkRevision(existing, revision);
        if (order.status === "delivered" || existing?.state === "delivered")
          authorize(actor.role, "orders:shipping:correct");
        if (!revision) {
          invariant(
            !["shipped", "delivered"].includes(order.status) || rows.length === 0,
            "SHIPMENT_PLAN_LOCKED",
            "پس از ارسال کل سفارش، افزودن مرسوله مجاز نیست؛ فقط اطلاعات مفقود سفارش قدیمی قابل تکمیل است.",
          );
          invariant(
            rows.length < MAX_SHIPMENTS_PER_ORDER,
            "PARCEL_LIMIT",
            `حداکثر ${MAX_SHIPMENTS_PER_ORDER} مرسولهٔ جاری برای هر سفارش مجاز است.`,
          );
        }
        if (existing && sameData(existing, value))
          return { id: existing.id, orderId, version: existing.version };
        invariant(
          !(existing || ["shipped", "delivered"].includes(order.status)) || explanation.length >= 3,
          "REASON_REQUIRED",
          "برای اصلاح یا تکمیل ارسال قدیمی، علت تغییر را بنویسید.",
        );
        if (value.trackingNumber) {
          const [reference] = await tx
            .select()
            .from(orderReferences)
            .where(eq(orderReferences.orderId, orderId));
          invariant(
            value.trackingNumber.toUpperCase() !== reference?.code,
            "WRONG_TRACKING_KIND",
            "کد پیگیری REF سفارش، کد مرسولهٔ شرکت حمل نیست.",
          );
          const [duplicate] = await tx
            .select({ id: shipments.id })
            .from(shipments)
            .where(
              and(
                eq(shipments.carrier, value.carrier),
                eq(shipments.carrierName, value.carrierName),
                eq(shipments.trackingNumber, value.trackingNumber),
              ),
            );
          invariant(
            !duplicate || duplicate.id === existing?.id,
            "TRACKING_IN_USE",
            "این کد رهگیری برای همین شرکت حمل قبلاً به مرسولهٔ دیگری اختصاص یافته است.",
          );
        }
        let saved: Shipment | undefined;
        if (existing) {
          [saved] = await tx
            .update(shipments)
            .set({
              ...value,
              version: existing.version + 1,
              updatedAt: new Date(),
              updatedBy: actorId,
            })
            .where(eq(shipments.id, existing.id))
            .returning();
        } else {
          const parcelNumber = await nextParcelNumber(tx, orderId);
          const state: ShipmentState =
            order.status === "delivered"
              ? "delivered"
              : order.status === "shipped"
                ? "dispatched"
                : "draft";
          [saved] = await tx
            .insert(shipments)
            .values({
              ...value,
              orderId,
              parcelNumber,
              state,
              createdBy: actorId,
              updatedBy: actorId,
            })
            .returning();
        }
        invariant(saved, "NOT_FOUND", "ثبت اطلاعات ارسال موفق نبود.");
        await audit(
          tx,
          actorId,
          existing ? "shipment.update" : "shipment.create",
          "shipment",
          orderId,
          {
            before: existing ? shipmentSnapshot(existing) : null,
            after: shipmentSnapshot(saved),
            reason: explanation || "ثبت مرسولهٔ جدید",
          },
        );
        return { id: saved.id, orderId, version: saved.version };
      });
    },
    async transition(
      actorId: string,
      shipmentId: string,
      event: "dispatched" | "delivered",
      expected: NonNullable<ShipmentRevision>,
      key: string,
      lease?: Lease,
    ) {
      uuid.parse(shipmentId);
      z.enum(["dispatched", "delivered"]).parse(event);
      const revision = shipmentRevision.parse(expected);
      return mutate(db, actorId, "orders:shipping", key, lease, async (tx, actor) => {
        authorize(actor.role, "orders:status");
        const [parcel] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
        invariant(parcel, "NOT_FOUND", "مرسوله یافت نشد.");
        checkRevision(parcel, revision);
        const [order] = await tx.select().from(orders).where(eq(orders.id, parcel.orderId));
        invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
        invariant(
          ["processing", "shipped", "delivered"].includes(order.status),
          "ORDER_NOT_PROCESSING",
          "ارسال مرسوله فقط برای سفارشِ درحال پردازش و پرداخت‌شده مجاز است.",
        );
        if (event === "dispatched" && parcel.state === "draft")
          invariant(
            order.status === "processing",
            "ORDER_NOT_PROCESSING",
            "ارسال جدید فقط در مرحلهٔ پردازش سفارش مجاز است.",
          );
        invariant(
          order.paymentStatus === "paid",
          "UNPAID",
          "پیش از ارسال، پرداخت باید توسط مدیر تأیید شود.",
        );
        invariant(shipmentReady(parcel), "SHIPPING_REQUIRED", "اطلاعات حمل مرسوله را کامل کنید.");
        invariant(
          !(event === "dispatched" && parcel.state === "delivered"),
          "INVALID_PARCEL_TRANSITION",
          "مرسولهٔ تحویل‌شده قابل بازگشت به ارسال نیست.",
        );
        const now = new Date();
        const updated = await updateParcelStatus(
          tx,
          actorId,
          parcel,
          event,
          now,
          "تغییر وضعیت همین مرسوله",
        );
        const orderStatus = await syncOrderStatus(tx, actorId, parcel.orderId, now);
        return {
          id: updated.id,
          orderId: parcel.orderId,
          version: updated.version,
          state: updated.state,
          orderStatus,
        };
      });
    },
    async clearDraft(
      actorId: string,
      orderId: string,
      expected: NonNullable<ShipmentRevision>,
      reason: string,
      key: string,
      lease?: Lease,
    ) {
      uuid.parse(orderId);
      const revision = shipmentRevision.parse(expected);
      const explanation = z
        .string()
        .trim()
        .min(3, "علت پاک‌کردن را بنویسید.")
        .max(200)
        .parse(reason);
      return mutate(db, actorId, "orders:shipping", key, lease, async (tx, actor) => {
        authorize(actor.role, "orders:status");
        const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
        invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
        invariant(
          ["pending", "confirmed", "processing"].includes(order.status),
          "ALREADY_DISPATCHED",
          "بعد از ارسال کل، تحویل یا لغو، پاک‌کردن اطلاعات ارسال مجاز نیست.",
        );
        const [existing] = revision
          ? await tx
              .select()
              .from(shipments)
              .where(and(eq(shipments.orderId, orderId), eq(shipments.id, revision.id)))
          : [];
        checkRevision(existing, revision);
        invariant(
          existing && existing.state === "draft" && !existing.dispatchedAt && !existing.deliveredAt,
          "ALREADY_DISPATCHED",
          "فقط پیش‌نویس همین مرسوله قابل پاک‌کردن است.",
        );
        await tx.delete(shipments).where(eq(shipments.id, existing.id));
        await audit(tx, actorId, "shipment.clear", "shipment", orderId, {
          before: shipmentSnapshot(existing),
          after: null,
          reason: explanation,
        });
        // Removing the last unsent draft can complete the *current* shipment plan.
        // Keep that aggregate update and its audit atomic with the selected deletion.
        await syncOrderStatus(tx, actorId, orderId, new Date());
        return { orderId };
      });
    },
    async history(actorId: string, orderId: string, pageNumber = 0) {
      await requireActor(db, actorId, "orders:read");
      uuid.parse(orderId);
      const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
      invariant(order, "NOT_FOUND", "سفارش یافت نشد.");
      const where = and(eq(auditLogs.entityType, "shipment"), eq(auditLogs.entityId, orderId));
      const [row] = await db.select({ count: countAll }).from(auditLogs).where(where);
      const p = pagination(row?.count ?? 0, pageNumber);
      return pageResult(
        p,
        await db
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            details: auditLogs.details,
            createdAt: auditLogs.createdAt,
            actorName: users.firstName,
            actorTelegramId: users.telegramId,
          })
          .from(auditLogs)
          .innerJoin(users, eq(auditLogs.userId, users.id))
          .where(where)
          .orderBy(desc(auditLogs.createdAt), auditLogs.id)
          .limit(p.pageSize)
          .offset(p.offset),
      );
    },
  };
}
