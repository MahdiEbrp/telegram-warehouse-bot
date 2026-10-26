import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inventoryLogs, orderItems, orders } from "@/db/schema";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
let t: TestDatabase;
let productId: string;
const line = (quantity: number) => ({ productId, quantity, expectedUnitPrice: 100000 });
beforeEach(async () => {
  t = await testDatabase();
  productId = (
    await t.services.products.create(t.actor.id, { ...testProduct, stockQuantity: 5 }, "test:p")
  ).id;
});
afterEach(() => t.close());
describe("transactional order lifecycle", () => {
  it("reserves stock, stores price snapshots and generates unique numbers", async () => {
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(2)] },
      "test:order",
    );
    expect(order.totalAmount).toBe(200000);
    expect(order.orderNumber).toMatch(/^ORD-/);
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(3);
    expect((await t.db.select().from(orderItems))[0]).toMatchObject({
      quantity: 2,
      unitPrice: 100000,
      totalPrice: 200000,
    });
    await t.services.products.update(t.actor.id, productId, { price: 250000 }, "test:price");
    expect((await t.services.orders.get(t.actor.id, order.id)).items[0]?.unitPrice).toBe(100000);
  });
  it("cannot sell the same stock twice and rolls back failed operations", async () => {
    await t.services.orders.create(t.actor.id, { customer, items: [line(5)] }, "test:first");
    await expect(
      t.services.orders.create(t.actor.id, { customer, items: [line(1)] }, "test:second"),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await t.db.select().from(orders)).toHaveLength(1);
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(0);
  });
  it("returns the original order on retries without re-reserving", async () => {
    const input = { customer, items: [line(2)] };
    const first = await t.services.orders.create(t.actor.id, input, "test:order");
    expect(await t.services.orders.create(t.actor.id, input, "test:order")).toEqual(first);
    expect(await t.db.select().from(orders)).toHaveLength(1);
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(3);
  });
  it("coalesces duplicate product lines", async () => {
    await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(1), line(2)] },
      "test:order",
    );
    expect(await t.db.select().from(orderItems)).toHaveLength(1);
    expect((await t.db.select().from(orderItems))[0]?.quantity).toBe(3);
  });
  it("refuses price changes after preview", async () => {
    await t.services.products.update(t.actor.id, productId, { price: 200000 }, "test:price");
    await expect(
      t.services.orders.create(t.actor.id, { customer, items: [line(1)] }, "test:order"),
    ).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect(await t.db.select().from(orders)).toHaveLength(0);
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(5);
  });
  it("restores cancelled inventory exactly once, even with a new mutation key", async () => {
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(2)] },
      "test:order",
    );
    await t.services.orders.setStatus(t.actor.id, order.id, "cancelled", "test:cancel");
    await t.services.orders.setStatus(t.actor.id, order.id, "cancelled", "test:cancel-again");
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(5);
    expect(
      (
        await t.db.select().from(inventoryLogs).where(eq(inventoryLogs.referenceId, order.id))
      ).filter((x) => x.changeType === "in"),
    ).toHaveLength(1);
    await expect(
      t.services.orders.setStatus(t.actor.id, order.id, "confirmed", "test:reopen"),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
  it("handles manual payment, cancellation and refund separately", async () => {
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(1)] },
      "test:order",
    );
    await t.services.orders.setPayment(t.actor.id, order.id, "paid", "test:paid");
    await expect(
      t.services.orders.setPayment(t.actor.id, order.id, "refunded", "test:invalid-refund"),
    ).rejects.toMatchObject({ code: "INVALID_REFUND" });
    await t.services.orders.setStatus(t.actor.id, order.id, "cancelled", "test:cancel");
    expect((await t.services.orders.get(t.actor.id, order.id)).paymentStatus).toBe("paid");
    await t.services.orders.setPayment(t.actor.id, order.id, "refunded", "test:refund");
    expect((await t.services.orders.get(t.actor.id, order.id)).paymentStatus).toBe("refunded");
  });
  it("requires valid transitions and paid status before shipping", async () => {
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(1)] },
      "test:order",
    );
    await expect(
      t.services.orders.setStatus(t.actor.id, order.id, "delivered", "test:jump"),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await t.services.orders.setStatus(t.actor.id, order.id, "confirmed", "test:confirm");
    await t.services.orders.setStatus(t.actor.id, order.id, "processing", "test:process");
    await expect(
      t.services.orders.setStatus(t.actor.id, order.id, "shipped", "test:ship-unpaid"),
    ).rejects.toMatchObject({ code: "UNPAID" });
    await t.services.orders.setPayment(t.actor.id, order.id, "paid", "test:paid");
    await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "courier" },
      null,
      "",
      "test:shipping",
    );
    await t.services.orders.setStatus(t.actor.id, order.id, "shipped", "test:ship");
    await t.services.orders.setStatus(t.actor.id, order.id, "delivered", "test:deliver");
    expect((await t.services.orders.get(t.actor.id, order.id)).status).toBe("delivered");
  });
  it("lets operators update status but not payment or create orders", async () => {
    const operator = await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "اپراتور", role: "operator", isActive: true },
      "test:operator",
    );
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(1)] },
      "test:order",
    );
    await t.services.orders.setStatus(operator.id, order.id, "confirmed", "test:status");
    await expect(
      t.services.orders.setPayment(operator.id, order.id, "paid", "test:payment"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      t.services.orders.create(operator.id, { customer, items: [line(1)] }, "test:create"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reports paid, non-cancelled orders by creation period", async () => {
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [line(2)] },
      "test:order",
    );
    await t.services.orders.setPayment(t.actor.id, order.id, "paid", "test:paid");
    expect((await t.services.reports.sales(t.actor.id, "day")).total).toBe(200000);
    await t.services.orders.setStatus(t.actor.id, order.id, "cancelled", "test:cancel");
    expect((await t.services.reports.sales(t.actor.id, "day")).total).toBe(0);
    expect((await t.services.reports.movements(t.actor.id)).total).toBe(3);
    expect((await t.services.reports.lowStock(t.actor.id)).total).toBe(1);
  });
});
