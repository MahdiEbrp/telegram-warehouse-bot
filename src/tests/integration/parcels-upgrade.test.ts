import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDatabase } from "@/db/client";
import { createServices } from "@/db/queries";
import { auditLogs, orderReferences, orders, shipmentSequences } from "@/db/schema";
import { customer } from "../helpers/database";

it("upgrades populated v1.1 parcels in place without changing IDs, old columns, dates, actors or audit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warehouse-parcels-upgrade-"));
  const c = await createDatabase({ url: `file:${join(dir, "v11.db")}` });
  try {
    const folder = join(dir, "drizzle-v11");
    await mkdir(join(folder, "meta"), { recursive: true });
    const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
      await readFile("drizzle/meta/_journal.json", "utf8"),
    );
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < 2) }),
    );
    for (const name of ["0000_initial.sql", "0001_tracking.sql"])
      await copyFile(`drizzle/${name}`, join(folder, name));
    await migrate(c.db, { migrationsFolder: folder });
    const services = createServices(c.db, { bootstrapIds: [101], timeZone: "Asia/Tehran" });
    const actor = await services.users.authenticate({ id: 101, is_bot: false, first_name: "مدیر" });
    await services.users.authenticate({ id: 202, is_bot: false, first_name: "مشتری" });
    const created = new Date("2025-01-10T10:00:00Z"),
      sent = new Date("2025-01-11T10:00:00Z"),
      delivered = new Date("2025-01-12T10:00:00Z");
    const states = [
      "processing",
      "shipped",
      "shipped",
      "delivered",
      "delivered",
      "cancelled",
    ] as const;
    const fixture: { orderId: string; id: string }[] = [];
    for (let i = 0; i < states.length; i++) {
      const orderId = randomUUID(),
        id = randomUUID();
      fixture.push({ orderId, id });
      await c.db.insert(orders).values({
        id: orderId,
        orderNumber: `ORD-V11-${i}`,
        customerTelegramId: 202,
        customerName: customer.name,
        customerPhone: customer.phone,
        shippingAddress: customer.address,
        totalAmount: 100000,
        status: states[i]!,
        paymentStatus: states[i] === "cancelled" ? "refunded" : "paid",
        createdAt: created,
        updatedAt: created,
      });
      await c.db
        .insert(orderReferences)
        .values({ orderId, code: `REF-${String(i + 1).padStart(12, "0")}`, createdAt: created });
      // Insert only v1.1 columns; current Drizzle defaults must not mask missing v2 columns.
      await c.client.execute({
        sql: "INSERT INTO shipments (id,order_id,carrier,carrier_name,tracking_number,tracking_url,postal_code,shipping_cost,note,version,dispatched_at,delivered_at,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [
          id,
          orderId,
          "iran_post",
          "",
          `00Ab000${i}`,
          "https://carrier.example/track",
          "0123456789",
          25000,
          `یادداشت ${i}`,
          42,
          i === 2 || i === 4 ? sent.getTime() : null,
          i === 4 ? delivered.getTime() : null,
          actor.id,
          actor.id,
          created.getTime(),
          created.getTime(),
        ],
      });
      await c.db.insert(auditLogs).values({
        userId: actor.id,
        action: "shipment.create",
        entityType: "shipment",
        entityId: orderId,
        details: { legacyShipmentId: id, untouched: true },
        createdAt: created,
      });
    }
    const tables = (
      await c.client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
      )
    ).rows.map((row) => String(row.name));
    expect(tables).toHaveLength(14);
    const columns = (await c.client.execute("PRAGMA table_info(shipments)")).rows
      .map((row) => `"${String(row.name)}"`)
      .join(",");
    const snapshot = () =>
      Promise.all(
        tables.map((name) =>
          c.client
            .execute(`SELECT ${name === "shipments" ? columns : "*"} FROM "${name}" ORDER BY rowid`)
            .then((result) => result.rows),
        ),
      );
    const before = await snapshot();
    await migrate(c.db, { migrationsFolder: resolve("drizzle") });
    expect(await snapshot()).toEqual(before);
    const expected = ["draft", "dispatched", "dispatched", "delivered", "delivered", "draft"];
    for (let i = 0; i < fixture.length; i++) {
      const row = await services.shipments.getById(actor.id, fixture[i]!.id);
      expect(row).toMatchObject({
        id: fixture[i]!.id,
        parcelNumber: 1,
        state: expected[i],
        version: 42,
        shippingCost: 25000,
      });
      if (i === 1 || i === 3) {
        expect(row.dispatchedAt).toBeNull();
        expect(row.deliveredAt).toBeNull();
      }
    }
    expect((await c.db.select().from(shipmentSequences)).every((row) => row.lastNumber === 1)).toBe(
      true,
    );
    const old = fixture[0]!;
    await services.shipments.clearDraft(
      actor.id,
      old.orderId,
      { id: old.id, version: 42 },
      "تغییر برنامهٔ ارسال",
      "migration:clear",
    );
    const fresh = await services.shipments.save(
      actor.id,
      old.orderId,
      { carrier: "pickup" },
      null,
      "",
      "migration:new-parcel",
    );
    expect((await services.shipments.getById(actor.id, fresh.id)).parcelNumber).toBe(2);
    const after = await snapshot();
    await migrate(c.db, { migrationsFolder: resolve("drizzle") });
    expect(await snapshot()).toEqual(after);
    expect((await services.shipments.getById(actor.id, fresh.id)).parcelNumber).toBe(2);
    expect((await c.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    expect(Number((await c.client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys)).toBe(1);
  } finally {
    c.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("migration SQL review guards", () => {
  it("does not rebuild/drop existing tables or disable foreign keys", async () => {
    const sql = await readFile("drizzle/0002_parcels.sql", "utf8");
    expect(sql).not.toMatch(/DROP TABLE|RENAME TO|PRAGMA foreign_keys/i);
    expect(sql).toContain("DROP INDEX `shipments_order_id_unique`");
  });
});
