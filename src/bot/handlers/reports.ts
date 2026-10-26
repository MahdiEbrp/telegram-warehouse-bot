import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext } from "@/types/bot";
import { money } from "@/lib/money";
import { dateLabel } from "@/lib/time";
import { addPager, backHome } from "@/bot/keyboards/common";

export function registerReports(bot: Bot<BotContext>, timeZone: string) {
  bot.callbackQuery("r:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("📊 گزارش‌ها\nگزارش فروش بر اساس تاریخ ثبت سفارش و وضعیت فعلی پرداخت است.", {
      reply_markup: backHome(
        new InlineKeyboard()
          .text("☀️ فروش امروز", "r:day")
          .text("🗓 فروش این ماه", "r:month")
          .row()
          .text("⚠️ محصولات کم‌موجود", "r:low:0")
          .row()
          .text("🔁 گردش انبار", "r:moves:0"),
      ),
    });
  });
  bot.callbackQuery(/^r:(day|month)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match[1] === "day" ? "day" : "month";
    const report = await ctx.services.reports.sales(ctx.principal.id, kind);
    await ctx.reply(
      `📊 فروش ${kind === "day" ? "امروز" : "ماه جاری میلادی"}\nسفارش‌های پرداخت‌شده و لغونشده، ثبت‌شده در بازه:\n${dateLabel(report.start, timeZone)} تا ${dateLabel(report.end, timeZone)} (انتهای بازه شامل نیست)\nتعداد: ${report.orderCount}\nمبلغ: ${money(report.total)}\nمنطقه زمانی: ${timeZone}`,
      { reply_markup: backHome(new InlineKeyboard().text("⬅️ گزارش‌ها", "r:menu")) },
    );
  });
  bot.callbackQuery(/^r:low:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = await ctx.services.reports.lowStock(ctx.principal.id, Number(ctx.match[1]));
    const k = new InlineKeyboard();
    addPager(k, page, "r:low");
    backHome(k);
    await ctx.reply(
      `⚠️ کم‌موجودها — ${page.total} محصول\n${page.items.map((p) => `${p.name} [${p.sku}]\nموجودی: ${p.stock} | حداقل: ${p.minimum}`).join("\n\n") || "همهٔ محصولات بالاتر از حداقل موجودی هستند."}`,
      { reply_markup: k },
    );
  });
  bot.callbackQuery(/^r:moves:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = await ctx.services.reports.movements(ctx.principal.id, Number(ctx.match[1]));
    const k = new InlineKeyboard();
    addPager(k, page, "r:moves");
    backHome(k);
    await ctx.reply(
      `🔁 گردش انبار — ${page.total} رویداد\n${page.items.map((log) => `${log.productName} | ${log.changeType} | ${log.change > 0 ? "+" : ""}${log.change}\n${log.previousStock} ← ${log.newStock} | کاربر ${log.actorTelegramId}\n${dateLabel(log.createdAt, timeZone)}`).join("\n\n") || "رویدادی وجود ندارد."}`,
      { reply_markup: k },
    );
  });
}
