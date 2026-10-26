import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestBot } from "@bonkers-agency/grammy-test";
import { eq } from "drizzle-orm";
import { configureBot } from "@/bot/factory";
import { botConversations, users } from "@/db/schema";
import type { BotContext } from "@/types/bot";
import type { Chat, User } from "grammy/types";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
import { click, field, choose, view } from "../helpers/telegram";

import { fillShipping } from "../helpers/shipping";

let t: TestDatabase, bot: TestBot<BotContext>, user: User, chat: Chat;
let guard: import("vitest").MockInstance<typeof fetch>;
let productId: string, sequence: number;
function install(version = "2") {
  bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: version,
  });
  user = bot.createUser({ id: 101, first_name: "مدیر" });
  chat = bot.createChat({ id: 101, type: "private" });
}
async function makeOrder(name = customer.name) {
  return t.services.orders.create(
    t.actor.id,
    {
      customer: { ...customer, name },
      items: [{ productId, quantity: 1, expectedUnitPrice: testProduct.price }],
    },
    `integration:order:${sequence++}`,
  );
}
async function ready(id: string) {
  await t.services.orders.setStatus(
    t.actor.id,
    id,
    "confirmed",
    `integration:confirm:${sequence++}`,
  );
  await t.services.orders.setStatus(
    t.actor.id,
    id,
    "processing",
    `integration:process:${sequence++}`,
  );
  await t.services.orders.setPayment(t.actor.id, id, "paid", `integration:paid:${sequence++}`);
}
beforeEach(async () => {
  sequence = 1;
  t = await testDatabase();
  productId = (
    await t.services.products.create(
      t.actor.id,
      { ...testProduct, stockQuantity: 100 },
      "integration:product",
    )
  ).id;
  guard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected real network"));
  install();
});
afterEach(() => {
  // Every shipping action in these tests is staff-only: no customer sendMessage.
  const calls = bot.getApiCalls();
  const realCalls = guard.mock.calls.length;
  bot.dispose();
  guard.mockRestore();
  t.close();
  for (const call of calls.filter((call) => call.method === "sendMessage"))
    expect([101, 303]).toContain(call.payload.chat_id);
  expect(realCalls).toBe(0);
});
describe("staff-only tracking through the real grammY pipeline", () => {
  it("shows immutable REF in order cards and exposes native copy-text buttons", async () => {
    const order = await makeOrder();
    const detail = await bot.clickButton(user, chat, `o:view:${order.id}`);
    expect(detail.text).toContain(order.referenceCode);
    expect(detail.getInlineButton("📋 کپی کد پیگیری سفارش")).toMatchObject({
      copy_text: { text: order.referenceCode },
    });
    const shipping = await click(bot, user, chat, detail, "🚚 اطلاعات ارسال و رهگیری");
    expect(shipping.text).toContain("اطلاعات ارسال هنوز ثبت نشده");
    expect(shipping.getInlineButton("📋 کپی کد سفارش")).toMatchObject({
      copy_text: { text: order.referenceCode },
    });
    expect(shipping.getInlineButton("✏️ ثبت / ویرایش ارسال")).toBeDefined();
  });
  it("completes all shipment fields, copies exact barcode, links portal and never notifies customers", async () => {
    const order = await makeOrder();
    const carrier = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    await choose(bot, user, chat, carrier, "پست ایران");
    await field(bot, user, chat, "۰۰Ab۰۰۹۱");
    const bad = await bot.sendMessage(user, chat, "http://localhost/");
    expect(bad.text).toContain("HTTPS");
    await field(bot, user, chat, "https://carrier.example/track?code=00Ab0091");
    await field(bot, user, chat, "۰۱۲۳۴-۵۶۷۸۹");
    await field(bot, user, chat, "۲۵۰۰۰");
    const confirmation = await field(bot, user, chat, "شکننده");
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    const done = await click(bot, user, chat, confirmation, "✅ تأیید نهایی");
    expect(done.text).toContain("ثبت شد");
    const shipping = await click(bot, user, chat, done, "🚚 اطلاعات ارسال");
    expect(shipping.getInlineButton("📋 کپی کد مرسوله")).toMatchObject({
      copy_text: { text: "00Ab0091" },
    });
    expect(shipping.getInlineButton("🔗 لینک اختصاصی رهگیری")).toMatchObject({
      url: "https://carrier.example/track?code=00Ab0091",
    });
    expect(await t.services.shipments.get(t.actor.id, order.id)).toMatchObject({
      postalCode: "0123456789",
      shippingCost: 25000,
      note: "شکننده",
      dispatchedAt: null,
    });
    expect((await t.services.orders.get(t.actor.id, order.id)).totalAmount).toBe(testProduct.price);
    expect(
      bot
        .getApiCalls()
        .filter((call) => call.method === "sendMessage")
        .every((call) => call.payload.chat_id === 101),
    ).toBe(true);
  });
  it("supports no-barcode pickup/courier and named custom carriers", async () => {
    for (const label of ["تحویل حضوری", "پیک"]) {
      const order = await makeOrder();
      const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
      const code = await choose(bot, user, chat, start, label);
      const review = await fillShipping(bot, user, chat, code);
      await click(bot, user, chat, review, "✅ تأیید نهایی");
      expect((await t.services.shipments.get(t.actor.id, order.id))?.trackingNumber).toBeNull();
    }
    const order = await makeOrder();
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    const company = await choose(bot, user, chat, start, "سایر شرکت‌ها");
    const review = await fillShipping(bot, user, chat, company, {
      carrierName: "حمل آزمون",
      trackingNumber: "0000/test-1",
    });
    await click(bot, user, chat, review, "✅ تأیید نهایی");
    const detail = await bot.clickButton(user, chat, `sh:view:${order.id}`);
    expect(detail.text).toContain("حمل آزمون");
    expect(detail.getInlineButton("🔗 سامانهٔ شرکت حمل")).toBeUndefined();
  });
  it("rejects malformed codes and the order REF without writing a partial shipment", async () => {
    const order = await makeOrder();
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    const prompt = await choose(bot, user, chat, start, "پست ایران");
    expect(prompt.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
    expect((await bot.sendMessage(user, chat, "!")).text).toContain("کد رهگیری باید");
    expect((await bot.sendMessage(user, chat, order.referenceCode)).text).toContain(
      "کد پیگیری سفارش",
    );
    const accepted = await bot.sendMessage(user, chat, "00001234");
    await click(bot, user, chat, accepted, "✖️ انصراف");
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
  });
  it("gates a required barcode after a carrier change, even for a forged Next callback", async () => {
    const order = await makeOrder();
    await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "iran_post", trackingNumber: "00001234" },
      null,
      "",
      "integration:shipping",
    );
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    const code = await choose(bot, user, chat, start, "تیپاکس");
    expect(code.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
    const cancel = code.getInlineButton("✖️ انصراف")!;
    if (!("callback_data" in cancel)) throw new Error("Missing scoped callback");
    const forged = view(
      await bot.clickButton(
        user,
        chat,
        cancel.callback_data.replace(/:cancel$/, ":next"),
        code.messages.at(-1)!,
      ),
    );
    expect(forged.text).toContain("ابتدا مقدار معتبر");
    await click(bot, user, chat, forged, "✖️ انصراف");
    expect((await t.services.shipments.get(t.actor.id, order.id))?.carrier).toBe("iran_post");
  });
  it("edits with an audited reason and clears only a confirmed draft, preserving history", async () => {
    const order = await makeOrder();
    await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "courier", note: "قدیمی" },
      null,
      "",
      "integration:shipping",
    );
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    const code = await click(bot, user, chat, start, "مرحله بعد ➡️");
    const review = await fillShipping(bot, user, chat, code, {
      note: "یادداشت جدید",
      reason: "اصلاح نشانی پیک",
    });
    await click(bot, user, chat, review, "✅ تأیید نهایی");
    const detail = await bot.clickButton(user, chat, `sh:view:${order.id}`);
    await click(bot, user, chat, detail, "🗑 پاک‌کردن پیش‌نویس ارسال");
    const clear = await field(bot, user, chat, "روش حمل تغییر می‌کند");
    expect(clear.text).toContain("موجودی، پرداخت و REF تغییر نمی‌کنند");
    await click(bot, user, chat, clear, "✅ تأیید نهایی");
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    const history = await bot.clickButton(user, chat, `sh:history:${order.id}:0`);
    expect(history.text).toContain("3 رویداد");
    expect(history.text).toContain("اصلاح نشانی پیک");
    expect(history.text).toContain("پاک‌کردن پیش‌نویس");
  });
  it("cancels via /start without changing shipment, stock or references", async () => {
    const order = await makeOrder();
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    await choose(bot, user, chat, start, "تیپاکس");
    await field(bot, user, chat, "00001234");
    const home = await bot.sendCommand(user, chat, "/start");
    expect(home.text).toContain("لغو شد");
    expect(await t.services.shipments.get(t.actor.id, order.id)).toBeNull();
    expect((await t.services.orders.get(t.actor.id, order.id)).referenceCode).toBe(
      order.referenceCode,
    );
    expect((await t.services.products.get(t.actor.id, productId)).stockQuantity).toBe(99);
  });
  it("rejects a concurrent edit at confirmation instead of silently overwriting", async () => {
    const order = await makeOrder();
    const original = await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "courier" },
      null,
      "",
      "integration:shipping",
    );
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    const code = await click(bot, user, chat, start, "مرحله بعد ➡️");
    const review = await fillShipping(bot, user, chat, code, {
      note: "تغییر کهنه",
      reason: "ویرایش هم‌زمان",
    });
    await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "courier", note: "تغییر جدید" },
      original,
      "ویرایش دیگر",
      "integration:concurrent",
    );
    const denied = await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(denied.text).toContain("هم‌زمان تغییر کرده");
    expect(denied.text).toContain("تغییر کهنه");
    expect(denied.text).toContain("این نسخه قدیمی است");
    expect((await t.services.shipments.get(t.actor.id, order.id))?.note).toBe("تغییر جدید");
  });
  it("rechecks staff authorization during shipping conversations", async () => {
    const order = await makeOrder();
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    await choose(bot, user, chat, start, "پست ایران");
    await t.db.update(users).set({ role: "viewer" }).where(eq(users.id, t.actor.id));
    const denied = await bot.sendMessage(user, chat, "00001234");
    expect(denied.text).toContain("دسترسی این عملیات لغو");
  });
  it("rejects forged shipping/search callbacks for viewers and inactive customers", async () => {
    const order = await makeOrder();
    await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "بیننده", role: "viewer", isActive: true },
      "integration:viewer",
    );
    const viewer = bot.createUser({ id: 303 }),
      viewerChat = bot.createChat({ id: 303, type: "private" });
    for (const callback of [
      `sh:view:${order.id}`,
      `sh:history:${order.id}:0`,
      `sh:edit:${order.id}`,
      `sh:clear:${order.id}`,
      "o:search",
    ]) {
      const denied = await bot.clickButton(viewer, viewerChat, callback);
      expect(denied.callbackAnswer?.text).toContain("اجازه");
      expect(denied.text ?? "").not.toContain(order.referenceCode);
    }
    const inactive = bot.createUser({ id: 202 }),
      customerChat = bot.createChat({ id: 202, type: "private" });
    const denied = await bot.clickButton(inactive, customerChat, `sh:view:${order.id}`);
    expect(denied.callbackAnswer?.text).toContain("فعال نیست");
    expect(denied.text ?? "").not.toContain(order.referenceCode);
  });
  it("hides delivered edits for operators and all cancelled edits, while keeping codes readable", async () => {
    const order = await makeOrder();
    await ready(order.id);
    await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "pickup" },
      null,
      "",
      "integration:shipping",
    );
    await t.services.orders.setStatus(t.actor.id, order.id, "shipped", "integration:ship");
    await t.services.orders.setStatus(t.actor.id, order.id, "delivered", "integration:delivered");
    const cancelled = await makeOrder();
    await t.services.orders.setStatus(
      t.actor.id,
      cancelled.id,
      "cancelled",
      "integration:cancelled",
    );
    await t.db.update(users).set({ role: "operator" }).where(eq(users.id, t.actor.id));
    const detail = await bot.clickButton(user, chat, `sh:view:${order.id}`);
    expect(detail.text).toContain(order.referenceCode);
    expect(detail.getInlineButton("✏️ ثبت / ویرایش ارسال")).toBeUndefined();
    expect((await bot.clickButton(user, chat, `sh:edit:${order.id}`)).text).toContain(
      "فقط با مدیر",
    );
    const frozen = await bot.clickButton(user, chat, `sh:view:${cancelled.id}`);
    expect(frozen.getInlineButton("✏️ ثبت / ویرایش ارسال")).toBeUndefined();
  });
  it("disables shipping until payment/metadata are ready, then records dispatch and delivery", async () => {
    const order = await makeOrder();
    await ready(order.id);
    const status = await bot.clickButton(user, chat, `o:status:${order.id}`);
    expect(status.getInlineButton("ارسال: ابتدا پرداخت و اطلاعات حمل تکمیل شود")).toMatchObject({
      disabled: {},
    });
    const denied = await bot.clickButton(user, chat, `o:set:${order.id}:shipped`);
    expect(denied.text).toContain("پیش از ارسال");
    await t.services.shipments.save(
      t.actor.id,
      order.id,
      { carrier: "pickup" },
      null,
      "",
      "integration:shipping",
    );
    const available = await bot.clickButton(user, chat, `o:status:${order.id}`);
    const confirmation = await click(bot, user, chat, available, "ارسال‌شده");
    const shipped = await click(bot, user, chat, confirmation, "✅ تأیید");
    expect(shipped.text).toContain("ارسال‌شده");
    const detail = await bot.clickButton(user, chat, `sh:view:${order.id}`);
    expect(detail.getInlineButton("🗑 پاک‌کردن پیش‌نویس ارسال")).toBeUndefined();
    expect((await t.services.shipments.get(t.actor.id, order.id))?.dispatchedAt).toBeInstanceOf(
      Date,
    );
    const next = await bot.clickButton(user, chat, `o:status:${order.id}`);
    const deliver = await click(bot, user, chat, next, "تحویل‌شده");
    await click(bot, user, chat, deliver, "✅ تأیید");
    expect((await t.services.shipments.get(t.actor.id, order.id))?.deliveredAt).toBeInstanceOf(
      Date,
    );
  });
  it("searches both codes with replay-safe pagination and bounded callback payloads", async () => {
    const target = await makeOrder("مشتری جستجو");
    await t.services.shipments.save(
      t.actor.id,
      target.id,
      { carrier: "iran_post", trackingNumber: "00Ab0091" },
      null,
      "",
      "integration:shipping",
    );
    for (const term of [target.referenceCode, "00Ab0091"]) {
      await bot.clickButton(user, chat, "o:search");
      const results = await field(bot, user, chat, term);
      const found = results
        .keyboard!.inline!.flat()
        .find((b) => b.text.includes(target.referenceCode))!;
      const review = await choose(bot, user, chat, results, found.text);
      const selected = await click(bot, user, chat, review, "✅ تأیید نهایی");
      expect(selected.text).toContain(target.referenceCode);
      const detail = await click(bot, user, chat, selected, "🧾 مشاهده سفارش");
      expect(detail.text).toContain(target.orderNumber);
    }
    for (let i = 0; i < 7; i++) await makeOrder("مشتری جستجو");
    await bot.clickButton(user, chat, "o:search");
    const first = await field(bot, user, chat, "مشتری جستجو");
    const second = await click(bot, user, chat, first, "بعدی ➡️");
    expect(second.getInlineButton("بعدی ➡️")).toMatchObject({ disabled: {} });
    for (const button of [...first.keyboard!.inline!.flat(), ...second.keyboard!.inline!.flat()])
      if ("callback_data" in button)
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    await click(bot, user, chat, second, "✖️ انصراف");
    const queues = await bot.clickButton(user, chat, "o:list:0");
    expect(queues.getInlineButton("🚚 آماده ارسال")).toBeDefined();
    expect((await click(bot, user, chat, queues, "⚠️ ارسال قدیمی بدون اطلاعات")).text).toContain(
      "0 سفارش",
    );
  });
  it("resumes shipment input after an instance restart and invalidates a changed conversation version", async () => {
    const order = await makeOrder();
    const start = await bot.clickButton(user, chat, `sh:edit:${order.id}`);
    await choose(bot, user, chat, start, "پست ایران");
    expect(await t.db.select().from(botConversations)).toHaveLength(1);
    bot.dispose();
    install();
    for (let i = 0; i < 100; i++) bot.server.getNextUpdateId();
    const fields = await field(bot, user, chat, "00001234");
    expect(fields.text).toContain("لینک HTTPS");
    let confirm = fields;
    for (let i = 0; i < 4; i++) confirm = await click(bot, user, chat, confirm, "مرحله بعد ➡️");
    await click(bot, user, chat, confirm, "✅ تأیید نهایی");
    expect((await t.services.shipments.get(t.actor.id, order.id))?.trackingNumber).toBe("00001234");
    await bot.clickButton(user, chat, "o:search");
    bot.dispose();
    install("3");
    for (let i = 0; i < 200; i++) bot.server.getNextUpdateId();
    const expired = await bot.sendMessage(user, chat, order.referenceCode);
    expect(expired.texts.join("\n")).toContain("از دکمه‌ها استفاده کنید");
  });
});
