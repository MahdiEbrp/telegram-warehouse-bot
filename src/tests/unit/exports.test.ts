import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { shipmentWorkbook, xmlText } from "@/lib/xlsx";
import { orders, auditLogs, users } from "@/db/schema";
import { MAX_EXPORT_ROWS } from "@/types/domain";
import { periodBounds } from "@/lib/time";
import { shipmentInput } from "@/lib/shipping";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
let t: TestDatabase, orderId: string;
const options = { filter: "all", state: "all", period: "all" } as const;
beforeEach(async () => {
  t = await testDatabase();
  const p = await t.services.products.create(t.actor.id, testProduct, "export:product");
  orderId = (
    await t.services.orders.create(
      t.actor.id,
      {
        customer: { ...customer, name: '=HYPERLINK("https://evil.invalid","text")' },
        items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }],
      },
      "export:order",
    )
  ).id;
  await t.services.shipments.save(
    t.actor.id,
    orderId,
    {
      carrier: "iran_post",
      trackingNumber: "00Ab0091",
      postalCode: "0123456789",
      shippingCost: 12345,
      note: "<tag>&data",
    },
    null,
    "",
    "export:parcel",
  );
});
afterEach(() => t.close());
describe("bounded and confidential native XLSX exports", () => {
  it("writes valid OOXML parts, RTL/freeze/filter and literal strings instead of formulas", async () => {
    const data = await t.services.exports.shipments(t.actor.id, options);
    const file = shipmentWorkbook(data),
      zip = unzipSync(file);
    expect(Object.keys(zip)).toHaveLength(7);
    const sheet = strFromU8(zip["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain("<autoFilter");
    for (const code of ["00Ab0091", "0123456789", customer.phone])
      expect(sheet).toContain(`<t xml:space="preserve">${code}</t>`);
    expect(sheet).toContain("=HYPERLINK(&quot;");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("&lt;tag&gt;&amp;data");
    expect(sheet).not.toContain("\u0000");
    expect(strFromU8(zip["xl/_rels/workbook.xml.rels"]!)).not.toContain("External");
    expect(strFromU8(zip["xl/workbook.xml"]!)).toContain("راهنما");
    expect(sheet).not.toContain("مبلغ کل سفارش");
  });
  it("rejects embedded controls before libSQL can truncate shipment text", () => {
    expect(shipmentInput.safeParse({ carrier: "courier", note: "before\u0000after" }).success).toBe(
      false,
    );
    expect(
      shipmentInput.safeParse({
        carrier: "other",
        carrierName: "before\u0001after",
        trackingNumber: "1234",
      }).success,
    ).toBe(false);
    expect(shipmentInput.safeParse({ carrier: "courier", note: "سطر اول\nسطر دوم" }).success).toBe(
      true,
    );
  });
  it("sanitizes XML controls and lone surrogates while keeping Persian text and line breaks", () => {
    expect(xmlText("الف\u0000\ud800\n<&\"'🙂")).toBe("الف\n&lt;&amp;&quot;&apos;🙂");
  });
  it("exports each parcel once and keeps a blank shipment row for orders with no parcel", async () => {
    await t.services.shipments.save(
      t.actor.id,
      orderId,
      { carrier: "pickup" },
      null,
      "",
      "export:second",
    );
    const p = (await t.services.products.list(t.actor.id)).items[0]!;
    await t.services.orders.create(
      t.actor.id,
      { customer, items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }] },
      "export:no-parcel",
    );
    const data = await t.services.exports.shipments(t.actor.id, options);
    expect(data.rows).toHaveLength(3);
    expect(data.rows.filter((row) => row.shipmentId === null)).toHaveLength(1);
    expect(
      data.rows.filter((row) => row.orderId === orderId).map((row) => row.parcelNumber),
    ).toEqual([1, 2]);
  });
  it("filters by parcel state and whole-order queue, using order-creation date bounds", async () => {
    await t.services.orders.setStatus(t.actor.id, orderId, "confirmed", "export:confirm");
    await t.services.orders.setStatus(t.actor.id, orderId, "processing", "export:process");
    await t.services.orders.setPayment(t.actor.id, orderId, "paid", "export:pay");
    expect(
      (
        await t.services.exports.shipments(t.actor.id, {
          ...options,
          filter: "ready",
          state: "draft",
        })
      ).rows,
    ).toHaveLength(1);
    const now = new Date("2026-10-24T09:00:00Z"),
      range = periodBounds(now, "day", "Asia/Tehran");
    await t.db.update(orders).set({ createdAt: range.start }).where(eq(orders.id, orderId));
    const included = await t.services.exports.shipments(
      t.actor.id,
      { ...options, period: "day" },
      now,
    );
    expect(included.rows).toHaveLength(1);
    expect(included.range?.start).toBe(range.start.toISOString());
    await t.db.update(orders).set({ createdAt: range.end }).where(eq(orders.id, orderId));
    expect(
      (await t.services.exports.shipments(t.actor.id, { ...options, period: "day" }, now)).rows,
    ).toHaveLength(0);
    expect(
      (await t.services.exports.shipments(t.actor.id, { ...options, state: "dispatched" })).rows,
    ).toHaveLength(0);
  });
  it("denies bulk PII export to operators, viewers and inactive customers", async () => {
    for (const [telegramId, role] of [
      [303, "operator"],
      [404, "viewer"],
    ] as const) {
      const actor = await t.services.users.save(
        t.actor.id,
        { telegramId, firstName: role, role, isActive: true },
        `export:user:${telegramId}`,
      );
      await expect(t.services.exports.shipments(actor.id, options)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    const inactive = (await t.db.select().from(users).where(eq(users.telegramId, 202)))[0]!;
    await expect(t.services.exports.shipments(inactive.id, options)).rejects.toMatchObject({
      code: "INACTIVE",
    });
  });
  it("audits generated metadata, not file contents or customer PII, and deduplicates the same generation", async () => {
    const data = await t.services.exports.shipments(t.actor.id, options),
      file = shipmentWorkbook(data),
      sha256 = createHash("sha256").update(file).digest("hex");
    const input = { options, rows: data.rows.length, orders: 1, bytes: file.byteLength, sha256 };
    await t.services.exports.recordGeneration(t.actor.id, input, "export:audit");
    await t.services.exports.recordGeneration(t.actor.id, input, "export:audit");
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "shipment.export.generated"));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.details).toEqual(input);
    expect(JSON.stringify(logs)).not.toContain(customer.phone);
    await t.db.update(users).set({ role: "operator" }).where(eq(users.id, t.actor.id));
    await expect(
      t.services.exports.recordGeneration(t.actor.id, input, "export:revoked"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("refuses more than the row cap rather than silently truncating an export", async () => {
    await t.db.insert(orders).values(
      Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => ({
        id: randomUUID(),
        orderNumber: `ORD-CAP-${i}`,
        customerTelegramId: 202,
        customerName: "حد",
        customerPhone: customer.phone,
        shippingAddress: customer.address,
        totalAmount: 1,
      })),
    );
    await expect(t.services.exports.shipments(t.actor.id, options)).rejects.toMatchObject({
      code: "EXPORT_LIMIT",
    });
    const data = await t.services.exports.shipments(t.actor.id, { ...options, state: "draft" });
    await expect(async () =>
      shipmentWorkbook({
        ...data,
        rows: Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => data.rows[0]!),
      }),
    ).rejects.toMatchObject({ code: "EXPORT_LIMIT" });
  });
  it("rejects corrupt numeric cells and still produces an empty but usable workbook", async () => {
    const data = await t.services.exports.shipments(t.actor.id, options);
    expect(() =>
      shipmentWorkbook({ ...data, rows: [{ ...data.rows[0]!, shippingCost: -1 }] }),
    ).toThrow();
    const empty = unzipSync(shipmentWorkbook({ ...data, rows: [] }));
    expect(strFromU8(empty["xl/worksheets/sheet1.xml"]!)).toContain('ref="A1:U1"');
  });
});
