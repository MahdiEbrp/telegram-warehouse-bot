import { conversations, createConversation } from "@grammyjs/conversations";
import type { Bot } from "grammy";
import type { Database } from "@/db/client";
import type { Services } from "@/db/queries";
import type { BotContext, InnerContext } from "@/types/bot";
import { errorBoundary, trackCallbackAnswers } from "./middleware/errors";
import { reliability } from "./middleware/reliability";
import { authentication, permissionGuard } from "./middleware/auth";
import { conversationStorage } from "./middleware/storage";
import { productAdd } from "./scenes/product-add";
import { productEdit } from "./scenes/product-edit";
import { stockAdjust } from "./scenes/stock-adjust";
import { orderCreate } from "./scenes/order-create";
import { orderSearch } from "./scenes/order-search";
import { shipmentEdit, shipmentClear } from "./scenes/shipment-edit";
import { registerShipping } from "./handlers/shipping";
import { registerExports } from "./handlers/exports";
import { userAdd, categoryAdd, settingsEdit, productSearch } from "./scenes/administration";
import { registerMain, showDashboard } from "./handlers/main";
import { registerProducts } from "./handlers/products";
import { registerOrders } from "./handlers/orders";
import { registerReports } from "./handlers/reports";
import { registerAdministration } from "./handlers/administration";

export function configureBot<T extends Bot<BotContext>>(
  bot: T,
  config: { db: Database; services: Services; timeZone: string; conversationVersion: string },
): T {
  bot.use(errorBoundary);
  bot.use(trackCallbackAnswers);
  bot.use(reliability(config.db));
  bot.use(authentication(config.services));
  bot.use(permissionGuard);
  bot.use(
    conversations<BotContext, InnerContext>({
      // A code-level revision invalidates old form replay even if the old env version is unchanged.
      storage: conversationStorage(config.db, `${config.conversationVersion}:forms-v3`),
    }),
  );
  const options = { maxMillisecondsToWait: 30 * 60_000 };
  // Explicit IDs must not depend on minified function names in production builds.
  bot.use(createConversation(productAdd, { ...options, id: "productAdd" }));
  bot.use(createConversation(productEdit, { ...options, id: "productEdit" }));
  bot.use(createConversation(stockAdjust, { ...options, id: "stockAdjust" }));
  bot.use(createConversation(orderCreate, { ...options, id: "orderCreate" }));
  bot.use(createConversation(userAdd, { ...options, id: "userAdd" }));
  bot.use(createConversation(categoryAdd, { ...options, id: "categoryAdd" }));
  bot.use(createConversation(settingsEdit, { ...options, id: "settingsEdit" }));
  bot.use(createConversation(productSearch, { ...options, id: "productSearch" }));
  bot.use(createConversation(orderSearch, { ...options, id: "orderSearch" }));
  bot.use(createConversation(shipmentEdit, { ...options, id: "shipmentEdit" }));
  bot.use(createConversation(shipmentClear, { ...options, id: "shipmentClear" }));
  registerMain(bot);
  registerProducts(bot);
  registerOrders(bot);
  registerShipping(bot, config.timeZone);
  registerExports(bot);
  registerReports(bot, config.timeZone);
  registerAdministration(bot, config.timeZone);
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "دکمه نامعتبر یا منقضی شده است. از منوی اصلی ادامه دهید.",
    });
    await showDashboard(ctx);
  });
  bot.on("message", async (ctx) => {
    await ctx.reply("از دکمه‌ها استفاده کنید؛ تنها دستور بات /start است.");
    await showDashboard(ctx);
  });
  return bot;
}
