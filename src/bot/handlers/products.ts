import { clipText } from "@/lib/text";
import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext } from "@/types/bot";
import { can } from "@/lib/permissions";
import { money } from "@/lib/money";
import { addPager, backHome } from "@/bot/keyboards/common";

export async function showProductList(ctx: BotContext, pageNumber = 0) {
  const page = await ctx.services.products.list(ctx.principal.id, pageNumber);
  const k = new InlineKeyboard();
  for (const p of page.items)
    k.text(`📦 ${clipText(p.name, 40)} | ${p.stockQuantity}`, `p:view:${p.id}`).row();
  if (can(ctx.principal.role, "products:write"))
    k.text("➕ افزودن محصول", "p:add").row().text("🗂 دسته‌بندی‌ها", "p:categories:0").row();
  k.text("🔎 جستجوی نام / SKU", "p:search");
  addPager(k, page, "p:list");
  backHome(k);
  await ctx.reply(
    `📦 فهرست محصولات فعال — ${page.total} محصول\n${page.items.length ? "برای مشاهدهٔ مشخصات، محصول را انتخاب کنید." : "هنوز محصولی ثبت نشده است."}`,
    { reply_markup: k },
  );
}
export async function showProduct(ctx: BotContext, id: string) {
  const p = await ctx.services.products.get(ctx.principal.id, id);
  const k = new InlineKeyboard();
  const writable = can(ctx.principal.role, "products:write");
  if (p.isActive && writable) k.text("✏️ ویرایش مشخصات", `p:edit:${id}`).row();
  if (p.isActive && can(ctx.principal.role, "inventory:write"))
    k.text("🔢 تنظیم موجودی", `p:stock:${id}`).row();
  if (p.isActive && writable) k.text("🗑 حذف / بایگانی", `p:archive:${id}`).row();
  k.text("⬅️ فهرست محصولات", "p:list:0");
  backHome(k);
  await ctx.reply(
    `📦 ${p.name}\nSKU: ${p.sku}\nقیمت فروش: ${money(p.price)}${writable ? `\nبهای خرید: ${money(p.costPrice)}` : ""}\nموجودی: ${p.stockQuantity}\nحداقل موجودی: ${p.minStockLevel}\nوضعیت: ${p.isActive ? "فعال" : "بایگانی"}\n${p.description ?? ""}${p.imageUrl ? `\nتصویر: ${p.imageUrl}` : ""}`,
    { reply_markup: k, link_preview_options: { is_disabled: true } },
  );
}
export function registerProducts(bot: Bot<BotContext>) {
  bot.callbackQuery(/^p:list:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProductList(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^p:view:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProduct(ctx, ctx.match[1]!);
  });
  bot.callbackQuery("p:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("productAdd");
  });
  bot.callbackQuery("p:search", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("productSearch");
  });
  bot.callbackQuery(/^p:edit:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("productEdit", ctx.match[1]!);
  });
  bot.callbackQuery(/^p:stock:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("stockAdjust", ctx.match[1]!);
  });
  bot.callbackQuery(/^p:archive:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const p = await ctx.services.products.get(ctx.principal.id, id);
    await ctx.reply(`محصول «${p.name}» بایگانی شود؟ سابقهٔ سفارش و گردش انبار حذف نمی‌شود.`, {
      reply_markup: backHome(
        new InlineKeyboard()
          .text("✅ بایگانی", `p:archiveYes:${id}`)
          .row()
          .text("↩️ بازگشت", `p:view:${id}`),
      ),
    });
  });
  bot.callbackQuery(/^p:archiveYes:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.services.products.archive(
      ctx.principal.id,
      ctx.match[1]!,
      `update:${ctx.update.update_id}:archive`,
      ctx.lease,
    );
    await ctx.reply("✅ محصول بایگانی شد.");
    await showProductList(ctx);
  });
  bot.callbackQuery(/^p:categories:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = await ctx.services.products.categories(ctx.principal.id, Number(ctx.match[1]));
    const k = new InlineKeyboard().text("➕ دسته‌بندی جدید", "p:categoryAdd");
    addPager(k, page, "p:categories");
    backHome(k);
    await ctx.reply(
      `🗂 دسته‌بندی‌ها — ${page.total} مورد\n${page.items.map((c) => `• ${c.name}${c.parentId ? " (زیرگروه)" : ""}`).join("\n") || "دسته‌بندی موجود نیست."}`,
      { reply_markup: k },
    );
  });
  bot.callbackQuery("p:categoryAdd", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("categoryAdd");
  });
}
