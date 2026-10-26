import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, categories, inventoryLogs, mutationKeys, products, users } from "@/db/schema";
import { testDatabase, testProduct, type TestDatabase } from "../helpers/database";

let t: TestDatabase;
beforeEach(async () => {
  t = await testDatabase();
});
afterEach(() => {
  t.close();
});
describe("products, inventory and RBAC against real SQLite :memory:", () => {
  it("writes product, initial inventory and audit in one operation", async () => {
    const created = await t.services.products.create(t.actor.id, testProduct, "test:create");
    const [product] = await t.db.select().from(products);
    const [log] = await t.db.select().from(inventoryLogs);
    const [audit] = await t.db.select().from(auditLogs);
    expect(product).toMatchObject({ id: created.id, stockQuantity: 10, price: 100000 });
    expect(log).toMatchObject({ previousStock: 0, newStock: 10, quantityChange: 10 });
    expect(audit?.action).toBe("product.create");
  });
  it("is idempotent and translates duplicate SKU errors", async () => {
    const first = await t.services.products.create(t.actor.id, testProduct, "test:create");
    expect(await t.services.products.create(t.actor.id, testProduct, "test:create")).toEqual(first);
    await expect(
      t.services.products.create(t.actor.id, testProduct, "test:duplicate"),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    expect(await t.db.select().from(products)).toHaveLength(1);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(1);
    expect(await t.db.select().from(mutationKeys)).toHaveLength(1);
  });
  it("updates only requested fields", async () => {
    const category = await t.services.products.createCategory(
      t.actor.id,
      "دسته اصلی",
      null,
      "test:cat",
    );
    const p = await t.services.products.create(
      t.actor.id,
      { ...testProduct, costPrice: 23000, minStockLevel: 7, categoryId: category.id },
      "test:p",
    );
    await t.services.products.update(t.actor.id, p.id, { name: "نام ویرایش‌شده" }, "test:patch");
    expect(await t.services.products.get(t.actor.id, p.id)).toMatchObject({
      name: "نام ویرایش‌شده",
      costPrice: 23000,
      minStockLevel: 7,
      categoryId: category.id,
      stockQuantity: 10,
    });
  });
  it("adjusts inventory with compare-and-set protection", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    await t.services.products.adjustStock(t.actor.id, p.id, 10, 4, "test:adjust");
    await expect(
      t.services.products.adjustStock(t.actor.id, p.id, 10, 3, "test:stale"),
    ).rejects.toMatchObject({ code: "STOCK_CHANGED" });
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(4);
    expect(
      (await t.db.select().from(inventoryLogs)).find((x) => x.changeType === "adjustment"),
    ).toMatchObject({ previousStock: 10, newStock: 4, quantityChange: -6 });
  });
  it("soft-deletes without erasing history", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    await t.services.products.archive(t.actor.id, p.id, "test:archive");
    expect((await t.services.products.list(t.actor.id)).total).toBe(0);
    expect((await t.services.products.get(t.actor.id, p.id)).isActive).toBe(false);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(1);
  });
  it("searches Persian names and escaped SQL wildcard characters", async () => {
    await t.services.products.create(
      t.actor.id,
      { ...testProduct, name: "کالای ۱۰۰٪ ویژه_من" },
      "test:p",
    );
    expect((await t.services.products.list(t.actor.id, 0, "ویژه_")).total).toBe(1);
    expect((await t.services.products.list(t.actor.id, 0, "SKU-001")).total).toBe(1);
    expect((await t.services.products.list(t.actor.id, 0, "not-found")).total).toBe(0);
  });
  it("enforces FK and stock constraints at database level", async () => {
    const cat = await t.services.products.createCategory(t.actor.id, "دسته اصلی", null, "test:cat");
    const p = await t.services.products.create(
      t.actor.id,
      { ...testProduct, categoryId: cat.id },
      "test:p",
    );
    await expect(t.db.delete(categories).where(eq(categories.id, cat.id))).rejects.toThrow();
    await expect(
      t.db.update(products).set({ stockQuantity: -1 }).where(eq(products.id, p.id)),
    ).rejects.toThrow();
  });
  it("does not grant access to unknown users or re-promote revoked bootstrap admins", async () => {
    const stranger = await t.services.users.authenticate({
      id: 999,
      first_name: "ناشناس",
      is_bot: false,
    });
    expect(stranger).toMatchObject({ role: "viewer", isActive: false });
    await expect(t.services.products.list(stranger.id)).rejects.toMatchObject({ code: "INACTIVE" });
    await t.db
      .update(users)
      .set({ role: "viewer", isActive: false })
      .where(eq(users.id, t.actor.id));
    expect(
      await t.services.users.authenticate({ id: 101, first_name: "مدیر", is_bot: false }),
    ).toMatchObject({ role: "viewer", isActive: false });
  });
  it("rechecks roles at the service boundary", async () => {
    const viewer = await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "مشاهده‌گر", role: "viewer", isActive: true },
      "test:viewer",
    );
    await expect(
      t.services.products.create(viewer.id, testProduct, "test:forged"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(t.services.users.list(viewer.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await t.services.products.list(viewer.id)).total).toBe(0);
  });
  it("protects the last active super admin", async () => {
    await expect(
      t.services.users.save(
        t.actor.id,
        { telegramId: 101, firstName: "مدیر", role: "admin", isActive: true },
        "test:demote",
      ),
    ).rejects.toMatchObject({ code: "LAST_SUPER_ADMIN" });
    await t.services.users.save(
      t.actor.id,
      { telegramId: 404, firstName: "مدیر دوم", role: "super_admin", isActive: true },
      "test:second",
    );
    await t.services.users.save(
      t.actor.id,
      { telegramId: 101, firstName: "مدیر", role: "admin", isActive: true },
      "test:demote2",
    );
    expect((await t.db.select().from(users).where(eq(users.telegramId, 101)))[0]?.role).toBe(
      "admin",
    );
  });
});
