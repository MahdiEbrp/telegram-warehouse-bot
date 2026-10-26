import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inventoryLogs,
  mutationKeys,
  orderItems,
  orderReferences,
  orders,
  users,
} from "@/db/schema";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
let t: TestDatabase;
beforeEach(async () => {
  t = await testDatabase();
});
afterEach(() => t.close());
describe("adversarial local contention (not distributed cloud capacity)", () => {
  it("atomically serves only 25 of 50 competing buyers and rolls back every losing order", async () => {
    const actors: string[] = [];
    for (let i = 0; i < 50; i++)
      actors.push(
        (
          await t.services.users.save(
            t.actor.id,
            { telegramId: 10000 + i, firstName: `مدیر ${i}`, role: "admin", isActive: true },
            `contention:user:${i}`,
          )
        ).id,
      );
    const p = await t.services.products.create(
      t.actor.id,
      { ...testProduct, stockQuantity: 25 },
      "contention:product",
    );
    const keyCount = (await t.db.select().from(mutationKeys)).length;
    const results = await Promise.allSettled(
      actors.map((id, i) =>
        t.services.orders.create(
          id,
          {
            customer: { ...customer, telegramId: 20000 + i },
            items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }],
          },
          `contention:order:${i}`,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(25);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(25);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(0);
    expect(await t.db.select().from(orders)).toHaveLength(25);
    expect(await t.db.select().from(orderItems)).toHaveLength(25);
    expect(await t.db.select().from(orderReferences)).toHaveLength(25);
    expect((await t.db.select().from(users)).filter((u) => u.telegramId >= 20000)).toHaveLength(25);
    expect((await t.db.select().from(mutationKeys)).length - keyCount).toBe(25);
    const ledger = await t.db.select().from(inventoryLogs);
    expect(ledger).toHaveLength(26);
    expect(ledger.reduce((sum, row) => sum + row.quantityChange, 0)).toBe(0);
    expect(
      new Set(ledger.filter((row) => row.changeType === "out").map((row) => row.previousStock))
        .size,
    ).toBe(25);
  });
  it("allows only one of 50 optimistic stock updates against the same expected version", async () => {
    const p = await t.services.products.create(
      t.actor.id,
      { ...testProduct, stockQuantity: 0 },
      "contention:zero",
    );
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        t.services.products.adjustStock(t.actor.id, p.id, 0, 1, `contention:stock:${i}`),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "STOCK_CHANGED" });
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(1);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(1);
    expect(await t.db.select().from(mutationKeys)).toHaveLength(2);
  });
});
