import { clipText } from "@/lib/text";
import { GrammyError, type MiddlewareFn } from "grammy";
import { ZodError } from "zod";
import { DomainError, logError } from "@/lib/errors";
import type { BotContext } from "@/types/bot";
import { homeOnly } from "@/bot/keyboards/common";

// Remember acknowledgements made by regular handlers, so an error never answers twice.
export const trackCallbackAnswers: MiddlewareFn<BotContext> = async (ctx, next) => {
  ctx.callbackAnswered = false;
  ctx.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === "answerCallbackQuery") ctx.callbackAnswered = true;
    return result;
  });
  await next();
};

export const errorBoundary: MiddlewareFn<BotContext> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof DomainError || error instanceof ZodError) {
      const text =
        error instanceof DomainError
          ? error.message
          : "ورودی نامعتبر است؛ دوباره از منو شروع کنید.";
      if (ctx.callbackQuery && !ctx.callbackAnswered) {
        try {
          await ctx.answerCallbackQuery({ text: clipText(text, 190), show_alert: true });
        } catch (replyError) {
          logError(replyError, ctx.update.update_id);
        }
      }
      // A handler may already have acknowledged the callback; still show a durable error.
      try {
        await ctx.reply(text, { reply_markup: homeOnly() });
      } catch (replyError) {
        logError(replyError, ctx.update.update_id);
      }
      return;
    }
    // Permanent Telegram errors (blocked bot, deleted message) must not cause infinite retries.
    if (error instanceof GrammyError && [400, 403].includes(error.error_code)) {
      logError(error, ctx.update.update_id);
      return;
    }
    logError(error, ctx.update.update_id);
    throw error; // Transient DB/network/429 errors propagate to webhook => 503 and retry.
  }
};
