import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestBot } from "@bonkers-agency/grammy-test";
import type { BotContext } from "@/types/bot";
import type { Chat, User } from "grammy/types";
import { configureBot } from "@/bot/factory";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
import { click, field, choose } from "../helpers/telegram";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";

import { fillShipping } from "../helpers/shipping";

let t: TestDatabase, bot: TestBot<BotContext>, user: User, chat: Chat, orderId: string;
let guard: import("vitest").MockInstance<typeof fetch>;
beforeEach(async () => {
  t = await testDatabase();
  const p = await t.services.products.create(t.actor.id, testProduct, "parcel-ui:product");
  orderId = (
    await t.services.orders.create(
      t.actor.id,
      { customer, items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }] },
      "parcel-ui:order",
    )
  ).id;
  guard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected real network"));
  bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: "3",
  });
  user = bot.createUser({ id: 101, first_name: "مدیر" });
  chat = bot.createChat({ id: 101, type: "private" });
});
afterEach(() => {
  const calls = bot.getApiCalls(),
    real = guard.mock.calls.length;
  bot.dispose();
  guard.mockRestore();
  t.close();
  expect(real).toBe(0);
  for (const call of calls.filter((c) => c.method === "sendDocument"))
    expect(call.payload.chat_id).toBe(101);
  for (const call of calls.filter((c) => c.method === "sendMessage"))
    expect(call.payload.chat_id).not.toBe(202);
});
async function add(code: string, key: string) {
  return t.services.shipments.save(
    t.actor.id,
    orderId,
    { carrier: "iran_post", trackingNumber: code },
    null,
    "",
    key,
  );
}
async function ready() {
  await t.services.orders.setStatus(t.actor.id, orderId, "confirmed", "parcel-ui:confirmed");
  await t.services.orders.setStatus(t.actor.id, orderId, "processing", "parcel-ui:processing");
  await t.services.orders.setPayment(t.actor.id, orderId, "paid", "parcel-ui:paid");
}

describe("multi-parcel and Excel inline management", () => {
  it("adds a second parcel through the wizard and opens the selected parcel, not an arbitrary first one", async () => {
    const a = await add("00Ab0091", "parcel-ui:first");
    const root = await bot.clickButton(user, chat, `sh:view:${orderId}`);
    const carrier = await click(bot, user, chat, root, "➕ افزودن مرسولهٔ جدید");
    const fields = await choose(bot, user, chat, carrier, "تحویل حضوری");
    const confirm = await fillShipping(bot, user, chat, fields);
    await click(bot, user, chat, confirm, "✅ تأیید نهایی");
    const overview = await bot.clickButton(user, chat, `sh:view:${orderId}`);
    expect(overview.text).toContain("مرسوله‌ها: 2");
    const label = overview.keyboard!.inline!.flat().find((b) => b.text.startsWith("📦 #1 |"))!.text;
    const detail = await click(bot, user, chat, overview, label);
    expect(detail.text).toContain("مرسولهٔ #1");
    expect(detail.getInlineButton("📋 کپی کد مرسوله")).toMatchObject({
      copy_text: { text: "00Ab0091" },
    });
    expect((await t.services.shipments.getById(t.actor.id, a.id)).trackingNumber).toBe("00Ab0091");
  });
  it("handles independent dispatch/delivery and updates the parent only when all parcels finish", async () => {
    const a = await add("00001001", "parcel-ui:a"),
      b = await add("00001002", "parcel-ui:b");
    await ready();
    for (const [i, parcel] of [a, b].entries()) {
      const detail = await bot.clickButton(user, chat, `sh:parcel:${parcel.id}`);
      const confirm = await click(bot, user, chat, detail, "🚚 ثبت ارسال همین مرسوله");
      for (const button of confirm.keyboard!.inline!.flat())
        if ("callback_data" in button)
          expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      await click(bot, user, chat, confirm, "✅ تأیید همین مرسوله");
      expect((await t.services.orders.get(t.actor.id, orderId)).status).toBe(
        i === 0 ? "processing" : "shipped",
      );
    }
    for (const [i, parcel] of [a, b].entries()) {
      const detail = await bot.clickButton(user, chat, `sh:parcel:${parcel.id}`);
      const confirm = await click(bot, user, chat, detail, "📬 ثبت تحویل همین مرسوله");
      await click(bot, user, chat, confirm, "✅ تأیید همین مرسوله");
      expect((await t.services.orders.get(t.actor.id, orderId)).status).toBe(
        i === 0 ? "shipped" : "delivered",
      );
    }
  });
  it("rejects a stale parcel status confirmation after another staff edit", async () => {
    const p = await add("00001001", "parcel-ui:first");
    await ready();
    const detail = await bot.clickButton(user, chat, `sh:parcel:${p.id}`);
    const confirm = await click(bot, user, chat, detail, "🚚 ثبت ارسال همین مرسوله");
    await t.services.shipments.save(
      t.actor.id,
      orderId,
      { carrier: "iran_post", trackingNumber: "00001001", note: "ویرایش هم‌زمان" },
      p,
      "اصلاح نشانی",
      "parcel-ui:changed",
    );
    const denied = await click(bot, user, chat, confirm, "✅ تأیید همین مرسوله");
    expect(denied.text).toContain("هم‌زمان تغییر کرده");
    expect((await t.services.shipments.getById(t.actor.id, p.id)).state).toBe("draft");
  });
  it("clears only the selected draft and never reuses its number", async () => {
    const a = await add("00001001", "parcel-ui:first"),
      b = await add("00001002", "parcel-ui:second");
    const detail = await bot.clickButton(user, chat, `sh:parcel:${b.id}`);
    await click(bot, user, chat, detail, "🗑 پاک‌کردن پیش‌نویس ارسال");
    const confirm = await field(bot, user, chat, "پیش‌نویس دوم اشتباه است");
    await click(bot, user, chat, confirm, "✅ تأیید نهایی");
    expect((await t.services.shipments.list(t.actor.id, orderId)).map((row) => row.id)).toEqual([
      a.id,
    ]);
    const c = await add("00001003", "parcel-ui:third");
    expect((await t.services.shipments.getById(t.actor.id, c.id)).parcelNumber).toBe(3);
  });
  it("delivers an actual InputFile XLSX through the export inline flow with a hash and audit", async () => {
    await add("00Ab0091", "parcel-ui:first");
    await add("00Ab0092", "parcel-ui:second");
    const list = await bot.clickButton(user, chat, "o:list:0");
    const filters = await click(bot, user, chat, list, "📊 خروجی Excel مرسوله‌ها");
    const states = await click(bot, user, chat, filters, "همه سفارشات");
    const periods = await click(bot, user, chat, states, "همه وضعیت‌های مرسوله");
    await click(bot, user, chat, periods, "ماه جاری میلادی");
    const calls = bot.getApiCalls().filter((call) => call.method === "sendDocument");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.document).toBeDefined();
    expect(calls[0]?.payload.caption).toContain("2 ردیف | 1 سفارش");
    expect(calls[0]?.payload.caption).toContain("SHA256:");
  });
  it("denies all export routes to operators/viewers and keeps inactive customers outside tracking", async () => {
    for (const [telegramId, role] of [
      [303, "operator"],
      [404, "viewer"],
    ] as const) {
      await t.services.users.save(
        t.actor.id,
        { telegramId, firstName: role, role, isActive: true },
        `parcel-ui:user:${telegramId}`,
      );
      const actor = bot.createUser({ id: telegramId }),
        target = bot.createChat({ id: telegramId, type: "private" });
      for (const callback of [
        "exp:menu",
        "exp:state:all",
        "exp:period:all:all",
        "exp:run:all:all:all",
      ])
        expect((await bot.clickButton(actor, target, callback)).callbackAnswer?.text).toContain(
          "اجازه",
        );
      if (role === "operator")
        expect(
          (await bot.clickButton(actor, target, "o:list:0")).getInlineButton(
            "📊 خروجی Excel مرسوله‌ها",
          ),
        ).toBeUndefined();
    }
    const inactive = bot.createUser({ id: 202 }),
      target = bot.createChat({ id: 202, type: "private" });
    expect((await bot.clickButton(inactive, target, "exp:menu")).callbackAnswer?.text).toContain(
      "فعال نیست",
    );
    expect(bot.getApiCalls().filter((call) => call.method === "sendDocument")).toHaveLength(0);
  });
  it("hides delivered parcel edits for operators during partial fulfillment and blocks unsafe cancellation", async () => {
    const a = await add("00001001", "parcel-ui:first");
    await add("00001002", "parcel-ui:second");
    await ready();
    const sent = await t.services.shipments.transition(
      t.actor.id,
      a.id,
      "dispatched",
      a,
      "parcel-ui:sent",
    );
    await t.services.shipments.transition(
      t.actor.id,
      a.id,
      "delivered",
      sent,
      "parcel-ui:delivered",
    );
    await t.db.update(users).set({ role: "operator" }).where(eq(users.id, t.actor.id));
    const detail = await bot.clickButton(user, chat, `sh:parcel:${a.id}`);
    expect(detail.getInlineButton("✏️ ثبت / ویرایش ارسال")).toBeUndefined();
    expect((await bot.clickButton(user, chat, `sh:editParcel:${a.id}`)).text).toContain(
      "فقط با مدیر",
    );
    expect((await bot.clickButton(user, chat, `o:set:${orderId}:cancelled`)).text).toContain(
      "بخشی از سفارش ارسال شده",
    );
  });
});
