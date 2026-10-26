import { createHash } from "node:crypto";
import { InlineKeyboard, InputFile, type Bot } from "grammy";
import type { BotContext } from "@/types/bot";
import { orderListFilters, shipmentStates } from "@/types/domain";
import { exportOptions } from "@/db/queries/exports";
import { shipmentWorkbook } from "@/lib/xlsx";
import { shipmentStateLabels } from "@/lib/shipping";
import { backHome } from "@/bot/keyboards/common";
import { z } from "zod";

const filterLabels = {
  all: "همه سفارشات",
  ready: "صف آماده‌سازی ارسال",
  shipped: "کل سفارش ارسال‌شده",
  untracked: "قدیمی بدون اطلاعات ارسال",
} as const;
export function registerExports(bot: Bot<BotContext>) {
  bot.callbackQuery("exp:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    for (const filter of orderListFilters)
      keyboard.text(filterLabels[filter], `exp:state:${filter}`).row();
    await ctx.reply(
      "📊 خروجی Excel مرسوله‌ها\nفقط مدیر/مدیرکل. فایل حاوی اطلاعات حساس مشتری است؛ آن را عمومی نکنید.\nفیلتر سفارش را انتخاب کنید.",
      { reply_markup: backHome(keyboard) },
    );
  });
  bot.callbackQuery(/^exp:state:([a-z]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const filter = z.enum(orderListFilters).parse(ctx.match[1]);
    const keyboard = new InlineKeyboard()
      .text("همه وضعیت‌های مرسوله", `exp:period:${filter}:all`)
      .row();
    if (filter !== "untracked")
      for (const state of shipmentStates)
        keyboard.text(shipmentStateLabels[state], `exp:period:${filter}:${state}`).row();
    await ctx.reply(
      "وضعیت مرسوله‌های خروجی را انتخاب کنید. سفارش چندمرسوله‌ای ممکن است در چند ردیف بیاید.",
      { reply_markup: backHome(keyboard) },
    );
  });
  bot.callbackQuery(/^exp:period:([a-z]+):([a-z]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const options = exportOptions.parse({
      filter: ctx.match[1],
      state: ctx.match[2],
      period: "all",
    });
    const prefix = `exp:run:${options.filter}:${options.state}`;
    await ctx.reply(
      "بازهٔ تاریخ ایجاد سفارش را انتخاب کنید (نه تاریخ ارسال). سقف هر فایل ۱۰۰۰ ردیف است؛ خروجی ناقص/بریده صادر نمی‌شود.",
      {
        reply_markup: backHome(
          new InlineKeyboard()
            .text("همه تاریخ‌ها", `${prefix}:all`)
            .row()
            .text("امروز", `${prefix}:day`)
            .row()
            .text("ماه جاری میلادی", `${prefix}:month`),
        ),
      },
    );
  });
  bot.callbackQuery(/^exp:run:([a-z]+):([a-z]+):([a-z]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const options = exportOptions.parse({
      filter: ctx.match[1],
      state: ctx.match[2],
      period: ctx.match[3],
    });
    const data = await ctx.services.exports.shipments(ctx.principal.id, options);
    const bytes = shipmentWorkbook(data);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const orders = new Set(data.rows.map((row) => row.orderId)).size;
    await ctx.services.exports.recordGeneration(
      ctx.principal.id,
      { options, rows: data.rows.length, orders, bytes: bytes.byteLength, sha256 },
      `update:${ctx.update.update_id}:export:${sha256}`,
      ctx.lease,
    );
    await ctx.replyWithDocument(
      new InputFile(
        bytes,
        `shipments-${data.generatedAt.toISOString().slice(0, 10)}-${options.filter}-${options.state}.xlsx`,
      ),
      {
        caption: `📊 ${data.rows.length} ردیف | ${orders} سفارش\nهر مرسوله یک ردیف؛ هزینهٔ حمل داخلی است. فایل محرمانهٔ کارکنان است.\nSHA256: ${sha256}`,
      },
    );
  });
}
