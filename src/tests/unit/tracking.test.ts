import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@/db/client";
import { createServices } from "@/db/queries";
import {
  auditLogs,
  chatLocks,
  mutationKeys,
  orderReferences,
  orders,
  shipments,
  users,
} from "@/db/schema";
import { allocateOrderReference } from "@/db/queries/references";
import { compactReference, escapeLike, generateOrderReference } from "@/lib/reference";
import {
  canEditShipment,
  carrierLabel,
  safeTrackingUrl,
  shipmentInput,
  shipmentReady,
  trackingLink,
  trackingNumberInput,
  postalCodeInput,
} from "@/lib/shipping";
import { callbackPermission } from "@/lib/permissions";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";

describe("reference / shipment structural validation", () => {
  it("generates 60-bit, unambiguous codes and normalizes pasted legacy references", () => {
    const codes = Array.from({ length: 3000 }, generateOrderReference);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^REF-[2-9A-HJ-NP-Z]{12}$/);
    expect(compactReference(" ref - ۰۰۰۰ ۰۰۰۰ ۰۰۰۱ ")).toBe("REF000000000001");
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });
  it("keeps case and leading zeros; normalizes only digits and separators", () => {
    expect(trackingNumberInput.parse(" ۰۰ Ab۰۰۹۱ ")).toBe("00Ab0091");
    expect(trackingNumberInput.parse("RR001234567IR")).toBe("RR001234567IR");
    expect(trackingNumberInput.parse("000012345678901234567890")).toBe("000012345678901234567890");
    expect(postalCodeInput.parse("۰۱۲۳۴-۵۶۷۸۹")).toBe("0123456789");
    for (const code of ["a", "1e+24", "کدرهگیری", "<script>", "x".repeat(65)])
      expect(trackingNumberInput.safeParse(code).success).toBe(false);
  });
  it("requires a barcode except for courier/pickup, and a name only for other", () => {
    expect(shipmentInput.parse({ carrier: "pickup" }).trackingNumber).toBeNull();
    expect(shipmentInput.parse({ carrier: "courier" }).shippingCost).toBe(0);
    for (const value of [
      { carrier: "iran_post" },
      { carrier: "tipax" },
      { carrier: "chapar" },
      { carrier: "other", trackingNumber: "00001234" },
      { carrier: "pickup", carrierName: "unexpected" },
      { carrier: "courier", shippingCost: -1 },
      { carrier: "pickup", shippingCost: 1.2 },
      { carrier: "pickup", shippingCost: 1e12 + 1 },
      { carrier: "pickup", note: "x".repeat(301) },
    ])
      expect(shipmentInput.safeParse(value).success).toBe(false);
    expect(shipmentReady(null)).toBe(false);
    expect(shipmentReady(undefined)).toBe(false);
    expect(shipmentReady({ carrier: "pickup" })).toBe(true);
    expect(carrierLabel("other", "حمل آزمون")).toBe("حمل آزمون");
    expect(carrierLabel("other")).toBe("سایر شرکت‌ها");
  });
  it("accepts only structural public HTTPS links and never creates guessed deep-links", () => {
    for (const url of [
      "http://carrier.example/",
      "javascript:alert(1)",
      "https://user:pass@carrier.example/",
      "https://localhost/",
      "https://a.local/",
      "https://a.internal/",
      "https://a.localhost./",
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://[::1]/",
      "https://carrier.example:8080/",
      "https://carrier.example/\ntrack",
      "not a url",
    ])
      expect(safeTrackingUrl(url)).toBe(false);
    expect(safeTrackingUrl("https://carrier.example/track?code=00Ab0091")).toBe(true);
    expect(
      trackingLink({ carrier: "iran_post", trackingNumber: "00001234", trackingUrl: null }),
    ).toBe("https://tracking.post.ir/");
    expect(trackingLink({ carrier: "tipax", trackingNumber: "00001234", trackingUrl: null })).toBe(
      "https://tipaxco.com/tracking",
    );
    expect(trackingLink({ carrier: "chapar", trackingNumber: "00001234", trackingUrl: null })).toBe(
      "https://chaparnet.com/track/",
    );
    expect(trackingLink({ carrier: "pickup", trackingNumber: null, trackingUrl: null })).toBeNull();
    expect(
      trackingLink({
        carrier: "other",
        trackingNumber: "00001234",
        trackingUrl: "https://carrier.example/t/00001234",
      }),
    ).toBe("https://carrier.example/t/00001234");
    expect(
      trackingLink({
        carrier: "other",
        trackingNumber: "00001234",
        trackingUrl: "http://bad.example/",
      }),
    ).toBeNull();
  });
  it("maps callbacks and corrections to the correct staff permission", () => {
    expect(callbackPermission("w:os:nonce:query:next")).toBe("orders:read");
    expect(callbackPermission("w:sm:nonce:commit:yes")).toBe("orders:shipping");
    expect(callbackPermission("sh:view:id")).toBe("orders:read");
    expect(callbackPermission("sh:history:id:0")).toBe("orders:read");
    expect(callbackPermission("sh:clear:id")).toBe("orders:shipping");
    expect(canEditShipment("operator", "shipped")).toBe(true);
    expect(canEditShipment("operator", "delivered")).toBe(false);
    expect(canEditShipment("admin", "delivered")).toBe(true);
    expect(canEditShipment("super_admin", "cancelled")).toBe(false);
    expect(canEditShipment("viewer", "pending")).toBe(false);
  });
});

let t: TestDatabase;
let productId: string;
let sequence: number;
const key = (part: string) => `track:${part}:${sequence++}`;
async function makeOrder(name = customer.name) {
  return t.services.orders.create(
    t.actor.id,
    {
      customer: { ...customer, name },
      items: [{ productId, quantity: 1, expectedUnitPrice: testProduct.price }],
    },
    key("order"),
  );
}
async function ready(id: string) {
  await t.services.orders.setStatus(t.actor.id, id, "confirmed", key("confirm"));
  await t.services.orders.setStatus(t.actor.id, id, "processing", key("process"));
  await t.services.orders.setPayment(t.actor.id, id, "paid", key("paid"));
}
async function save(
  id: string,
  input: unknown,
  revision: { id: string; version: number } | null = null,
  reason = "",
) {
  return t.services.shipments.save(t.actor.id, id, input, revision, reason, key("save"));
}
describe("transactional reference and shipping queries", () => {
  beforeEach(async () => {
    sequence = 1;
    t = await testDatabase();
    productId = (
      await t.services.products.create(
        t.actor.id,
        { ...testProduct, stockQuantity: 100 },
        key("product"),
      )
    ).id;
  });
  afterEach(() => t.close());
  it("allocates one immutable reference per order, included in reads and idempotent results", async () => {
    const order = await makeOrder();
    expect(order.referenceCode).toMatch(/^REF-[A-Z0-9]{12}$/);
    expect((await t.services.orders.get(t.actor.id, order.id)).referenceCode).toBe(
      order.referenceCode,
    );
    expect((await t.services.orders.list(t.actor.id)).items[0]?.referenceCode).toBe(
      order.referenceCode,
    );
    const generate = vi.fn(() => "REF-222222222222");
    expect(await t.db.transaction((tx) => allocateOrderReference(tx, order.id, generate))).toBe(
      order.referenceCode,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(await t.db.select().from(orderReferences)).toHaveLength(1);
  });
  it("retries collisions, bounds exhaustion and rolls back partial reference allocation", async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    await t.db.delete(orderReferences).where(eq(orderReferences.orderId, b.id));
    const generate = vi
      .fn()
      .mockReturnValueOnce(a.referenceCode)
      .mockReturnValue("REF-222222222222");
    expect(await t.db.transaction((tx) => allocateOrderReference(tx, b.id, generate))).toBe(
      "REF-222222222222",
    );
    expect(generate).toHaveBeenCalledTimes(2);
    await t.db.delete(orderReferences).where(eq(orderReferences.orderId, b.id));
    const fail = vi.fn(() => a.referenceCode);
    await expect(
      t.db.transaction((tx) => allocateOrderReference(tx, b.id, fail)),
    ).rejects.toMatchObject({ message: "REFERENCE_ALLOCATION_FAILED" });
    expect(fail).toHaveBeenCalledTimes(8);
    expect(await t.db.select().from(orderReferences)).toHaveLength(1);
  });
  it("stores normalized strings and internal costs without changing stock, order total or sales", async () => {
    const order = await makeOrder();
    await t.services.orders.setPayment(t.actor.id, order.id, "paid", key("pay"));
    const result = await save(order.id, {
      carrier: "iran_post",
      trackingNumber: "۰۰ Ab۰۰۹۱",
      postalCode: "۰۱۲۳۴-۵۶۷۸۹",
      shippingCost: 25000,
      trackingUrl: "https://carrier.example/t/00Ab0091",
      note: "ارسال شکننده",
    });
    expect(result.version).toBe(1);
    expect(await t.services.shipments.get(t.actor.id, order.id)).toMatchObject({
      trackingNumber: "00Ab0091",
      postalCode: "0123456789",
      shippingCost: 25000,
      dispatchedAt: null,
      deliveredAt: null,
    });
    expect((await t.services.orders.get(t.actor.id, order.id)).totalAmount).toBe(testProduct.price);
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(99);
    expect((await t.services.reports.sales(t.actor.id, "day")).total).toBe(testProduct.price);
  });
  it("enforces per-carrier barcode uniqueness but allows case-sensitive codes and null pickups", async () => {
    const a = await makeOrder(),
      b = await makeOrder(),
      c = await makeOrder(),
      d = await makeOrder(),
      e = await makeOrder();
    await save(a.id, { carrier: "iran_post", trackingNumber: "00Ab0091" });
    await expect(
      save(b.id, { carrier: "iran_post", trackingNumber: "00Ab0091" }),
    ).rejects.toMatchObject({ code: "TRACKING_IN_USE" });
    expect(await t.services.shipments.get(t.actor.id, b.id)).toBeNull();
    await save(b.id, { carrier: "tipax", trackingNumber: "00Ab0091" });
    await save(c.id, { carrier: "iran_post", trackingNumber: "00ab0091" });
    await save(d.id, { carrier: "pickup" });
    await save(e.id, { carrier: "pickup" });
    expect(await t.db.select().from(shipments)).toHaveLength(5);
  });
  it("does not mistake the order reference for a carrier barcode", async () => {
    const order = await makeOrder();
    for (const trackingNumber of [order.referenceCode, order.referenceCode.toLowerCase()])
      await expect(save(order.id, { carrier: "iran_post", trackingNumber })).rejects.toMatchObject({
        code: "WRONG_TRACKING_KIND",
      });
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
  });
  it("is idempotent, requires correction reasons, and rejects stale / wrong revisions", async () => {
    const order = await makeOrder();
    const input = { carrier: "courier", note: "پیش‌نویس" };
    const operation = key("idempotent");
    const first = await t.services.shipments.save(t.actor.id, order.id, input, null, "", operation);
    expect(
      await t.services.shipments.save(t.actor.id, order.id, input, null, "", operation),
    ).toEqual(first);
    expect((await t.services.shipments.history(t.actor.id, order.id)).total).toBe(1);
    expect(await save(order.id, input, first)).toEqual(first);
    await expect(save(order.id, { ...input, note: "اصلاح" }, first)).rejects.toMatchObject({
      code: "REASON_REQUIRED",
    });
    const changed = await save(order.id, { ...input, note: "اصلاح" }, first, "اصلاح یادداشت");
    expect(changed.version).toBe(2);
    await expect(save(order.id, input, first, "نسخه قدیمی")).rejects.toMatchObject({
      code: "SHIPMENT_CHANGED",
    });
    await expect(
      save(order.id, input, { id: order.id, version: 2 }, "شناسه متفاوت"),
    ).rejects.toMatchObject({ code: "SHIPMENT_CHANGED" });
    // v1.2 null explicitly creates a new parcel; stale edits must name their record.
    await expect(
      save(order.id, input, { id: first.id, version: 1 }, "نسخهٔ قدیمی"),
    ).rejects.toMatchObject({ code: "SHIPMENT_CHANGED" });
    const history = await t.services.shipments.history(t.actor.id, order.id);
    expect(history.total).toBe(2);
    expect(history.items.find((item) => item.action === "shipment.update")?.details).toMatchObject({
      before: { note: "پیش‌نویس", version: 1 },
      after: { note: "اصلاح", version: 2 },
      reason: "اصلاح یادداشت",
    });
  });
  it("clears only a draft, keeps audit/reference and rejects ABA after recreation", async () => {
    const order = await makeOrder();
    const first = await save(order.id, { carrier: "pickup" });
    await t.services.shipments.clearDraft(
      t.actor.id,
      order.id,
      first,
      "روش حمل اشتباه",
      key("clear"),
    );
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    const fresh = await save(order.id, { carrier: "courier" });
    expect(fresh.version).toBe(1);
    expect(fresh.id).not.toBe(first.id);
    await expect(save(order.id, { carrier: "pickup" }, first, "نسخه کهنه")).rejects.toMatchObject({
      code: "SHIPMENT_CHANGED",
    });
    expect((await t.services.shipments.history(t.actor.id, order.id)).total).toBe(3);
    expect((await t.services.orders.get(t.actor.id, order.id)).referenceCode).toBe(
      order.referenceCode,
    );
  });
  it("requires payment and valid shipping; timestamps/version/audits advance atomically", async () => {
    const order = await makeOrder();
    await t.services.orders.setStatus(t.actor.id, order.id, "confirmed", key("confirm"));
    await t.services.orders.setStatus(t.actor.id, order.id, "processing", key("process"));
    await expect(
      t.services.orders.setStatus(t.actor.id, order.id, "shipped", key("unpaid")),
    ).rejects.toMatchObject({ code: "UNPAID" });
    await t.services.orders.setPayment(t.actor.id, order.id, "paid", key("paid"));
    await expect(
      t.services.orders.setStatus(t.actor.id, order.id, "shipped", key("no-shipping")),
    ).rejects.toMatchObject({ code: "SHIPPING_REQUIRED" });
    expect((await t.services.orders.get(t.actor.id, order.id)).status).toBe("processing");
    const first = await save(order.id, { carrier: "pickup" });
    await t.services.orders.setStatus(t.actor.id, order.id, "shipped", key("ship"));
    const shipped = await t.services.shipments.get(t.actor.id, order.id);
    expect(shipped?.dispatchedAt).toBeInstanceOf(Date);
    expect(shipped?.version).toBe(2);
    expect(shipped?.deliveredAt).toBeNull();
    await expect(
      save(order.id, { carrier: "courier" }, first, "تغییر هم‌زمان"),
    ).rejects.toMatchObject({ code: "SHIPMENT_CHANGED" });
    await expect(
      t.services.shipments.clearDraft(
        t.actor.id,
        order.id,
        { id: first.id, version: 2 },
        "حذف ممنوع",
        key("clear"),
      ),
    ).rejects.toMatchObject({ code: "ALREADY_DISPATCHED" });
    await t.services.orders.setStatus(t.actor.id, order.id, "delivered", key("deliver"));
    await t.services.orders.setStatus(t.actor.id, order.id, "delivered", key("again"));
    const delivered = await t.services.shipments.get(t.actor.id, order.id);
    expect(delivered?.version).toBe(3);
    expect(delivered?.dispatchedAt).toEqual(shipped?.dispatchedAt);
    expect(delivered!.deliveredAt!.getTime()).toBeGreaterThanOrEqual(
      shipped!.dispatchedAt!.getTime(),
    );
    expect((await t.services.shipments.history(t.actor.id, order.id)).total).toBe(3);
  });
  it("lets operators fulfill, restricts delivered corrections to admin, and freezes cancelled", async () => {
    const operator = await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "اپراتور", role: "operator", isActive: true },
      key("operator"),
    );
    const admin = await t.services.users.save(
      t.actor.id,
      { telegramId: 404, firstName: "مدیر", role: "admin", isActive: true },
      key("admin"),
    );
    const order = await makeOrder();
    const first = await t.services.shipments.save(
      operator.id,
      order.id,
      { carrier: "courier" },
      null,
      "",
      key("operator-save"),
    );
    await ready(order.id);
    await t.services.orders.setStatus(operator.id, order.id, "shipped", key("ship"));
    await t.services.orders.setStatus(operator.id, order.id, "delivered", key("deliver"));
    const revision = { id: first.id, version: 3 };
    await expect(
      t.services.shipments.save(
        operator.id,
        order.id,
        { carrier: "courier", note: "نباید ثبت شود" },
        revision,
        "اصلاح پس از تحویل",
        key("denied"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await t.services.shipments.save(
      admin.id,
      order.id,
      { carrier: "courier", note: "اصلاح مدیر" },
      revision,
      "اصلاح پس از تحویل",
      key("admin-fix"),
    );
    const cancelled = await makeOrder();
    const draft = await save(cancelled.id, { carrier: "pickup" });
    await t.services.orders.setStatus(t.actor.id, cancelled.id, "cancelled", key("cancel"));
    await expect(save(cancelled.id, { carrier: "courier" }, draft, "لغوشده")).rejects.toMatchObject(
      { code: "ORDER_CANCELLED" },
    );
    await expect(
      t.services.shipments.clearDraft(t.actor.id, cancelled.id, draft, "حذف لغوشده", key("clear")),
    ).rejects.toMatchObject({ code: "ALREADY_DISPATCHED" });
    expect(await t.services.shipments.get(operator.id, cancelled.id)).toMatchObject({
      carrier: "pickup",
    });
  });
  it("keeps legacy shipped orders deliverable, with unknown historical shipment times", async () => {
    const order = await makeOrder();
    await t.db
      .update(orders)
      .set({ status: "shipped", paymentStatus: "paid" })
      .where(eq(orders.id, order.id));
    await t.services.orders.setStatus(t.actor.id, order.id, "delivered", key("legacy-deliver"));
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    await expect(save(order.id, { carrier: "courier" })).rejects.toMatchObject({
      code: "REASON_REQUIRED",
    });
    await save(order.id, { carrier: "courier" }, null, "تکمیل اطلاعات بایگانی");
    expect(await t.services.shipments.get(t.actor.id, order.id)).toMatchObject({
      dispatchedAt: null,
      deliveredAt: null,
    });
  });
  it("searches references, original numbers, barcodes, Persian phones and literal wildcard text", async () => {
    const a = await makeOrder("نام_ویژه%\\آزمون"),
      b = await makeOrder("دیگر");
    await save(a.id, { carrier: "iran_post", trackingNumber: "00Ab0091" });
    for (const term of [
      a.referenceCode,
      a.referenceCode.toLowerCase().replace("-", " - "),
      a.referenceCode.slice(4),
      a.orderNumber,
      "00Ab0091",
      "۰۰Ab۰۰۹۱",
      "نام_ویژه%\\آزمون",
    ]) {
      const result = await t.services.orders.list(t.actor.id, 0, "all", term);
      expect(result.total, term).toBe(1);
      expect(result.items[0]?.id).toBe(a.id);
    }
    expect((await t.services.orders.list(t.actor.id, 0, "all", "۰۹۱۲۳۴۵۶۷۸۹")).total).toBe(2);
    for (const term of ["%' OR 1=1 --", "_wildcard_", "not found", "--"])
      expect((await t.services.orders.list(t.actor.id, 0, "all", term)).total).toBe(0);
    expect((await t.services.orders.list(t.actor.id, 0, "all", "%")).items[0]?.id).toBe(a.id);
    expect((await t.services.orders.get(t.actor.id, b.id)).shipment).toBeNull();
  });
  it("paginates and filters paid processing, shipped, and legacy untracked orders", async () => {
    const queued = await makeOrder();
    await ready(queued.id);
    const shipped = await makeOrder();
    await ready(shipped.id);
    await save(shipped.id, { carrier: "pickup" });
    await t.services.orders.setStatus(t.actor.id, shipped.id, "shipped", key("ship"));
    const legacy = await makeOrder();
    await t.db.update(orders).set({ status: "delivered" }).where(eq(orders.id, legacy.id));
    for (let i = 0; i < 5; i++) await makeOrder();
    expect((await t.services.orders.list(t.actor.id, 0, "ready")).items.map((x) => x.id)).toEqual([
      queued.id,
    ]);
    expect((await t.services.orders.list(t.actor.id, 0, "shipped")).items.map((x) => x.id)).toEqual(
      [shipped.id],
    );
    expect(
      (await t.services.orders.list(t.actor.id, 0, "untracked")).items.map((x) => x.id),
    ).toEqual([legacy.id]);
    expect((await t.services.orders.list(t.actor.id, 1)).items).toHaveLength(2);
    expect((await t.services.orders.list(t.actor.id, 999)).page).toBe(1);
  });
  it("blocks viewers, inactive customers and expired fenced leases", async () => {
    const order = await makeOrder();
    const viewer = await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "بیننده", role: "viewer", isActive: true },
      key("viewer"),
    );
    await expect(t.services.shipments.get(viewer.id, order.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(t.services.shipments.history(viewer.id, order.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      t.services.orders.list(viewer.id, 0, "all", order.referenceCode),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [inactive] = await t.db
      .select()
      .from(users)
      .where(eq(users.telegramId, customer.telegramId));
    await expect(t.services.shipments.get(inactive!.id, order.id)).rejects.toMatchObject({
      code: "INACTIVE",
    });
    await t.db
      .insert(chatLocks)
      .values({ key: "chat:101", owner: "expired-owner", expiresAt: Date.now() - 1000 });
    await expect(
      t.services.shipments.save(
        t.actor.id,
        order.id,
        { carrier: "pickup" },
        null,
        "",
        key("expired"),
        { key: "chat:101", owner: "expired-owner" },
      ),
    ).rejects.toMatchObject({ message: "LEASE_EXPIRED" });
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    expect(
      (await t.db.select().from(auditLogs)).filter((x) => x.entityType === "shipment"),
    ).toHaveLength(0);
  });
  it("rolls back shipment creation/clear if audit insertion fails", async () => {
    const order = await makeOrder();
    const trigger =
      "CREATE TRIGGER fail_shipment_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type = 'shipment' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END";
    await t.client.execute(trigger);
    await expect(
      t.services.shipments.save(
        t.actor.id,
        order.id,
        { carrier: "pickup" },
        null,
        "",
        "tracking:failed-save",
      ),
    ).rejects.toThrow();
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    expect(
      await t.db.select().from(mutationKeys).where(eq(mutationKeys.key, "tracking:failed-save")),
    ).toHaveLength(0);
    await t.client.execute("DROP TRIGGER fail_shipment_audit");
    const draft = await save(order.id, { carrier: "pickup" });
    await t.client.execute(trigger);
    await expect(
      t.services.shipments.clearDraft(
        t.actor.id,
        order.id,
        draft,
        "آزمون خرابی سابقه",
        key("clear-fails"),
      ),
    ).rejects.toThrow();
    expect(await t.services.shipments.get(t.actor.id, order.id)).toMatchObject({
      id: draft.id,
      version: 1,
    });
    expect((await t.services.shipments.history(t.actor.id, order.id)).total).toBe(1);
  });
  it("rolls back status and dispatch metadata together and safely retries after audit failure", async () => {
    const order = await makeOrder();
    await ready(order.id);
    await save(order.id, { carrier: "pickup" });
    await t.client.execute(
      "CREATE TRIGGER fail_dispatch BEFORE INSERT ON audit_logs WHEN NEW.action = 'shipment.dispatched' BEGIN SELECT RAISE(ABORT, 'simulated dispatch failure'); END",
    );
    const operation = key("dispatch");
    await expect(
      t.services.orders.setStatus(t.actor.id, order.id, "shipped", operation),
    ).rejects.toThrow();
    expect((await t.services.orders.get(t.actor.id, order.id)).status).toBe("processing");
    expect(await t.services.shipments.get(t.actor.id, order.id)).toMatchObject({
      dispatchedAt: null,
      version: 1,
    });
    await t.client.execute("DROP TRIGGER fail_dispatch");
    await t.services.orders.setStatus(t.actor.id, order.id, "shipped", operation);
    expect(await t.services.shipments.get(t.actor.id, order.id)).toMatchObject({ version: 2 });
    expect((await t.services.shipments.history(t.actor.id, order.id)).total).toBe(2);
  });
  it("serializes two independent clients so only one expected-revision edit succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warehouse-shipment-race-"));
    const a = await testDatabase(`file:${join(dir, "race.db")}`);
    const b = await createDatabase({ url: `file:${join(dir, "race.db")}` });
    try {
      await a.client.execute("PRAGMA busy_timeout=25");
      await b.client.execute("PRAGMA busy_timeout=25");
      const serviceB = createServices(b.db, { bootstrapIds: [101], timeZone: "Asia/Tehran" });
      const p = await a.services.products.create(a.actor.id, testProduct, "race:product");
      const order = await a.services.orders.create(
        a.actor.id,
        {
          customer,
          items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }],
        },
        "race:order",
      );
      const first = await a.services.shipments.save(
        a.actor.id,
        order.id,
        { carrier: "pickup" },
        null,
        "",
        "race:initial",
      );
      const results = await Promise.allSettled([
        a.services.shipments.save(
          a.actor.id,
          order.id,
          { carrier: "pickup", note: "A" },
          first,
          "ویرایش اول",
          "race:a",
        ),
        serviceB.shipments.save(
          a.actor.id,
          order.id,
          { carrier: "pickup", note: "B" },
          first,
          "ویرایش دوم",
          "race:b",
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "SHIPMENT_CHANGED" },
      });
      expect((await a.services.shipments.get(a.actor.id, order.id))?.version).toBe(2);
      expect((await a.services.shipments.history(a.actor.id, order.id)).total).toBe(2);
    } finally {
      a.close();
      b.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("returns clear not-found errors for shipping reads/history and mutations", async () => {
    const missing = "123e4567-e89b-42d3-a456-426614174000";
    await expect(t.services.shipments.get(t.actor.id, missing)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(t.services.shipments.history(t.actor.id, missing)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(save(missing, { carrier: "pickup" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
