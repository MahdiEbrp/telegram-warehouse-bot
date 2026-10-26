import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TestBot, type BotResponse } from "@bonkers-agency/grammy-test";
import { configureBot } from "../src/bot/factory";
import type { BotContext } from "../src/types/bot";
import { testDatabase, testProduct } from "../src/tests/helpers/database";
import { choose, click, field, view } from "../src/tests/helpers/telegram";
const t = await testDatabase(),
  originalFetch = globalThis.fetch;
let attempts = 0;
globalThis.fetch = async () => {
  attempts++;
  throw new Error("No real API in UI preview capture");
};
const bot = configureBot(new TestBot<BotContext>(), {
  db: t.db,
  services: t.services,
  timeZone: "Asia/Tehran",
  conversationVersion: "4",
});
try {
  await t.services.products.create(t.actor.id, { ...testProduct, stockQuantity: 20 }, "ui:product");
  await t.services.products.createCategory(t.actor.id, "پوشاک و کفش", null, "ui:category");
  const user = bot.createUser({ id: 101, first_name: "مدیر نمایش" }),
    chat = bot.createChat({ id: 101, type: "private" });
  const shots: { id: string; title: string; note: string; text: string; keyboard: unknown }[] = [];
  function capture(id: string, title: string, note: string, response: BotResponse) {
    const r = view(response);
    assert(r.text);
    shots.push({ id, title, note, text: r.text, keyboard: r.keyboard?.inline ?? [] });
    return r;
  }
  const next = (r: BotResponse) => click(bot, user, chat, r, "مرحله بعد ➡️");
  capture(
    "dashboard",
    "داشبورد مدیرکل",
    "نمایش نقش، شروع سریع و بخش‌های مجاز؛ این رندر از pipeline واقعی بات در TestBot ثبت شده است.",
    await bot.sendCommand(user, chat, "/start"),
  );
  let r = capture(
    "field-empty",
    "یک فیلد در هر مرحله",
    "در اولین مرحله، قبلی و بعدی غیرفعال‌اند. هنوز داده‌ای ثبت نشده است.",
    await bot.clickButton(user, chat, "p:add"),
  );
  r = capture(
    "field-valid",
    "مقدار معتبر، بدون پرش خودکار",
    "نوشتن نام فقط پیش‌نویس را تغییر می‌دهد؛ بعدی اکنون فعال است.",
    await bot.sendMessage(user, chat, "کفش روزمره"),
  );
  r = capture(
    "sku",
    "مرحله دوم: SKU",
    "ناوبری دکمه‌ای است؛ مقدار متنی فقط برای همین فیلد دریافت می‌شود.",
    await next(r),
  );
  await field(bot, user, chat, "shoe-۱۲");
  r = capture(
    "price",
    "قیمت با ارقام فارسی",
    "اعداد فارسی و جداکنندهٔ هزارگان به عدد صحیح تومان تبدیل می‌شوند.",
    await bot.sendMessage(user, chat, "۲۵۰٬۰۰۰"),
  );
  await next(r);
  r = await field(bot, user, chat, "۱۲");
  r = capture(
    "category-selected",
    "گزینه انتخاب شد؛ بعدی جداگانه",
    "علامت ✓ فقط انتخاب را نشان می‌دهد؛ دکمهٔ بعدی مرحله را عوض می‌کند.",
    await click(bot, user, chat, r, "پوشاک و کفش"),
  );
  r = capture(
    "review",
    "مرور نهایی قبل از ثبت",
    "همهٔ فیلدهای فرم در خلاصه دیده می‌شوند؛ تأیید سبز تنها نقطهٔ ثبت است.",
    await next(r),
  );
  r = await click(bot, user, chat, r, "⬅️ مرحله قبل");
  r = capture(
    "retained-stock",
    "قبلی، با مقدار محفوظ",
    "بازگشت از مرور به دسته و سپس موجودی؛ عدد ۱۲ دوباره تایپ نشده است.",
    await click(bot, user, chat, r, "⬅️ مرحله قبل"),
  );
  await click(bot, user, chat, r, "✖️ انصراف");
  r = await bot.clickButton(user, chat, "o:new");
  const product = r.keyboard!.inline!.flat().find((b) => b.text.includes(testProduct.name))!;
  await choose(bot, user, chat, r, product.text);
  r = await field(bot, user, chat, "۲");
  r = capture(
    "cart",
    "سبد چندقلمی",
    "ویرایش تعداد، حذف قلم و تازه‌سازی قیمت/موجودی؛ این سبد هنوز رزرو نشده است.",
    r,
  );
  r = await click(bot, user, chat, r, "مرحله بعد: اطلاعات مشتری ➡️");
  r = capture(
    "customer",
    "اطلاعات مشتری، یک فیلد",
    "نام، تلفن و نشانی در مرحله‌های جدا دریافت می‌شوند؛ مشتری حساب کارکنان فعال نمی‌گیرد.",
    r,
  );
  r = capture(
    "cart-back",
    "بازگشت واقعی به همان سبد",
    "دکمهٔ قبلی سبد را از اول نمی‌سازد؛ همان اقلام و تعداد نگه داشته شده‌اند.",
    await click(bot, user, chat, r, "⬅️ مرحله قبل"),
  );
  await click(bot, user, chat, r, "✖️ انصراف");
  await t.services.users.save(
    t.actor.id,
    { telegramId: 303, firstName: "همکار مشاهده‌گر", role: "viewer", isActive: true },
    "ui:viewer",
  );
  const viewer = bot.createUser({ id: 303, first_name: "همکار مشاهده‌گر" }),
    viewerChat = bot.createChat({ id: 303, type: "private" });
  capture(
    "viewer",
    "داشبورد متناسب با نقش",
    "مشاهده‌گر دکمهٔ ساخت سفارش، مدیریت کاربران یا تنظیمات ندارد؛ مخفی‌سازی جایگزین RBAC سمت سرور نیست.",
    await bot.sendCommand(viewer, viewerChat, "/start"),
  );
  assert.equal(attempts, 0);
  await mkdir("docs/verification", { recursive: true });
  const data = {
    notice: "Offline synthetic captures, not actual Telegram client screenshots",
    release: "1.3.0",
    realNetworkAttempts: attempts,
    shots,
  };
  await writeFile("docs/verification/ui-transcript.json", JSON.stringify(data, null, 2) + "\n");
  const template = await readFile(new URL("./ui-template.html", import.meta.url), "utf8");
  await writeFile(
    "docs/ui-preview.html",
    template.replace("__UI_DATA__", JSON.stringify(data).replaceAll("<", "\\u003c")),
  );
  console.log(
    `Captured ${shots.length} real offline bot responses → docs/ui-preview.html; real API requests: ${attempts}`,
  );
} finally {
  bot.dispose();
  globalThis.fetch = originalFetch;
  t.close();
}
