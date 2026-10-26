import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@/db/client";
import { createServices } from "@/db/queries";
import { auditLogs, orders, shipmentSequences, users } from "@/db/schema";
import { MAX_SHIPMENTS_PER_ORDER } from "@/types/domain";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";

let t: TestDatabase, productId: string, sequence: number;
const key = () => `parcel:test:${sequence++}`;
async function order() {
  return t.services.orders.create(
    t.actor.id,
    { customer, items: [{ productId, quantity: 1, expectedUnitPrice: testProduct.price }] },
    key(),
  );
}
async function parcel(orderId: string, code?: string) {
  return t.services.shipments.save(
    t.actor.id,
    orderId,
    code ? { carrier: "iran_post", trackingNumber: code } : { carrier: "pickup" },
    null,
    "",
    key(),
  );
}
async function ready(id: string, paid = true) {
  await t.services.orders.setStatus(t.actor.id, id, "confirmed", key());
  await t.services.orders.setStatus(t.actor.id, id, "processing", key());
  if (paid) await t.services.orders.setPayment(t.actor.id, id, "paid", key());
}
async function send(p: { id: string; version: number }) {
  return t.services.shipments.transition(t.actor.id, p.id, "dispatched", p, key());
}
async function deliver(p: { id: string; version: number }) {
  return t.services.shipments.transition(t.actor.id, p.id, "delivered", p, key());
}
beforeEach(async () => {
  sequence = 1;
  t = await testDatabase();
  productId = (
    await t.services.products.create(t.actor.id, { ...testProduct, stockQuantity: 200 }, key())
  ).id;
});
afterEach(() => t.close());

describe("independent parcels with safe whole-order fulfillment", () => {
  it("stores multiple parcels, never silently selects one, and keeps the order REF stable", async () => {
    const o = await order(),
      a = await parcel(o.id, "00001234"),
      b = await parcel(o.id, "00001235");
    const result = await t.services.orders.get(t.actor.id, o.id);
    expect(result.shipments.map((row) => row.parcelNumber)).toEqual([1, 2]);
    expect(result.shipment).toBeNull();
    expect(result.referenceCode).toBe(o.referenceCode);
    await expect(t.services.shipments.get(t.actor.id, o.id)).rejects.toMatchObject({
      code: "SHIPMENT_AMBIGUOUS",
    });
    expect((await t.services.shipments.get(t.actor.id, o.id, b.id))?.id).toBe(b.id);
    expect((await t.services.shipments.getById(t.actor.id, a.id)).parcelNumber).toBe(1);
    expect(await t.services.shipments.list(t.actor.id, o.id)).toHaveLength(2);
  });
  it("never reuses a parcel number after draft clearing, including the last draft", async () => {
    const o = await order(),
      a = await parcel(o.id),
      b = await parcel(o.id);
    await t.services.shipments.clearDraft(t.actor.id, o.id, b, "اصلاح برنامهٔ ارسال", key());
    const c = await parcel(o.id);
    expect((await t.services.shipments.getById(t.actor.id, c.id)).parcelNumber).toBe(3);
    await t.services.shipments.clearDraft(t.actor.id, o.id, a, "حذف پیش‌نویس نخست", key());
    await t.services.shipments.clearDraft(t.actor.id, o.id, c, "حذف پیش‌نویس آخر", key());
    const d = await parcel(o.id);
    expect((await t.services.shipments.getById(t.actor.id, d.id)).parcelNumber).toBe(4);
    expect((await t.services.shipments.history(t.actor.id, o.id)).total).toBe(7);
  });
  it("rejects a duplicate barcode even within the same order and scopes revisions to that order", async () => {
    const o = await order(),
      other = await order(),
      a = await parcel(o.id, "00Ab0091");
    await expect(parcel(o.id, "00Ab0091")).rejects.toMatchObject({ code: "TRACKING_IN_USE" });
    await expect(
      t.services.shipments.save(
        t.actor.id,
        other.id,
        { carrier: "pickup" },
        a,
        "مرسولهٔ اشتباه",
        key(),
      ),
    ).rejects.toMatchObject({ code: "SHIPMENT_CHANGED" });
    expect(await t.services.shipments.list(t.actor.id, other.id)).toHaveLength(0);
  });
  it("enforces the bounded current-parcel limit without consuming a number on failure", async () => {
    const o = await order();
    const rows = [];
    for (let i = 0; i < MAX_SHIPMENTS_PER_ORDER; i++) rows.push(await parcel(o.id));
    await expect(parcel(o.id)).rejects.toMatchObject({ code: "PARCEL_LIMIT" });
    expect((await t.db.select().from(shipmentSequences))[0]?.lastNumber).toBe(20);
    await t.services.shipments.clearDraft(t.actor.id, o.id, rows[19]!, "حذف پیش‌نویس اضافی", key());
    const next = await parcel(o.id);
    expect((await t.services.shipments.getById(t.actor.id, next.id)).parcelNumber).toBe(21);
  });
  it("keeps partial dispatch/delivery in processing without reserving or restoring stock again", async () => {
    const o = await order(),
      a = await parcel(o.id),
      b = await parcel(o.id);
    await ready(o.id);
    const sent = await send(a);
    expect(sent.orderStatus).toBe("processing");
    const done = await deliver(sent);
    expect(done.orderStatus).toBe("processing");
    expect((await t.services.shipments.getById(t.actor.id, b.id)).state).toBe("draft");
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(199);
    expect((await t.services.orders.get(t.actor.id, o.id)).totalAmount).toBe(testProduct.price);
  });
  it("advances whole-order state only after every current parcel is sent and delivered", async () => {
    const o = await order(),
      a = await parcel(o.id),
      b = await parcel(o.id);
    await ready(o.id);
    const as = await send(a),
      bs = await send(b);
    expect(bs.orderStatus).toBe("shipped");
    expect((await deliver(as)).orderStatus).toBe("shipped");
    expect((await deliver(bs)).orderStatus).toBe("delivered");
    const rows = await t.services.shipments.list(t.actor.id, o.id);
    for (const row of rows) {
      expect(row.state).toBe("delivered");
      expect(row.version).toBe(3);
      expect(row.dispatchedAt).toBeInstanceOf(Date);
      expect(row.deliveredAt).toBeInstanceOf(Date);
    }
    const audit = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, o.id));
    expect(
      audit.filter(
        (row) =>
          row.action === "order.status" && JSON.stringify(row.details).includes('"to":"shipped"'),
      ),
    ).toHaveLength(1);
  });
  it.each([false, true])(
    "recomputes the parent after clearing its last unsent draft (remaining delivered=%s)",
    async (delivered) => {
      const o = await order(),
        a = await parcel(o.id),
        b = await parcel(o.id);
      await ready(o.id);
      const sent = await send(a);
      if (delivered) await deliver(sent);
      expect((await t.services.orders.get(t.actor.id, o.id)).status).toBe("processing");
      await t.services.shipments.clearDraft(t.actor.id, o.id, b, "اصلاح برنامهٔ بسته‌بندی", key());
      expect((await t.services.orders.get(t.actor.id, o.id)).status).toBe(
        delivered ? "delivered" : "shipped",
      );
      expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(199);
      await expect(parcel(o.id)).rejects.toMatchObject({ code: "SHIPMENT_PLAN_LOCKED" });
    },
  );
  it("rolls back clearing and aggregate state together if the resulting parent audit fails", async () => {
    const o = await order(),
      a = await parcel(o.id),
      b = await parcel(o.id);
    await ready(o.id);
    await send(a);
    await t.client.execute(
      "CREATE TRIGGER fail_clear_aggregate BEFORE INSERT ON audit_logs WHEN NEW.action='order.status' BEGIN SELECT RAISE(ABORT,'simulated failure'); END",
    );
    const operation = key();
    await expect(
      t.services.shipments.clearDraft(t.actor.id, o.id, b, "اصلاح برنامهٔ ارسال", operation),
    ).rejects.toThrow();
    expect((await t.services.orders.get(t.actor.id, o.id)).status).toBe("processing");
    expect((await t.services.shipments.getById(t.actor.id, b.id)).state).toBe("draft");
    await t.client.execute("DROP TRIGGER fail_clear_aggregate");
    await t.services.shipments.clearDraft(t.actor.id, o.id, b, "اصلاح برنامهٔ ارسال", operation);
    expect((await t.services.orders.get(t.actor.id, o.id)).status).toBe("shipped");
  });
  it("supports an explicit whole-order bulk dispatch/delivery atomically", async () => {
    const o = await order();
    await parcel(o.id);
    await parcel(o.id);
    await ready(o.id);
    await t.services.orders.setStatus(t.actor.id, o.id, "shipped", key());
    const sent = await t.services.shipments.list(t.actor.id, o.id);
    expect(sent.every((row) => row.state === "dispatched" && row.version === 2)).toBe(true);
    expect(sent[0]?.dispatchedAt).toEqual(sent[1]?.dispatchedAt);
    await t.services.orders.setStatus(t.actor.id, o.id, "delivered", key());
    expect(
      (await t.services.shipments.list(t.actor.id, o.id)).every(
        (row) => row.state === "delivered" && row.version === 3,
      ),
    ).toBe(true);
  });
  it("blocks cancellation after any parcel was dispatched and preserves reserved inventory", async () => {
    const o = await order(),
      a = await parcel(o.id);
    await parcel(o.id);
    await ready(o.id);
    await send(a);
    await expect(
      t.services.orders.setStatus(t.actor.id, o.id, "cancelled", key()),
    ).rejects.toMatchObject({ code: "PARTIALLY_SHIPPED" });
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(199);
    const other = await order();
    await parcel(other.id);
    await parcel(other.id);
    await t.services.orders.setStatus(t.actor.id, other.id, "cancelled", key());
    await t.services.orders.setStatus(t.actor.id, other.id, "cancelled", key());
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(199);
  });
  it("requires processing, payment, correct revision, and dispatch before delivery", async () => {
    const o = await order(),
      a = await parcel(o.id);
    await expect(send(a)).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSING" });
    await ready(o.id, false);
    await expect(send(a)).rejects.toMatchObject({ code: "UNPAID" });
    await t.services.orders.setPayment(t.actor.id, o.id, "paid", key());
    await expect(deliver(a)).rejects.toMatchObject({ code: "INVALID_PARCEL_TRANSITION" });
    const sent = await send(a);
    await expect(deliver(a)).rejects.toMatchObject({ code: "SHIPMENT_CHANGED" });
    const done = await deliver(sent);
    await expect(send(done)).rejects.toMatchObject({ code: "INVALID_PARCEL_TRANSITION" });
  });
  it("restricts delivered-parcel corrections even when the order is still partially processing", async () => {
    const operator = await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "اپراتور", role: "operator", isActive: true },
      key(),
    );
    const o = await order(),
      a = await parcel(o.id);
    await parcel(o.id);
    await ready(o.id);
    const done = await deliver(await send(a));
    expect(done.orderStatus).toBe("processing");
    await expect(
      t.services.shipments.save(
        operator.id,
        o.id,
        { carrier: "pickup", note: "نباید ثبت شود" },
        done,
        "اصلاح پس از تحویل",
        key(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await t.services.shipments.save(
      t.actor.id,
      o.id,
      { carrier: "pickup", note: "اصلاح مدیر" },
      done,
      "اصلاح مستند",
      key(),
    );
    expect((await t.services.shipments.getById(t.actor.id, a.id)).state).toBe("delivered");
  });
  it("locks new parcels after whole-order shipment, but can complete one missing legacy record", async () => {
    const o = await order();
    await parcel(o.id);
    await ready(o.id);
    await t.services.orders.setStatus(t.actor.id, o.id, "shipped", key());
    await expect(parcel(o.id)).rejects.toMatchObject({ code: "SHIPMENT_PLAN_LOCKED" });
    const legacy = await order();
    await t.db
      .update(orders)
      .set({ status: "shipped", paymentStatus: "paid" })
      .where(eq(orders.id, legacy.id));
    const filled = await t.services.shipments.save(
      t.actor.id,
      legacy.id,
      { carrier: "pickup" },
      null,
      "تکمیل اطلاعات قدیمی",
      key(),
    );
    expect(await t.services.shipments.getById(t.actor.id, filled.id)).toMatchObject({
      state: "dispatched",
      dispatchedAt: null,
    });
    await expect(parcel(legacy.id)).rejects.toMatchObject({ code: "SHIPMENT_PLAN_LOCKED" });
    await deliver(filled);
    expect((await t.services.shipments.getById(t.actor.id, filled.id)).dispatchedAt).toBeNull();
  });
  it("returns one order per search/list result when several parcels match", async () => {
    const o = await order(),
      other = await order();
    await parcel(o.id, "00001001");
    await parcel(o.id, "00001002");
    await parcel(other.id, "00002001");
    const found = await t.services.orders.list(t.actor.id, 0, "all", "00001");
    expect(found.total).toBe(1);
    expect(found.items.map((row) => row.id)).toEqual([o.id]);
    expect((await t.services.orders.list(t.actor.id)).total).toBe(2);
  });
  it("rolls back final parcel and parent status together when parent audit fails", async () => {
    const o = await order(),
      a = await parcel(o.id),
      b = await parcel(o.id);
    await ready(o.id);
    await send(a);
    await t.client.execute(
      "CREATE TRIGGER fail_parent_status BEFORE INSERT ON audit_logs WHEN NEW.action='order.status' BEGIN SELECT RAISE(ABORT,'simulated parent audit failure'); END",
    );
    await expect(send(b)).rejects.toThrow();
    expect(await t.services.shipments.getById(t.actor.id, b.id)).toMatchObject({
      version: 1,
      state: "draft",
      dispatchedAt: null,
    });
    expect((await t.services.orders.get(t.actor.id, o.id)).status).toBe("processing");
    await t.client.execute("DROP TRIGGER fail_parent_status");
    expect((await send(b)).orderStatus).toBe("shipped");
  });
  it("is idempotent, checks live role and fences stale parcel transitions", async () => {
    const o = await order(),
      a = await parcel(o.id);
    await ready(o.id);
    const operation = key();
    const first = await t.services.shipments.transition(
      t.actor.id,
      a.id,
      "dispatched",
      a,
      operation,
    );
    expect(
      await t.services.shipments.transition(t.actor.id, a.id, "dispatched", a, operation),
    ).toEqual(first);
    await expect(
      t.services.shipments.transition(t.actor.id, a.id, "delivered", first, key(), {
        key: "expired",
        owner: "old",
      }),
    ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await t.db.update(users).set({ role: "viewer" }).where(eq(users.id, t.actor.id));
    await expect(
      t.services.shipments.transition(t.actor.id, a.id, "dispatched", a, operation),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("allocates and dispatches different parcels safely from two independent clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warehouse-parcel-concurrency-"));
    const a = await testDatabase(`file:${join(dir, "race.db")}`),
      b = await createDatabase({ url: `file:${join(dir, "race.db")}` });
    try {
      await a.client.execute("PRAGMA busy_timeout=25");
      await b.client.execute("PRAGMA busy_timeout=25");
      const sb = createServices(b.db, { bootstrapIds: [101], timeZone: "Asia/Tehran" });
      const p = await a.services.products.create(a.actor.id, testProduct, "concurrent:product");
      const o = await a.services.orders.create(
        a.actor.id,
        {
          customer,
          items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }],
        },
        "concurrent:order",
      );
      const rows = await Promise.all([
        a.services.shipments.save(
          a.actor.id,
          o.id,
          { carrier: "pickup" },
          null,
          "",
          "concurrent:parcel:a",
        ),
        sb.shipments.save(a.actor.id, o.id, { carrier: "pickup" }, null, "", "concurrent:parcel:b"),
      ]);
      expect(
        (await a.services.shipments.list(a.actor.id, o.id)).map((row) => row.parcelNumber),
      ).toEqual([1, 2]);
      await a.services.orders.setStatus(a.actor.id, o.id, "confirmed", "concurrent:confirm");
      await a.services.orders.setStatus(a.actor.id, o.id, "processing", "concurrent:process");
      await a.services.orders.setPayment(a.actor.id, o.id, "paid", "concurrent:paid");
      await Promise.all([
        a.services.shipments.transition(
          a.actor.id,
          rows[0]!.id,
          "dispatched",
          rows[0]!,
          "concurrent:send:a",
        ),
        sb.shipments.transition(
          a.actor.id,
          rows[1]!.id,
          "dispatched",
          rows[1]!,
          "concurrent:send:b",
        ),
      ]);
      expect((await a.services.orders.get(a.actor.id, o.id)).status).toBe("shipped");
    } finally {
      a.close();
      b.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
