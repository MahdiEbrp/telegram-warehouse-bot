import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { productionConfiguration, databaseReadiness } from "@/lib/preflight";
import { createDatabase } from "@/db/client";
import { orderReferences, shipmentSequences } from "@/db/schema";
import { customer, testDatabase, testProduct } from "../helpers/database";
const env = {
  BOT_TOKEN: "123456789:valid_format_token_for_unit_tests_only",
  TELEGRAM_WEBHOOK_SECRET: "valid_format_secret_for_unit_tests_only_123",
  SUPER_ADMIN_TELEGRAM_IDS: "101",
  TURSO_DATABASE_URL: "libsql://unit-database.turso.io",
  TURSO_AUTH_TOKEN: "unit-test-token",
  APP_URL: "https://warehouse-unit.vercel.app",
  CONVERSATION_VERSION: "3",
};
describe("read-only deployment preflight", () => {
  it("requires remote production storage and a real origin, not a placeholder or route", () => {
    expect(productionConfiguration(env).CONVERSATION_VERSION).toBe("3");
    for (const overrides of [
      { TURSO_DATABASE_URL: "file:./data/local.db" },
      { TURSO_AUTH_TOKEN: "" },
      { APP_URL: undefined },
      { APP_URL: "https://warehouse-unit.vercel.app/api/telegram/webhook" },
      { APP_URL: "https://your-app.vercel.app" },
      { APP_URL: "https://localhost/" },
    ])
      expect(() => productionConfiguration({ ...env, ...overrides })).toThrow();
  });
  it("refuses an unmigrated database without attempting to create the schema", async () => {
    const c = await createDatabase({ url: "file::memory:" });
    try {
      await expect(databaseReadiness(c.db)).rejects.toMatchObject({ code: "MIGRATION_REQUIRED" });
      expect(
        (await c.client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows,
      ).toEqual([]);
    } finally {
      c.close();
    }
  });
  it("checks fresh/migrated schema and counters without creating or changing any business data", async () => {
    const t = await testDatabase();
    try {
      expect(await databaseReadiness(t.db)).toEqual({ orders: 0, shipments: 0 });
      const p = await t.services.products.create(t.actor.id, testProduct, "preflight:p");
      const o = await t.services.orders.create(
        t.actor.id,
        {
          customer,
          items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }],
        },
        "preflight:o",
      );
      await t.services.shipments.save(
        t.actor.id,
        o.id,
        { carrier: "pickup" },
        null,
        "",
        "preflight:parcel",
      );
      expect(await databaseReadiness(t.db)).toEqual({ orders: 1, shipments: 1 });
      await t.db.delete(shipmentSequences).where(eq(shipmentSequences.orderId, o.id));
      await expect(databaseReadiness(t.db)).rejects.toMatchObject({ code: "BAD_PARCEL_COUNTER" });
      await t.db.delete(orderReferences).where(eq(orderReferences.orderId, o.id));
      await expect(databaseReadiness(t.db)).rejects.toMatchObject({ code: "MISSING_REFERENCES" });
    } finally {
      t.close();
    }
  });
});
