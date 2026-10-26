import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestBot } from "@bonkers-agency/grammy-test";
import { eq } from "drizzle-orm";
import { configureBot } from "@/bot/factory";
import { categories, users } from "@/db/schema";
import type { BotContext } from "@/types/bot";
import type { Chat, User } from "grammy/types";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
import { click, field, choose } from "../helpers/telegram";

let t: TestDatabase;
let bot: TestBot<BotContext>;
let user: User;
let chat: Chat;
let networkGuard: import("vitest").MockInstance<typeof fetch>;
beforeEach(async () => {
  t = await testDatabase();
  networkGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: "1",
  });
  user = bot.createUser({ id: 101, first_name: "مدیر" });
  chat = bot.createChat({ id: 101, type: "private" });
});
afterEach(() => {
  bot.dispose();
  expect(networkGuard).not.toHaveBeenCalled();
  networkGuard.mockRestore();
  t.close();
});
describe("management and report callbacks", () => {
  it("edits a product field, then archives through confirmation", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    const edit = await bot.clickButton(user, chat, `p:edit:${p.id}`);
    await choose(bot, user, chat, edit, "بهای خرید");
    const preview = await field(bot, user, chat, "۵۰۰۰۰");
    const result = await click(bot, user, chat, preview, "✅ تأیید نهایی");
    expect(result.text).toContain("ویرایش شد");
    expect(await t.services.products.get(t.actor.id, p.id)).toMatchObject({
      costPrice: 50000,
      price: testProduct.price,
      stockQuantity: 10,
    });
    const archive = await bot.clickButton(user, chat, `p:archive:${p.id}`);
    await click(bot, user, chat, archive, "✅ بایگانی");
    expect((await t.services.products.get(t.actor.id, p.id)).isActive).toBe(false);
  });
  it("creates a category with an existing parent via the wizard", async () => {
    const root = await t.services.products.createCategory(t.actor.id, "ریشه", null, "test:root");
    await bot.clickButton(user, chat, "p:categoryAdd");
    const parent = await field(bot, user, chat, "زیرگروه");
    const confirm = await choose(bot, user, chat, parent, "ریشه");
    const done = await click(bot, user, chat, confirm, "✅ تأیید نهایی");
    expect(done.text).toContain("دسته‌بندی ساخته شد");
    expect(
      (await t.db.select().from(categories).where(eq(categories.name, "زیرگروه")))[0]?.parentId,
    ).toBe(root.id);
  });
  it("allows a viewer to search stock but not edit", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    await t.db.update(users).set({ role: "viewer" }).where(eq(users.id, t.actor.id));
    await bot.clickButton(user, chat, "p:search");
    const results = await field(bot, user, chat, "SKU-001");
    const review = await choose(bot, user, chat, results, `${testProduct.name} | موجودی 10`);
    const found = await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(found.text).toContain("موجودی: 10");
    expect((await bot.clickButton(user, chat, `p:edit:${p.id}`)).callbackAnswer?.text).toContain(
      "اجازه",
    );
  });
  it("adds an admin, changes their role and disables them", async () => {
    await bot.clickButton(user, chat, "u:add");
    await field(bot, user, chat, "۷۰۰");
    const roles = await field(bot, user, chat, "همکار جدید");
    const preview = await choose(bot, user, chat, roles, "مدیر");
    await click(bot, user, chat, preview, "✅ تأیید نهایی");
    const [saved] = await t.db.select().from(users).where(eq(users.telegramId, 700));
    expect(saved?.role).toBe("admin");
    const roleResponse = await bot.clickButton(user, chat, `u:roleYes:${saved!.id}:operator`);
    expect(roleResponse.text).toContain("اپراتور");
    const confirm = await bot.clickButton(user, chat, `u:toggle:${saved!.id}`);
    await click(bot, user, chat, confirm, "✅ تأیید");
    expect((await t.db.select().from(users).where(eq(users.telegramId, 700)))[0]?.isActive).toBe(
      false,
    );
  });
  it("reports last-super-admin protection after an already-acknowledged callback", async () => {
    const denied = await bot.clickButton(user, chat, `u:roleYes:${t.actor.id}:viewer`);
    expect(denied.text).toContain("آخرین مدیرکل");
    expect((await t.db.select().from(users).where(eq(users.id, t.actor.id)))[0]?.role).toBe(
      "super_admin",
    );
  });
  it("persists and displays store/payment settings", async () => {
    await bot.clickButton(user, chat, "s:edit");
    await field(bot, user, chat, "فروشگاه آزمون");
    await field(bot, user, chat, "-");
    await field(bot, user, chat, "نشانی فروشگاه");
    const preview = await field(bot, user, chat, "انتقال بانکی؛ رسید را برای مدیر ارسال کنید.");
    await click(bot, user, chat, preview, "✅ تأیید نهایی");
    const settings = await bot.clickButton(user, chat, "s:menu");
    expect(settings.text).toContain("فروشگاه آزمون");
    expect((await t.services.settings.get(t.actor.id)).phone).toBe("");
  });
  it("changes order/payment status, cancels and records a manual refund", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    const o = await t.services.orders.create(
      t.actor.id,
      { customer, items: [{ productId: p.id, quantity: 2, expectedUnitPrice: testProduct.price }] },
      "test:o",
    );
    const detail = await bot.clickButton(user, chat, `o:view:${o.id}`);
    const pay = await click(bot, user, chat, detail, "💳 تأیید پرداخت دستی");
    const paid = await click(bot, user, chat, pay, "✅ بله، ثبت شود");
    expect(paid.text).toContain("پرداخت‌شده");
    const statuses = await click(bot, user, chat, paid, "🔄 تغییر وضعیت");
    const cancel = await click(bot, user, chat, statuses, "لغوشده");
    const cancelled = await click(bot, user, chat, cancel, "✅ تأیید");
    expect(cancelled.text).toContain("لغوشده");
    const refund = await click(bot, user, chat, cancelled, "↩️ ثبت بازپرداخت دستی");
    const refunded = await click(bot, user, chat, refund, "✅ بله، ثبت شود");
    expect(refunded.text).toContain("بازپرداخت ثبت‌شده");
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(10);
  });
  it("renders daily/monthly sales, low stock, movements and audit pages", async () => {
    const p = await t.services.products.create(
      t.actor.id,
      { ...testProduct, stockQuantity: 4 },
      "test:p",
    );
    const order = await t.services.orders.create(
      t.actor.id,
      { customer, items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }] },
      "test:o",
    );
    await t.services.orders.setPayment(t.actor.id, order.id, "paid", "test:paid");
    const reports = await bot.clickButton(user, chat, "r:menu");
    expect((await click(bot, user, chat, reports, "☀️ فروش امروز")).text).toContain("تعداد: 1");
    expect((await bot.clickButton(user, chat, "r:month")).text).toContain("ماه جاری میلادی");
    expect((await bot.clickButton(user, chat, "r:low:0")).text).toContain(testProduct.name);
    expect((await bot.clickButton(user, chat, "r:moves:0")).text).toContain("گردش انبار");
    expect((await bot.clickButton(user, chat, "a:list:0")).text).toContain("order.payment");
  });
  it("paginates with real disabled buttons and <=64-byte callback payloads", async () => {
    for (let i = 0; i < 7; i++)
      await t.services.products.create(
        t.actor.id,
        { ...testProduct, sku: `SKU-${i}`, name: `کالای ${i}` },
        `test:p${i}`,
      );
    const first = await bot.clickButton(user, chat, "p:list:0");
    expect(first.getInlineButton("⬅️ قبلی")).toHaveProperty("disabled");
    const second = await click(bot, user, chat, first, "بعدی ➡️");
    expect(second.getInlineButton("بعدی ➡️")).toHaveProperty("disabled");
    for (const b of second.keyboard?.inline?.flat() ?? [])
      if ("callback_data" in b) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
  it("answers an expired callback with a recoverable main menu", async () => {
    const result = await bot.clickButton(user, chat, "w:pa:old:save:yes");
    expect(result.callbackAnswer?.text).toContain("منقضی");
    expect(result.text).toContain("داشبورد");
  });
});
