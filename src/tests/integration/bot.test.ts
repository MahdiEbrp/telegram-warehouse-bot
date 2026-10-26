import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestBot } from "@bonkers-agency/grammy-test";
import { eq } from "drizzle-orm";
import { configureBot } from "@/bot/factory";
import type { BotContext } from "@/types/bot";
import { products, users, inventoryLogs, orders, botConversations } from "@/db/schema";
import { testDatabase, testProduct, type TestDatabase } from "../helpers/database";
import { click, field, choose, view } from "../helpers/telegram";
import type { Chat, User } from "grammy/types";

let t: TestDatabase;
let bot: TestBot<BotContext>;
let user: User;
let chat: Chat;
let networkGuard: import("vitest").MockInstance<typeof fetch>;
function install() {
  bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: "1",
  });
  user = bot.createUser({ id: 101, first_name: "مدیر" });
  chat = bot.createChat({ type: "private", id: 101 });
}
beforeEach(async () => {
  t = await testDatabase();
  networkGuard = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected real network access"));
  install();
});
afterEach(() => {
  bot.dispose();
  expect(networkGuard).not.toHaveBeenCalled();
  networkGuard.mockRestore();
  t.close();
});

describe("real grammY pipeline via TestBot, zero real Telegram calls", () => {
  it("renders /start and the inline product list and answers callbacks", async () => {
    await t.services.products.create(t.actor.id, testProduct, "test:p");
    const home = await bot.sendCommand(user, chat, "/start");
    expect(home.text).toContain("داشبورد");
    expect(home.getInlineButton("📦 مدیریت محصولات")).toBeDefined();
    const list = await click(bot, user, chat, home, "📦 مدیریت محصولات");
    expect(list.text).toContain("فهرست محصولات");
    expect(list.keyboard?.inline?.flat().some((b) => b.text.includes(testProduct.name))).toBe(true);
    expect(list.callbackAnswer).toBeDefined();
  });
  it("completes the five-step product wizard and persists exactly one product", async () => {
    const cat = await t.services.products.createCategory(t.actor.id, "عمومی", null, "test:cat");
    const start = await bot.clickButton(user, chat, "p:add");
    expect(start.text).toContain("۱/۶");
    const next = start.keyboard?.inline?.flat().find((b) => b.text === "مرحله بعد ➡️");
    expect(next).toMatchObject({ disabled: {} });
    expect(next).not.toHaveProperty("callback_data");
    await field(bot, user, chat, "کفش ورزشی");
    await field(bot, user, chat, "shoe-۱۲");
    await field(bot, user, chat, "۲۵۰٬۰۰۰");
    const category = await field(bot, user, chat, "۱۲");
    const preview = await choose(bot, user, chat, category, "عمومی");
    expect(preview.text).toContain("پیش‌نمایش");
    const done = await click(bot, user, chat, preview, "✅ تأیید نهایی");
    expect(done.text).toContain("با موفقیت ثبت شد");
    const [p] = await t.db.select().from(products);
    expect(p).toMatchObject({
      name: "کفش ورزشی",
      sku: "SHOE-12",
      price: 250000,
      stockQuantity: 12,
      categoryId: cat.id,
    });
    expect(await t.db.select().from(products)).toHaveLength(1);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(1);
  });
  it("rejects malformed numeric input and allows cancellation without writes", async () => {
    await bot.clickButton(user, chat, "p:add");
    await field(bot, user, chat, "کالای نمونه");
    await field(bot, user, chat, "SKU-02");
    const invalid = await bot.sendMessage(user, chat, "-100");
    expect(invalid.text).toContain("فقط عدد صحیح");
    const valid = await bot.sendMessage(user, chat, "100");
    const cancelled = await click(bot, user, chat, valid, "✖️ انصراف");
    expect(cancelled.text).toContain("لغو شد");
    expect(await t.db.select().from(products)).toHaveLength(0);
  });
  it("ignores stale wizard callbacks from previous prompts", async () => {
    const first = view(await bot.clickButton(user, chat, "p:add"));
    const nameAccepted = view(await bot.sendMessage(user, chat, "کالای نمونه"));
    const skuPrompt = await click(bot, user, chat, nameAccepted, "مرحله بعد ➡️");
    expect(skuPrompt.text).toContain("SKU");
    const stale = await click(bot, user, chat, nameAccepted, "مرحله بعد ➡️");
    expect(stale.callbackAnswer?.text).toContain("مرحلهٔ جاری");
    const cancel = await click(bot, user, chat, skuPrompt, "✖️ انصراف");
    expect(cancel.text).toContain("لغو شد");
    expect(first.text).toContain("نام محصول");
  });
  it("denies forged user-management callbacks for viewers", async () => {
    await t.services.users.save(
      t.actor.id,
      { telegramId: 303, firstName: "بیننده", role: "viewer", isActive: true },
      "test:viewer",
    );
    const viewer = bot.createUser({ id: 303, first_name: "بیننده" });
    const viewerChat = bot.createChat({ type: "private", id: 303 });
    const home = await bot.sendCommand(viewer, viewerChat, "/start");
    expect(home.getInlineButton("👥 مدیریت کاربران")).toBeUndefined();
    const response = await bot.clickButton(viewer, viewerChat, "u:list:0");
    expect(response.callbackAnswer?.showAlert).toBe(true);
    expect(response.callbackAnswer?.text).toContain("اجازه");
    expect((await bot.clickButton(viewer, viewerChat, "p:add")).callbackAnswer?.text).toContain(
      "اجازه",
    );
  });
  it("checks role revocation during an already-running conversation", async () => {
    await bot.clickButton(user, chat, "p:add");
    await t.db.update(users).set({ role: "viewer" }).where(eq(users.id, t.actor.id));
    const response = await bot.sendMessage(user, chat, "نباید ثبت شود");
    expect(response.text).toContain("دسترسی این عملیات لغو");
    expect(await t.db.select().from(products)).toHaveLength(0);
  });
  it("keeps unknown accounts inactive and disallows group access", async () => {
    const stranger = bot.createUser({ id: 999 });
    const strangerChat = bot.createChat({ id: 999, type: "private" });
    expect((await bot.sendCommand(stranger, strangerChat, "/start")).text).toContain(
      "هنوز فعال نشده",
    );
    const group = bot.createChat({ type: "supergroup", title: "Group" });
    expect((await bot.sendCommand(user, group, "/start")).text).toContain("گفت‌وگوی خصوصی");
  });
  it("deduplicates delivered Telegram update IDs", async () => {
    const update = bot.server.updateFactory.createCommand(user, chat, "/start");
    await bot.handleUpdate(update);
    const count = bot.getApiCalls().length;
    await bot.handleUpdate(update);
    expect(bot.getApiCalls()).toHaveLength(count);
  });
  it("supports /start as the only textual command and cancels active input", async () => {
    await bot.clickButton(user, chat, "p:add");
    const home = await bot.sendCommand(user, chat, "/start");
    expect(home.text).toContain("منوی اصلی");
    const ignored = await bot.sendCommand(user, chat, "/add");
    expect(ignored.texts.join("\n")).toContain("تنها دستور بات /start");
  });
  it("survives a serverless instance restart using durable conversation storage", async () => {
    await bot.clickButton(user, chat, "p:add");
    expect(await t.db.select().from(botConversations)).toHaveLength(1);
    bot.dispose();
    install();
    // A new Telegram update has a new global update ID, unlike TestBot's reset counters.
    for (let i = 0; i < 50; i++) bot.server.getNextUpdateId();
    const response = await bot.sendMessage(user, chat, "ادامه پس از ری‌استارت");
    expect(response.text).toContain("دریافت شد");
    const next = await click(bot, user, chat, response, "مرحله بعد ➡️");
    expect(next.text).toContain("۲/۶");
  });
  it("adjusts stock with inline +/- controls", async () => {
    const p = await t.services.products.create(t.actor.id, testProduct, "test:p");
    const prompt = await bot.clickButton(user, chat, `p:stock:${p.id}`);
    const adjusted = await click(bot, user, chat, prompt, "+۱");
    const confirm = await click(bot, user, chat, adjusted, "مرحله بعد ➡️");
    const done = await click(bot, user, chat, confirm, "✅ تأیید نهایی");
    expect(done.text).toContain("گردش انبار ثبت شد");
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(11);
  });
  it("creates a full order through product selection, cart and customer fields", async () => {
    await t.services.products.create(t.actor.id, testProduct, "test:p");
    const select = await bot.clickButton(user, chat, "o:new");
    await choose(bot, user, chat, select, `${testProduct.name} | موجودی 10`);
    const cart = await field(bot, user, chat, "۲");
    const customer = await click(bot, user, chat, cart, "مرحله بعد: اطلاعات مشتری ➡️");
    expect(customer.text).toContain("شناسه");
    await field(bot, user, chat, "۲۰۲");
    await field(bot, user, chat, "مشتری نمونه");
    await field(bot, user, chat, "۰۹۱۲۳۴۵۶۷۸۹");
    await field(bot, user, chat, "تهران، خیابان نمونه پلاک ۱۲");
    const preview = await field(bot, user, chat, "-");
    const done = await click(bot, user, chat, preview, "✅ تأیید نهایی");
    expect(done.text).toContain("سفارش ثبت شد");
    const [order] = await t.db.select().from(orders);
    expect(order).toMatchObject({
      totalAmount: 200000,
      customerTelegramId: 202,
      status: "pending",
      paymentStatus: "unpaid",
    });
    expect((await t.db.select().from(products))[0]?.stockQuantity).toBe(8);
  });
});
