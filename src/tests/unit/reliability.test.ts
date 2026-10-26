import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { acquireLease, releaseLease } from "@/bot/middleware/reliability";
import { createDatabase } from "@/db/client";
import { createServices } from "@/db/queries";
import { chatLocks, orders, orderReferences, products, users } from "@/db/schema";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";

let t: TestDatabase;
beforeEach(async () => {
  t = await testDatabase();
});
afterEach(() => t.close());
describe("distributed reliability primitives", () => {
  it("rejects concurrent lease owners and fences expired owners", async () => {
    const first = await acquireLease(t.db, "user:101:chat:101");
    await expect(acquireLease(t.db, first.key)).rejects.toMatchObject({ code: "CHAT_BUSY" });
    await t.db
      .update(chatLocks)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(chatLocks.key, first.key));
    const second = await acquireLease(t.db, first.key);
    expect(second.owner).not.toBe(first.owner);
    await expect(
      t.services.products.create(t.actor.id, testProduct, "test:stale", first),
    ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await releaseLease(t.db, first);
    expect(await t.db.select().from(chatLocks)).toHaveLength(1);
    await t.services.products.create(t.actor.id, testProduct, "test:fresh", second);
    await releaseLease(t.db, second);
    expect(await t.db.select().from(products)).toHaveLength(1);
    expect(await t.db.select().from(chatLocks)).toHaveLength(0);
  });
  it("rolls back order, stock, customer and items when inventory logging fails", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    await t.client.execute(
      "CREATE TRIGGER fail_out BEFORE INSERT ON inventory_logs WHEN NEW.change_type = 'out' BEGIN SELECT RAISE(ABORT, 'simulated inventory failure'); END",
    );
    await expect(
      t.services.orders.create(
        t.actor.id,
        {
          customer,
          items: [{ productId: p.id, quantity: 2, expectedUnitPrice: testProduct.price }],
        },
        "test:order",
      ),
    ).rejects.toThrow();
    expect(await t.db.select().from(orders)).toHaveLength(0);
    expect(await t.db.select().from(orderReferences)).toHaveLength(0);
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(10);
    expect(
      await t.db.select().from(users).where(eq(users.telegramId, customer.telegramId)),
    ).toHaveLength(0);
  });
  it("prevents overselling from two independent database clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warehouse-concurrency-"));
    const a = await testDatabase(`file:${join(dir, "concurrency.db")}`);
    const b = await createDatabase({ url: `file:${join(dir, "concurrency.db")}` });
    try {
      // Short busy waits keep this single JS test process responsive to both clients.
      await a.client.execute("PRAGMA busy_timeout=25");
      await b.client.execute("PRAGMA busy_timeout=25");
      const serviceB = createServices(b.db, { bootstrapIds: [101], timeZone: "Asia/Tehran" });
      const p = await a.services.products.create(
        a.actor.id,
        { ...testProduct, stockQuantity: 5 },
        "test:p",
      );
      const input = {
        customer,
        items: [{ productId: p.id, quantity: 4, expectedUnitPrice: testProduct.price }],
      };
      const results = await Promise.allSettled([
        a.services.orders.create(a.actor.id, input, "test:a"),
        serviceB.orders.create(a.actor.id, input, "test:b"),
      ]);
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(results.find((x) => x.status === "rejected")).toMatchObject({
        reason: { code: "INSUFFICIENT_STOCK" },
      });
      expect((await a.services.products.get(a.actor.id, p.id)).stockQuantity).toBe(1);
      expect(await a.db.select().from(orders)).toHaveLength(1);
    } finally {
      a.close();
      b.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
