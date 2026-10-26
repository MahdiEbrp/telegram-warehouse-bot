import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestBot, type BotResponse } from "@bonkers-agency/grammy-test";
import type { Chat, User } from "grammy/types";
import { eq } from "drizzle-orm";
import { configureBot } from "@/bot/factory";
import {
  botConversations,
  categories,
  inventoryLogs,
  mutationKeys,
  orders,
  processedUpdates,
  products,
  storeSettings,
  users,
} from "@/db/schema";
import { MAX_WIZARD_EVENTS } from "@/bot/scenes/wizard";
import type { BotContext } from "@/types/bot";
import { customer, testDatabase, testProduct, type TestDatabase } from "../helpers/database";
import { choose, click, field, view } from "../helpers/telegram";
import { fillShipping } from "../helpers/shipping";
let t: TestDatabase, bot: TestBot<BotContext>, user: User, chat: Chat;
let guard: import("vitest").MockInstance<typeof fetch>;
function install(version = "4") {
  bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: version,
  });
  user = bot.createUser({ id: 101, first_name: "مدیر" });
  chat = bot.createChat({ id: 101, type: "private" });
}
beforeEach(async () => {
  t = await testDatabase();
  guard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No real network"));
  install();
});
afterEach(() => {
  const real = guard.mock.calls.length;
  bot.dispose();
  guard.mockRestore();
  t.close();
  expect(real).toBe(0);
});
const next = (r: BotResponse) => click(bot, user, chat, r, "مرحله بعد ➡️");
const back = (r: BotResponse) => click(bot, user, chat, r, "⬅️ مرحله قبل");
async function createProduct() {
  return t.services.products.create(t.actor.id, testProduct, "forms:seed");
}
async function newOrder() {
  const p = await createProduct();
  const start = view(await bot.clickButton(user, chat, "o:new"));
  await choose(bot, user, chat, start, `${testProduct.name} | موجودی 10`);
  return { p, cart: await field(bot, user, chat, "۲") };
}
async function productReview(sku = "NEW-01") {
  await bot.clickButton(user, chat, "p:add");
  await field(bot, user, chat, "کالای پیش‌نویس");
  await field(bot, user, chat, sku);
  await field(bot, user, chat, "۱۲۰۰۰");
  return next(await field(bot, user, chat, "۳"));
}
async function forged(r: BotResponse, action: string, messageId?: number) {
  const b = r.getInlineButton("✖️ انصراف")!;
  if (!("callback_data" in b)) throw new Error("No callback");
  const m = structuredClone(r.messages.at(-1)!);
  if (messageId !== undefined) m.message_id = messageId;
  return view(
    await bot.clickButton(user, chat, b.callback_data.replace(/:cancel$/, `:${action}`), m),
  );
}

describe("one-field session forms: real Back/Next, draft retention and submission boundaries", () => {
  it("keeps one prompt active, disables first Back/empty Next and preserves values across real Back", async () => {
    const first = view(await bot.clickButton(user, chat, "p:add"));
    expect(first.text).toContain("۱/۶");
    expect(first.getInlineButton("⬅️ مرحله قبل")).toMatchObject({ disabled: {} });
    expect(first.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
    const accepted = view(await bot.sendMessage(user, chat, "نام اولیه"));
    expect(accepted.text).toContain("نام محصول");
    expect(accepted.text).not.toContain("SKU یکتا");
    expect(accepted.messages.at(-1)?.message_id).not.toBe(first.messages.at(-1)?.message_id);
    const sku = await next(accepted);
    expect(sku.text).toContain("SKU یکتا");
    expect(sku.messages.at(-1)?.message_id).toBe(accepted.messages.at(-1)?.message_id);
    const typed = view(await bot.sendMessage(user, chat, "draft-۱۲"));
    const name = await back(typed);
    expect(name.text).toContain("نام اولیه");
    const changed = view(await bot.sendMessage(user, chat, "نام اصلاح‌شده"));
    const restored = await next(changed);
    expect(restored.text).toContain("DRAFT-12");
    expect(restored.getInlineButton("مرحله بعد ➡️")).toHaveProperty("callback_data");
    await click(bot, user, chat, restored, "✖️ انصراف");
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(await t.db.select().from(botConversations)).toHaveLength(0);
  });
  it("does not advance a choice until Next and remembers per-property edits when switching back", async () => {
    const p = await createProduct();
    const initial = view(await bot.clickButton(user, chat, `p:edit:${p.id}`));
    const selected = await click(bot, user, chat, initial, "بهای خرید");
    expect(selected.text).toContain("کدام مشخصه");
    expect(selected.text).not.toContain("مقدار جدید •");
    const value = await next(selected);
    expect(value.text).toContain("مقدار جدید • بهای خرید");
    const typed = view(await bot.sendMessage(user, chat, "۴۰۰۰۰"));
    const props = await back(typed);
    const name = await choose(bot, user, chat, props, "نام");
    expect(name.text).toContain(testProduct.name);
    const again = await back(name);
    const cost = await choose(bot, user, chat, again, "بهای خرید");
    expect(cost.text).toContain("40000");
    expect((await t.services.products.get(t.actor.id, p.id)).costPrice).toBe(0);
    const review = await next(cost);
    await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect((await t.services.products.get(t.actor.id, p.id)).costPrice).toBe(40000);
  });
  it("retains pagination selection and shows its actual category name in final review", async () => {
    for (let i = 0; i < 7; i++)
      await t.services.products.createCategory(t.actor.id, `گروه ${i}`, null, `forms:cat${i}`);
    await bot.clickButton(user, chat, "p:add");
    await field(bot, user, chat, "کالای دسته‌دار");
    await field(bot, user, chat, "CAT-01");
    await field(bot, user, chat, "۱۰۰");
    const first = await field(bot, user, chat, "۰");
    const page = await click(bot, user, chat, first, "بعدی ➡️");
    const selected = await click(bot, user, chat, page, "گروه 6");
    const stock = await back(selected);
    expect(stock.text).toContain("موجودی اولیه");
    const restored = await next(stock);
    expect(restored.text).toContain("گروه 6");
    const review = await next(restored);
    expect(review.text).toContain("دسته‌بندی: گروه 6");
    await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect((await t.db.select().from(products))[0]?.stockQuantity).toBe(0);
  });
  it("returns from final review, changes a field and preserves all later valid fields", async () => {
    let r = await productReview();
    expect(r.text).toContain("پیش‌نمایش");
    expect(await t.db.select().from(products)).toHaveLength(0);
    r = await back(r);
    r = await back(r);
    r = await back(r);
    expect(r.text).toContain("قیمت فروش");
    expect(r.text).toContain("12000");
    r = await field(bot, user, chat, "۱۵۰۰۰");
    expect(r.text).toContain("مقدار: 3");
    r = await next(r);
    r = await next(r);
    expect(r.text).toContain("۱۵٬۰۰۰");
    await click(bot, user, chat, r, "✅ تأیید نهایی");
    expect((await t.db.select().from(products))[0]?.price).toBe(15000);
  });
  it("keeps a failed final submission editable and retries a corrected duplicate SKU without partial writes", async () => {
    await createProduct();
    const review = await productReview(testProduct.sku);
    const failed = await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(failed.text).toContain("تکراری");
    expect(failed.text).toContain("پیش‌نویس محفوظ");
    expect(await t.db.select().from(products)).toHaveLength(1);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(1);
    let r = failed;
    for (let i = 0; i < 4; i++) r = await back(r);
    expect(r.text).toContain("SKU یکتا");
    r = await field(bot, user, chat, "FIXED-01");
    for (let i = 0; i < 3; i++) r = await next(r);
    await click(bot, user, chat, r, "✅ تأیید نهایی");
    expect(await t.db.select().from(products)).toHaveLength(2);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(2);
    expect(await t.db.select().from(mutationKeys)).toHaveLength(2);
  });
  it("returns from customer input to the existing cart, preserves customer ID and edits quantity without restarting", async () => {
    const { p, cart } = await newOrder();
    let r = await click(bot, user, chat, cart, "مرحله بعد: اطلاعات مشتری ➡️");
    const id = view(await bot.sendMessage(user, chat, "۲۰۲"));
    const retained = await back(id);
    expect(retained.text).toContain("× 2");
    const label = retained.keyboard!.inline!.flat().find((b) => b.text.startsWith("✏️"))!.text;
    r = await click(bot, user, chat, retained, label);
    const typed = view(await bot.sendMessage(user, chat, "۳"));
    r = await back(typed);
    expect(r.text).toContain("× 3");
    r = await click(bot, user, chat, r, "مرحله بعد: اطلاعات مشتری ➡️");
    expect(r.text).toContain("مقدار: 202");
    r = await next(r);
    expect(r.text).toContain("نام کامل");
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(10);
    await click(bot, user, chat, r, "✖️ انصراف");
    expect(await t.db.select().from(orders)).toHaveLength(0);
  });
  it("retains a pending quantity when navigating back to product selection", async () => {
    await createProduct();
    const select = view(await bot.clickButton(user, chat, "o:new"));
    const quantity = await choose(bot, user, chat, select, `${testProduct.name} | موجودی 10`);
    expect(quantity.text).toContain("تعداد •");
    const typed = view(await bot.sendMessage(user, chat, "۴"));
    const backToProduct = await back(typed);
    expect(backToProduct.text).toContain("انتخاب کالا");
    const restored = await next(backToProduct);
    expect(restored.text).toContain("مقدار: 4");
    const cart = await next(restored);
    expect(cart.text).toContain("× 4");
  });
  it("clears only customer-dependent values when the customer ID intentionally changes", async () => {
    const { cart } = await newOrder();
    await click(bot, user, chat, cart, "مرحله بعد: اطلاعات مشتری ➡️");
    await field(bot, user, chat, "۲۰۲");
    const old = view(await bot.sendMessage(user, chat, "مشتری قبلی"));
    const id = await back(old);
    expect(id.text).toContain("202");
    const name = await field(bot, user, chat, "۲۰۳");
    expect(name.text).not.toContain("مشتری قبلی");
    expect(name.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
  });
  it("allows removing every cart line, disables checkout and preserves cart totals", async () => {
    const { cart } = await newOrder();
    const empty = await click(bot, user, chat, cart, "🗑 حذف قلم");
    expect(empty.text).toContain("سبد خالی");
    expect(empty.getInlineButton("مرحله بعد: اطلاعات مشتری ➡️")).toMatchObject({ disabled: {} });
    expect(await t.db.select().from(orders)).toHaveLength(0);
  });
  it("refreshes cart quotes only by explicit action and blocks checkout after inventory falls below the draft", async () => {
    const { p, cart } = await newOrder();
    await t.services.products.adjustStock(t.actor.id, p.id, 10, 1, "forms:external-stock");
    const refreshed = await click(bot, user, chat, cart, "🔄 به‌روزکردن قیمت و موجودی");
    expect(refreshed.getInlineButton("مرحله بعد: اطلاعات مشتری ➡️")).toMatchObject({
      disabled: {},
    });
    expect(refreshed.text).toContain("قیمت‌ها به‌روز");
    expect(await t.db.select().from(orders)).toHaveLength(0);
  });
  it("does not silently overwrite changed stock and supports explicit refresh + final review", async () => {
    const p = await createProduct();
    const initial = view(await bot.clickButton(user, chat, `p:stock:${p.id}`));
    const changed = await click(bot, user, chat, initial, "+۱");
    const review = await next(changed);
    await t.services.products.adjustStock(t.actor.id, p.id, 10, 8, "forms:other-stock");
    const denied = await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(denied.text).toContain("موجودی تازه");
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(8);
    const menu = await back(denied);
    const refreshed = await click(bot, user, chat, menu, "🔄 موجودی تازه");
    const plus = await click(bot, user, chat, refreshed, "+۱");
    await click(bot, user, chat, await next(plus), "✅ تأیید نهایی");
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(9);
  });
  it("returns from manual stock entry to buttons with the valid draft retained", async () => {
    const p = await createProduct();
    const initial = view(await bot.clickButton(user, chat, `p:stock:${p.id}`));
    await click(bot, user, chat, initial, "⌨️ ورود عددی");
    const typed = view(await bot.sendMessage(user, chat, "۷"));
    const menu = await back(typed);
    expect(menu.text).toContain("موجودی پیشنهادی: 7");
    expect((await t.services.products.get(t.actor.id, p.id)).stockQuantity).toBe(10);
  });
  it("recomputes conditional shipping fields while retaining unrelated fields on Back", async () => {
    const p = await createProduct();
    const o = await t.services.orders.create(
      t.actor.id,
      { customer, items: [{ productId: p.id, quantity: 1, expectedUnitPrice: testProduct.price }] },
      "forms:order",
    );
    const start = view(await bot.clickButton(user, chat, `sh:edit:${o.id}`));
    const company = await choose(bot, user, chat, start, "سایر شرکت‌ها");
    expect(company.text).toContain("نام شرکت حمل");
    const code = await field(bot, user, chat, "حمل سفارشی");
    expect(code.text).toContain("کد رهگیری");
    const typed = view(await bot.sendMessage(user, chat, "00Ab0091"));
    const again = await back(typed);
    expect(again.text).toContain("حمل سفارشی");
    const retained = await next(again);
    expect(retained.text).toContain("00Ab0091");
    const carrier = await back(await back(retained));
    const optional = await choose(bot, user, chat, carrier, "تحویل حضوری");
    expect(optional.text).not.toContain("00Ab0091");
    expect(optional.getInlineButton("مرحله بعد ➡️")).toHaveProperty("callback_data");
    const review = await fillShipping(bot, user, chat, optional);
    await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(await t.services.shipments.get(t.actor.id, o.id)).toMatchObject({
      carrier: "pickup",
      carrierName: "",
      trackingNumber: null,
    });
  });
  it.each(["p:categoryAdd", "u:add", "s:edit"])(
    "cancels %s without persisting target business data",
    async (callback) => {
      await bot.clickButton(user, chat, callback);
      const draft = view(
        await bot.sendMessage(user, chat, callback === "u:add" ? "۷۰۱" : "پیش‌نویس آزمایشی"),
      );
      await click(bot, user, chat, draft, "✖️ انصراف");
      expect(await t.db.select().from(categories)).toHaveLength(0);
      expect(await t.db.select().from(storeSettings)).toHaveLength(0);
      expect(await t.db.select().from(users).where(eq(users.telegramId, 701))).toHaveLength(0);
      expect(await t.db.select().from(botConversations)).toHaveLength(0);
    },
  );
  it("clears nullable product fields explicitly without affecting unrelated properties", async () => {
    const p = await t.services.products.create(
      t.actor.id,
      { ...testProduct, description: "توضیح قدیمی", imageUrl: "https://example.com/photo.jpg" },
      "forms:nullable",
    );
    for (const label of ["توضیحات", "لینک تصویر"]) {
      const initial = view(await bot.clickButton(user, chat, `p:edit:${p.id}`));
      const value = await choose(bot, user, chat, initial, label);
      const cleared = await click(bot, user, chat, value, "⏭ پاک‌کردن مقدار");
      expect(cleared.text).toContain("خالی / ندارد");
      await click(bot, user, chat, await next(cleared), "✅ تأیید نهایی");
    }
    expect(await t.services.products.get(t.actor.id, p.id)).toMatchObject({
      description: null,
      imageUrl: null,
      stockQuantity: 10,
      price: testProduct.price,
    });
  });
  it("merges a repeated product into one cart line and retains an unfinished added item through Back", async () => {
    const { cart } = await newOrder();
    const product = await click(bot, user, chat, cart, "➕ افزودن کالای دیگر");
    const quantity = await choose(bot, user, chat, product, `${testProduct.name} | موجودی 10`);
    expect(quantity.text).toContain("تعداد •");
    const typed = view(await bot.sendMessage(user, chat, "۳"));
    const select = await back(typed);
    const originalCart = await back(select);
    expect(originalCart.text).toContain("× 2");
    const pending = await click(bot, user, chat, originalCart, "➕ افزودن کالای دیگر");
    const restored = await next(pending);
    expect(restored.text).toContain("مقدار: 3");
    const merged = await next(restored);
    expect(merged.text).toContain("× 5");
    expect(merged.keyboard!.inline!.flat().filter((b) => b.text.startsWith("✏️"))).toHaveLength(1);
    expect(await t.db.select().from(orders)).toHaveLength(0);
  });
  it("ignores a forged selection of an out-of-stock product", async () => {
    await t.services.products.create(
      t.actor.id,
      { ...testProduct, stockQuantity: 0 },
      "forms:empty",
    );
    const select = view(await bot.clickButton(user, chat, "o:new"));
    const product = select.keyboard!.inline!.flat().find((b) => b.text.includes(testProduct.name))!;
    expect(product).toMatchObject({ disabled: {} });
    expect(product).not.toHaveProperty("callback_data");
    const rejected = await forged(select, "o0");
    expect(rejected.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
    expect(await t.db.select().from(orders)).toHaveLength(0);
  });
  it("invalidates an old valid value after malformed input until it is corrected or Back restores the prior draft", async () => {
    const p = await createProduct();
    const start = view(await bot.clickButton(user, chat, `p:edit:${p.id}`));
    await choose(bot, user, chat, start, "قیمت فروش");
    const invalid = view(await bot.sendMessage(user, chat, "-100"));
    expect(invalid.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
    const properties = await back(invalid);
    const restored = await next(properties);
    expect(restored.text).toContain(String(testProduct.price));
    expect(restored.getInlineButton("مرحله بعد ➡️")).toHaveProperty("callback_data");
  });
  it("resumes a populated form after restart, including backwards navigation and retained later fields", async () => {
    await bot.clickButton(user, chat, "p:add");
    await field(bot, user, chat, "محصول پایدار");
    const price = await field(bot, user, chat, "PERSIST-01");
    const typed = view(await bot.sendMessage(user, chat, "۲۳۰۰۰"));
    expect(price.text).toContain("قیمت");
    bot.dispose();
    install();
    for (let i = 0; i < 100; i++) bot.server.getNextUpdateId();
    const sku = await back(typed);
    expect(sku.text).toContain("PERSIST-01");
    const restored = await next(sku);
    expect(restored.text).toContain("23000");
    expect(await t.db.select().from(products)).toHaveLength(0);
  });
});

describe("scoped callbacks, disabled-action enforcement and reliability", () => {
  it.each(["next", "yes", "back", "o999"])(
    "does not accept forged %s on an empty first field",
    async (action) => {
      const start = view(await bot.clickButton(user, chat, "p:add"));
      const rejected = await forged(start, action);
      expect(rejected.text).toContain("ابتدا مقدار معتبر");
      expect(rejected.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
      expect(await t.db.select().from(products)).toHaveLength(0);
    },
  );
  it("rejects stale Next and stale Cancel without consuming the current step", async () => {
    await bot.clickButton(user, chat, "p:add");
    const typed = view(await bot.sendMessage(user, chat, "کالای سالم"));
    const sku = await next(typed);
    expect((await click(bot, user, chat, typed, "مرحله بعد ➡️")).callbackAnswer?.text).toContain(
      "مرحلهٔ جاری",
    );
    expect((await click(bot, user, chat, typed, "✖️ انصراف")).callbackAnswer?.text).toContain(
      "مرحلهٔ جاری",
    );
    const cancelled = await click(bot, user, chat, sku, "✖️ انصراف");
    expect(cancelled.text).toContain("لغو شد");
  });
  it("binds callbacks to their exact message, not just a matching nonce", async () => {
    const start = view(await bot.clickButton(user, chat, "p:add"));
    const result = await forged(start, "cancel", start.messages.at(-1)!.message_id + 999);
    expect(result.callbackAnswer?.text).toContain("مرحلهٔ جاری");
    expect(await t.db.select().from(botConversations)).toHaveLength(1);
    await click(bot, user, chat, start, "✖️ انصراف");
  });
  it("does not let a delayed older text overwrite a newer draft or become the next field", async () => {
    await bot.clickButton(user, chat, "p:add");
    const delayed = bot.server.simulateUserMessage(user, chat, "نام قدیمی");
    const newer = view(await bot.sendMessage(user, chat, "نام جدید"));
    const before = bot.getApiCalls().length;
    await bot.handleUpdate(delayed);
    expect(
      bot
        .getApiCalls()
        .slice(before)
        .some(
          (call) =>
            call.method === "sendMessage" && String(call.payload.text).includes("خارج از ترتیب"),
        ),
    ).toBe(true);
    const sku = await next(newer);
    const name = await back(sku);
    expect(name.text).toContain("نام جدید");
    expect(name.text).not.toContain("نام قدیمی");
    expect(await t.db.select().from(products)).toHaveLength(0);
  });
  it("requires a valid selection before Next and rejects a forged disabled/out-of-range selection", async () => {
    const p = await createProduct();
    const initial = view(await bot.clickButton(user, chat, `p:edit:${p.id}`));
    const rejected = await forged(initial, "o999");
    expect(rejected.text).toContain("گزینه‌های فعال");
    const noSkip = await forged(rejected, "next");
    expect(noSkip.getInlineButton("مرحله بعد ➡️")).toMatchObject({ disabled: {} });
    expect((await t.services.products.get(t.actor.id, p.id)).price).toBe(testProduct.price);
  });
  it("acknowledges a permission denial once and deduplicates it even after a later grant", async () => {
    await t.db.update(users).set({ role: "viewer" }).where(eq(users.id, t.actor.id));
    const update = bot.server.simulateCallbackQuery(user, chat, "p:add");
    await bot.handleUpdate(update);
    expect(await t.db.select().from(processedUpdates)).toHaveLength(1);
    const count = bot.getApiCalls().length;
    await t.db.update(users).set({ role: "admin" }).where(eq(users.id, t.actor.id));
    await bot.handleUpdate(update);
    expect(bot.getApiCalls()).toHaveLength(count);
    expect(await t.db.select().from(botConversations)).toHaveLength(0);
  });
  it("rechecks authorization at final confirmation and cannot create a product after revocation", async () => {
    const review = await productReview();
    await t.db.update(users).set({ role: "viewer" }).where(eq(users.id, t.actor.id));
    const denied = await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(denied.callbackAnswer?.text).toContain("اجازه");
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(await t.db.select().from(inventoryLogs)).toHaveLength(0);
  });
  it("treats replayed final buttons as expired, never a second business mutation", async () => {
    const review = await productReview();
    await click(bot, user, chat, review, "✅ تأیید نهایی");
    const old = await click(bot, user, chat, review, "✅ تأیید نهایی");
    expect(old.callbackAnswer?.text).toContain("منقضی");
    expect(await t.db.select().from(products)).toHaveLength(1);
    expect(await t.db.select().from(mutationKeys)).toHaveLength(1);
  });
  it("falls back to a fresh panel if editing the old message fails permanently", async () => {
    await bot.clickButton(user, chat, "p:add");
    const typed = view(await bot.sendMessage(user, chat, "پیام نمونه"));
    await bot.api.deleteMessage(chat.id, typed.messages.at(-1)!.message_id);
    const sku = await next(typed);
    expect(sku.text).toContain("SKU یکتا");
    expect(sku.messages.at(-1)?.message_id).not.toBe(typed.messages.at(-1)?.message_id);
    expect((await click(bot, user, chat, typed, "✖️ انصراف")).callbackAnswer?.text).toContain(
      "مرحلهٔ جاری",
    );
  });
  it("uses native styles and 128-bit nonces, with sole-action disabled buttons and bounded callbacks", async () => {
    const initial = view(await bot.clickButton(user, chat, "p:add"));
    const cancel = initial.getInlineButton("✖️ انصراف")!;
    expect(cancel).toMatchObject({ style: "danger" });
    if (!("callback_data" in cancel)) throw new Error("No callback");
    expect(cancel.callback_data.split(":")[2]).toHaveLength(22);
    const typed = view(await bot.sendMessage(user, chat, "کالای رنگی"));
    expect(typed.getInlineButton("مرحله بعد ➡️")).toMatchObject({ style: "primary" });
    const actionKeys = [
      "callback_data",
      "url",
      "copy_text",
      "web_app",
      "switch_inline_query",
      "switch_inline_query_current_chat",
      "callback_game",
      "pay",
    ];
    for (const response of [initial, typed])
      for (const button of response.keyboard!.inline!.flat()) {
        if ("disabled" in button) expect(actionKeys.filter((k) => k in button)).toEqual([]);
        if ("callback_data" in button)
          expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      }
  });
  it("also applies the replay budget to discarded out-of-order updates", async () => {
    for (let i = 0; i < 1000; i++) bot.server.getNextUpdateId();
    await bot.clickButton(user, chat, "p:add");
    for (let i = 1; i <= MAX_WIZARD_EVENTS + 1; i++) {
      bot.advanceTime(1);
      const delayed = bot.server.simulateUserMessage(user, chat, "قدیمی");
      delayed.update_id = i;
      await bot.handleUpdate(delayed);
    }
    expect(await t.db.select().from(botConversations)).toHaveLength(0);
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(
      bot
        .getApiCalls()
        .some(
          (call) =>
            call.method === "sendMessage" && String(call.payload.text).includes("سقف ۳۰۰ تعامل"),
        ),
    ).toBe(true);
  }, 60000);
  it("bounds an abusive replay session and closes without business writes", async () => {
    await bot.clickButton(user, chat, "p:add");
    let last: BotResponse | undefined;
    for (let i = 0; i <= MAX_WIZARD_EVENTS; i++) {
      bot.advanceTime(1);
      last = await bot.sendMessage(user, chat, "x");
    }
    expect(last?.text).toContain("سقف ۳۰۰ تعامل");
    expect(await t.db.select().from(botConversations)).toHaveLength(0);
    expect(await t.db.select().from(products)).toHaveLength(0);
  }, 60000);
});
