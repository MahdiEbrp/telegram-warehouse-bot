import { clipText } from "@/lib/text";
import { InlineKeyboard, type Bot } from "grammy";
import { z } from "zod";
import type { BotContext } from "@/types/bot";
import { roles } from "@/types/domain";
import { roleLabel } from "@/bot/labels";
import { addPager, backHome } from "@/bot/keyboards/common";
import { dateLabel } from "@/lib/time";

async function showUser(ctx: BotContext, id: string) {
  const user = await ctx.services.users.get(ctx.principal.id, id);
  await ctx.reply(
    `👤 ${user.firstName}\nشناسه تلگرام: ${user.telegramId}\nنقش: ${roleLabel[user.role]}\nوضعیت: ${user.isActive ? "فعال" : "غیرفعال"}`,
    {
      reply_markup: backHome(
        new InlineKeyboard()
          .text("🎭 تغییر نقش", `u:role:${id}`)
          .row()
          .text(user.isActive ? "🔒 غیرفعال‌کردن" : "🔓 فعال‌کردن", `u:toggle:${id}`)
          .row()
          .text("⬅️ کاربران", "u:list:0"),
      ),
    },
  );
}
export function registerAdministration(bot: Bot<BotContext>, timeZone: string) {
  bot.callbackQuery(/^u:list:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = await ctx.services.users.list(ctx.principal.id, Number(ctx.match[1]));
    const k = new InlineKeyboard();
    for (const user of page.items)
      k.text(
        `${user.isActive ? "🟢" : "⚪"} ${clipText(user.firstName, 25)} | ${roleLabel[user.role]}`,
        `u:view:${user.id}`,
      ).row();
    k.text("➕ افزودن / فعال‌کردن کاربر", "u:add").row().text("📜 لاگ فعالیت‌ها", "a:list:0");
    addPager(k, page, "u:list");
    backHome(k);
    await ctx.reply(
      `👥 مدیریت کاربران — ${page.total} کاربر\nکاربران ناشناس و مشتریان به‌صورت پیش‌فرض غیرفعال هستند.`,
      { reply_markup: k },
    );
  });
  bot.callbackQuery("u:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("userAdd");
  });
  bot.callbackQuery(/^u:view:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showUser(ctx, ctx.match[1]!);
  });
  bot.callbackQuery(/^u:role:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const user = await ctx.services.users.get(ctx.principal.id, id);
    const k = new InlineKeyboard();
    for (const role of roles) {
      if (role === user.role) k.disabled(`${roleLabel[role]} ✓`).row();
      else k.text(roleLabel[role], `u:roleYes:${id}:${role}`).row();
    }
    backHome(k);
    await ctx.reply(`نقش جدید ${user.firstName} را انتخاب کنید.`, { reply_markup: k });
  });
  bot.callbackQuery(/^u:roleYes:([a-f0-9-]{36}):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const role = z.enum(roles).parse(ctx.match[2]);
    const user = await ctx.services.users.get(ctx.principal.id, id);
    await ctx.services.users.save(
      ctx.principal.id,
      { telegramId: user.telegramId, firstName: user.firstName, role, isActive: user.isActive },
      `update:${ctx.update.update_id}:role`,
      ctx.lease,
    );
    if (id === ctx.principal.id) {
      await ctx.reply("✅ نقش شما تغییر کرد. از منوی اصلی ادامه دهید.", {
        reply_markup: new InlineKeyboard().text("🏠 منوی اصلی", "m:home"),
      });
      return;
    }
    await showUser(ctx, id);
  });
  bot.callbackQuery(/^u:toggle:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const user = await ctx.services.users.get(ctx.principal.id, id);
    await ctx.reply(`حساب ${user.firstName} ${user.isActive ? "غیرفعال" : "فعال"} شود؟`, {
      reply_markup: backHome(
        new InlineKeyboard()
          .text("✅ تأیید", `u:toggleYes:${id}:${user.isActive ? "0" : "1"}`)
          .row()
          .text("↩️ بازگشت", `u:view:${id}`),
      ),
    });
  });
  bot.callbackQuery(/^u:toggleYes:([a-f0-9-]{36}):([01])$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const user = await ctx.services.users.get(ctx.principal.id, id);
    await ctx.services.users.save(
      ctx.principal.id,
      {
        telegramId: user.telegramId,
        firstName: user.firstName,
        role: user.role,
        isActive: ctx.match[2] === "1",
      },
      `update:${ctx.update.update_id}:active`,
      ctx.lease,
    );
    if (id === ctx.principal.id) {
      await ctx.reply("وضعیت حساب شما تغییر کرد.");
      return;
    }
    await showUser(ctx, id);
  });
  bot.callbackQuery(/^a:list:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = await ctx.services.users.activity(ctx.principal.id, Number(ctx.match[1]));
    const k = new InlineKeyboard();
    addPager(k, page, "a:list");
    backHome(k);
    await ctx.reply(
      `📜 فعالیت‌ها — ${page.total} رویداد\n${page.items.map((log) => `${log.action} | ${log.entityType}\n${log.entityId}\nکاربر: ${log.userTelegramId} | ${dateLabel(log.createdAt, timeZone)}`).join("\n\n") || "رویدادی ثبت نشده است."}`,
      { reply_markup: k },
    );
  });
  bot.callbackQuery("s:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    const value = await ctx.services.settings.get(ctx.principal.id);
    await ctx.reply(
      `⚙️ ${value.name}\nتلفن: ${value.phone || "—"}\nنشانی: ${value.address || "—"}\nراهنمای پرداخت:\n${value.paymentInstructions}\n\nاین نسخه پرداخت آنلاین یا انتقال وجه انجام نمی‌دهد.`,
      {
        reply_markup: backHome(
          new InlineKeyboard().text("✏️ ویرایش اطلاعات / روش‌های پرداخت", "s:edit"),
        ),
      },
    );
  });
  bot.callbackQuery("s:edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("settingsEdit");
  });
}
