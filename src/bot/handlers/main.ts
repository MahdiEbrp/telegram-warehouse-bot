import type { Bot } from "grammy";
import type { BotContext } from "@/types/bot";
import { mainKeyboard } from "@/bot/keyboards/main";
import { homeOnly } from "@/bot/keyboards/common";
import { roleLabel } from "@/bot/labels";
import { card } from "@/bot/ui/cards";
export async function showDashboard(ctx: BotContext) {
  await ctx.reply(
    card("🏠 داشبورد انبار و فروش", [
      `👤 ${ctx.principal.firstName}  •  ${roleLabel[ctx.principal.role]}`,
      "\nشروع سریع یا بخش موردنظر را انتخاب کنید.",
      "🧭 فرم‌ها: یک فیلد در هر مرحله؛ قبلی، بعدی و انصراف دکمه‌ای.",
      "🔒 محیط داخلی کارکنان؛ مشتری اعلان یا دسترسی خودکار ندارد.",
    ]),
    { reply_markup: mainKeyboard(ctx.principal.role) },
  );
}
export function registerMain(bot: Bot<BotContext>) {
  bot.command("start", showDashboard);
  bot.callbackQuery("m:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDashboard(ctx);
  });
  bot.callbackQuery("m:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      card("❓ راهنمای استفاده", [
        "۱. از داشبورد یک بخش را انتخاب کنید؛ فقط /start دستور متنی است.",
        "۲. در فرم، فقط مقدار همان فیلد را تایپ یا گزینه را انتخاب کنید.",
        "۳. «مرحله بعد» پس از مقدار معتبر فعال است؛ انتخاب گزینه هم نیاز به بعدی دارد.",
        "۴. «مرحله قبل» مقادیر معتبر را نگه می‌دارد؛ انصراف پیش‌نویس را ثبت نمی‌کند.",
        "۵. در پایان، خلاصه را بررسی و «تأیید نهایی» را بزنید.",
        "\n🛒 سبد: تعداد هر قلم قابل ویرایش/حذف است؛ موجودی فقط با ثبت نهایی رزرو می‌شود.",
        "🚚 ارسال: هر مرسوله وضعیت مستقل دارد؛ ثبت بارکد به‌تنهایی ارسال محسوب نمی‌شود.",
        "📊 Excel: فقط مدیر/مدیرکل، حاوی اطلاعات حساس مشتری.",
        "⏳ نشست بی‌استفاده منقضی می‌شود؛ در صورت خطای دکمهٔ قدیمی، آخرین پیام را باز کنید.",
      ]),
      { reply_markup: homeOnly() },
    );
  });
}
