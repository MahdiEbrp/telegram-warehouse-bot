import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDatabase } from "@/db/client";
import { createServices } from "@/db/queries";
import {
  auditLogs,
  botConversations,
  chatLocks,
  inventoryLogs,
  mutationKeys,
  orderItems,
  orderReferences,
  orders,
  processedUpdates,
  products,
  shipments,
} from "@/db/schema";
import { customer, testDatabase, testProduct } from "../helpers/database";

describe("real additive tracking migrations", () => {
  it("migrates a fresh database, and re-running leaves references intact", async () => {
    const t = await testDatabase();
    try {
      const tables = await t.client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'",
      );
      expect(tables.rows).toHaveLength(15);
      const product = await t.services.products.create(t.actor.id, testProduct, "upgrade:product");
      const order = await t.services.orders.create(
        t.actor.id,
        {
          customer,
          items: [{ productId: product.id, quantity: 1, expectedUnitPrice: testProduct.price }],
        },
        "upgrade:order",
      );
      await migrate(t.db, { migrationsFolder: resolve("drizzle") });
      expect((await t.services.orders.get(t.actor.id, order.id)).referenceCode).toBe(
        order.referenceCode,
      );
      expect((await t.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally {
      t.close();
    }
  });
  it("upgrades actual v1 tables with data/backfill, preserves all old rows and repeat migrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warehouse-v1-upgrade-"));
    const connection = await createDatabase({ url: `file:${join(dir, "legacy.db")}` });
    const { db, client } = connection;
    try {
      const folder = join(dir, "drizzle-v1");
      await mkdir(join(folder, "meta"), { recursive: true });
      const journal: {
        entries: { idx: number; tag: string; when: number; breakpoints: boolean }[];
      } = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
      await writeFile(
        join(folder, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx === 0) }),
      );
      await copyFile("drizzle/0000_initial.sql", join(folder, "0000_initial.sql"));
      await migrate(db, { migrationsFolder: folder });
      const services = createServices(db, { bootstrapIds: [101], timeZone: "Asia/Tehran" });
      const actor = await services.users.authenticate({
        id: 101,
        first_name: "مدیر قدیمی",
        is_bot: false,
      });
      await services.users.authenticate({ id: 202, first_name: "مشتری قدیمی", is_bot: false });
      const product = await services.products.create(actor.id, testProduct, "legacy:product");
      const a = randomUUID(),
        b = randomUUID();
      const createdAt = new Date("2025-07-01T10:00:00Z");
      const common = {
        customerTelegramId: 202,
        customerName: "قدیمی",
        customerPhone: customer.phone,
        shippingAddress: customer.address,
        totalAmount: testProduct.price,
        createdAt,
        updatedAt: createdAt,
      };
      await db.insert(orders).values([
        {
          ...common,
          id: a,
          orderNumber: "ORD-LEGACY-SHIPPED",
          status: "shipped",
          paymentStatus: "paid",
          notes: "نباید عوض شود",
        },
        {
          ...common,
          id: b,
          orderNumber: "ORD-LEGACY-CANCELLED",
          status: "cancelled",
          paymentStatus: "refunded",
        },
      ]);
      for (const id of [a, b])
        await db.insert(orderItems).values({
          orderId: id,
          productId: product.id,
          quantity: 1,
          unitPrice: testProduct.price,
          totalPrice: testProduct.price,
        });
      await db.update(products).set({ stockQuantity: 9 }).where(eq(products.id, product.id));
      await db.insert(inventoryLogs).values([
        {
          productId: product.id,
          referenceId: a,
          userId: actor.id,
          changeType: "out",
          quantityChange: -1,
          previousStock: 10,
          newStock: 9,
        },
        {
          productId: product.id,
          referenceId: b,
          userId: actor.id,
          changeType: "out",
          quantityChange: -1,
          previousStock: 9,
          newStock: 8,
        },
        {
          productId: product.id,
          referenceId: b,
          userId: actor.id,
          changeType: "in",
          quantityChange: 1,
          previousStock: 8,
          newStock: 9,
        },
      ]);
      await db.insert(auditLogs).values({
        userId: actor.id,
        action: "order.create",
        entityType: "order",
        entityId: a,
        details: { original: true },
      });
      await db.insert(mutationKeys).values({
        key: "legacy:order",
        userId: actor.id,
        result: { id: a, orderNumber: "ORD-LEGACY-SHIPPED", totalAmount: testProduct.price },
      });
      await db.insert(botConversations).values({
        key: "legacy:conversation",
        value: { legacy: true },
        expiresAt: Date.now() + 100000,
      });
      await db.insert(processedUpdates).values({ updateId: 777, processedAt: Date.now() });
      await db
        .insert(chatLocks)
        .values({ key: "legacy:lease", owner: "old-owner", expiresAt: Date.now() + 100000 });
      // A valid old rowid can exceed 12 hex digits: backfill must not use/truncate it.
      await client.execute({
        sql: "UPDATE orders SET rowid=9223372036854775807 WHERE id=?",
        args: [a],
      });
      const tableRows = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
      );
      expect(tableRows.rows).toHaveLength(12);
      const names = tableRows.rows.map((row) => String(row.name));
      const snapshot = async () =>
        Promise.all(
          names.map((name) =>
            client.execute(`SELECT * FROM "${name}" ORDER BY rowid`).then((result) => result.rows),
          ),
        );
      const before = await snapshot();
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      expect(await snapshot()).toEqual(before);
      const references = await db.select().from(orderReferences).orderBy(orderReferences.orderId);
      expect(references).toHaveLength(2);
      expect(new Set(references.map((row) => row.code)).size).toBe(2);
      for (const reference of references) {
        expect(reference.code).toMatch(/^REF-[0-9A-F]{12}$/);
        expect(reference.createdAt).toEqual(createdAt);
      }
      expect(await db.select().from(shipments)).toHaveLength(0);
      const legacy = await services.orders.get(actor.id, a);
      expect(legacy.orderNumber).toBe("ORD-LEGACY-SHIPPED");
      expect(legacy.items).toHaveLength(1);
      await services.shipments.save(
        actor.id,
        a,
        { carrier: "courier" },
        null,
        "تکمیل بایگانی قدیمی",
        "upgrade:shipping",
      );
      const afterWrite = await snapshot();
      const shipment = await services.shipments.get(actor.id, a);
      expect(shipment).toMatchObject({ dispatchedAt: null, deliveredAt: null });
      await migrate(db, { migrationsFolder: resolve("drizzle") });
      expect(await snapshot()).toEqual(afterWrite);
      expect(await db.select().from(orderReferences).orderBy(orderReferences.orderId)).toEqual(
        references,
      );
      expect(await services.shipments.get(actor.id, a)).toEqual(shipment);
      const fresh = await services.orders.create(
        actor.id,
        {
          customer,
          items: [{ productId: product.id, quantity: 1, expectedUnitPrice: testProduct.price }],
        },
        "upgrade:fresh-order",
      );
      expect(fresh.referenceCode).toMatch(/^REF-[2-9A-HJ-NP-Z]{12}$/);
      expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
      expect((await services.products.get(actor.id, product.id)).stockQuantity).toBe(8);
    } finally {
      connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps FK/unique/check constraints effective after migration", async () => {
    const t = await testDatabase();
    try {
      const p = await t.services.products.create(t.actor.id, testProduct, "constraint:product");
      const order = await t.services.orders.create(
        t.actor.id,
        {
          customer,
          items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }],
        },
        "constraint:order",
      );
      const base = {
        orderId: order.id,
        carrier: "pickup" as const,
        createdBy: t.actor.id,
        updatedBy: t.actor.id,
      };
      const invalid: Partial<typeof shipments.$inferInsert>[] = [
        { shippingCost: -1 },
        { version: 0 },
        { trackingNumber: "x" },
        { postalCode: "0123" },
        { carrier: "iran_post", trackingNumber: null },
        { carrier: "other", trackingNumber: "00001234" },
        { carrierName: "unexpected" },
        { dispatchedAt: new Date(2000), deliveredAt: new Date(1000) },
        { orderId: randomUUID() },
        { createdBy: randomUUID() },
      ];
      for (const value of invalid)
        await expect(t.db.insert(shipments).values({ ...base, ...value })).rejects.toThrow();
      expect(await t.db.select().from(shipments)).toHaveLength(0);
      await expect(
        t.db
          .update(orderReferences)
          .set({ code: "REF-invalid" })
          .where(eq(orderReferences.orderId, order.id)),
      ).rejects.toThrow();
      await t.db.insert(shipments).values(base);
      await expect(t.db.insert(shipments).values(base)).rejects.toThrow();
      await expect(t.db.delete(orders).where(eq(orders.id, order.id))).rejects.toThrow();
      expect((await t.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally {
      t.close();
    }
  });
});
