import { and, asc, eq, gte, inArray, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import { orders, orderReferences, shipments } from "@/db/schema";
import {
  MAX_EXPORT_ROWS,
  exportPeriods,
  orderListFilters,
  shipmentStates,
  type Lease,
} from "@/types/domain";
import { periodBounds } from "@/lib/time";
import { invariant } from "@/lib/errors";
import { audit, mutate, requireActor } from "./common";

export const exportOptions = z.object({
  filter: z.enum(orderListFilters),
  state: z.enum(["all", ...shipmentStates]),
  period: z.enum(exportPeriods),
});
export type ExportOptions = z.infer<typeof exportOptions>;
export function exportQueries(db: Database, timeZone: string) {
  return {
    async shipments(actorId: string, input: unknown, now = new Date()) {
      await requireActor(db, actorId, "orders:export");
      const options = exportOptions.parse(input);
      const conditions: SQL[] = [];
      if (options.filter === "ready")
        conditions.push(and(eq(orders.status, "processing"), eq(orders.paymentStatus, "paid"))!);
      if (options.filter === "shipped") conditions.push(eq(orders.status, "shipped"));
      if (options.filter === "untracked")
        conditions.push(
          and(inArray(orders.status, ["shipped", "delivered"]), isNull(shipments.id))!,
        );
      if (options.state !== "all") conditions.push(eq(shipments.state, options.state));
      const range = options.period === "all" ? null : periodBounds(now, options.period, timeZone);
      if (range)
        conditions.push(gte(orders.createdAt, range.start), lt(orders.createdAt, range.end));
      const rows = await db
        .select({
          orderId: orders.id,
          referenceCode: orderReferences.code,
          orderNumber: orders.orderNumber,
          customerName: orders.customerName,
          customerPhone: orders.customerPhone,
          address: orders.shippingAddress,
          orderStatus: orders.status,
          paymentStatus: orders.paymentStatus,
          orderCreatedAt: orders.createdAt,
          shipmentId: shipments.id,
          parcelNumber: shipments.parcelNumber,
          state: shipments.state,
          carrier: shipments.carrier,
          carrierName: shipments.carrierName,
          trackingNumber: shipments.trackingNumber,
          trackingUrl: shipments.trackingUrl,
          postalCode: shipments.postalCode,
          shippingCost: shipments.shippingCost,
          dispatchedAt: shipments.dispatchedAt,
          deliveredAt: shipments.deliveredAt,
          note: shipments.note,
          shipmentCreatedAt: shipments.createdAt,
          updatedAt: shipments.updatedAt,
          version: shipments.version,
        })
        .from(orders)
        .leftJoin(orderReferences, eq(orderReferences.orderId, orders.id))
        .leftJoin(shipments, eq(shipments.orderId, orders.id))
        .where(and(...conditions))
        .orderBy(asc(orders.createdAt), orders.id, asc(shipments.parcelNumber))
        .limit(MAX_EXPORT_ROWS + 1);
      invariant(
        rows.length <= MAX_EXPORT_ROWS,
        "EXPORT_LIMIT",
        `خروجی بیش از ${MAX_EXPORT_ROWS} ردیف دارد؛ بازهٔ امروز/ماه یا فیلتر محدودتری انتخاب کنید. فایل ناقص صادر نشد.`,
      );
      return {
        rows,
        options,
        generatedAt: now,
        timeZone,
        range: range ? { start: range.start.toISOString(), end: range.end.toISOString() } : null,
      };
    },
    async recordGeneration(actorId: string, input: unknown, key: string, lease?: Lease) {
      const data = z
        .object({
          options: exportOptions,
          rows: z.number().int().min(0).max(MAX_EXPORT_ROWS),
          orders: z.number().int().min(0).max(MAX_EXPORT_ROWS),
          bytes: z
            .number()
            .int()
            .positive()
            .max(8 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(input);
      return mutate(db, actorId, "orders:export", key, lease, async (tx) => {
        // Generated, not delivered: Telegram can still fail after this audit commit.
        await audit(tx, actorId, "shipment.export.generated", "export", data.sha256, data);
        return { sha256: data.sha256 };
      });
    },
  };
}
export type ShipmentExport = Awaited<ReturnType<ReturnType<typeof exportQueries>["shipments"]>>;
