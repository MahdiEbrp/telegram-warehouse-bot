import type { MiddlewareFn } from "grammy";
import type { Services } from "@/db/queries";
import type { BotContext } from "@/types/bot";
import { authorize, callbackPermission } from "@/lib/permissions";

export function authentication(services: Services): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.from) return;
    if (ctx.chat?.type !== "private") {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({
          text: "این بات فقط در گفت‌وگوی خصوصی قابل استفاده است.",
          show_alert: true,
        });
      else await ctx.reply("🔒 برای حفظ اطلاعات فروشگاه، بات را در گفت‌وگوی خصوصی باز کنید.");
      return;
    }
    ctx.services = services;
    ctx.principal = await services.users.authenticate(ctx.from);
    if (!ctx.principal.isActive) {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({ text: "حساب شما فعال نیست.", show_alert: true });
      else
        await ctx.reply(
          `⏳ دسترسی شما هنوز فعال نشده است. شناسهٔ تلگرام شما: ${ctx.from.id}\nاز مدیرکل بخواهید حساب شما را فعال کند.`,
        );
      return;
    }
    await next();
  };
}
export const permissionGuard: MiddlewareFn<BotContext> = async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  const required = data ? callbackPermission(data) : undefined;
  if (required) authorize(ctx.principal.role, required);
  await next();
};
