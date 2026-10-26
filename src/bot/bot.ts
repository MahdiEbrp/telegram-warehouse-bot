import { Bot } from "grammy";
import { getEnv } from "@/lib/env";
import { getDatabase } from "@/db";
import { createServices } from "@/db/queries";
import type { BotContext } from "@/types/bot";
import { configureBot } from "./factory";

let instance: Promise<Bot<BotContext>> | undefined;
export function getBot(): Promise<Bot<BotContext>> {
  // Lazy initialization: `next build` never needs live secrets, DB, or Telegram.
  if (!instance)
    instance = (async () => {
      const env = getEnv();
      const { db } = await getDatabase();
      const services = createServices(db, {
        bootstrapIds: env.SUPER_ADMIN_TELEGRAM_IDS,
        timeZone: env.STORE_TIMEZONE,
      });
      const bot = new Bot<BotContext>(env.BOT_TOKEN, {
        client: { timeoutSeconds: 10, canUseWebhookReply: () => false },
      });
      return configureBot(bot, {
        db,
        services,
        timeZone: env.STORE_TIMEZONE,
        conversationVersion: env.CONVERSATION_VERSION,
      });
    })().catch((error) => {
      instance = undefined;
      throw error;
    });
  return instance;
}
