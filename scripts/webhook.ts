import "dotenv/config";
import { Bot } from "grammy";
import { getEnv } from "../src/lib/env";
import { logError } from "../src/lib/errors";

try {
  const env = getEnv();
  const bot = new Bot(env.BOT_TOKEN, { client: { timeoutSeconds: 20 } });
  const command = process.argv[2];
  if (command === "set") {
    if (!env.APP_URL) throw new Error("APP_URL is required");
    const url = new URL("/api/telegram/webhook", env.APP_URL).toString();
    await bot.api.setWebhook(url, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      max_connections: env.WEBHOOK_MAX_CONNECTIONS,
      drop_pending_updates: false,
    });
    await bot.api.setMyCommands([{ command: "start", description: "باز کردن منوی اصلی" }]);
    console.log(`Webhook registered: ${url}`);
  } else if (command === "info") {
    const info = await bot.api.getWebhookInfo();
    console.log(
      JSON.stringify(
        {
          url: info.url,
          pending_update_count: info.pending_update_count,
          last_error_date: info.last_error_date,
          last_error_message: info.last_error_message,
          max_connections: info.max_connections,
        },
        null,
        2,
      ),
    );
  } else if (command === "delete") {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log("Webhook removed; pending updates preserved.");
  } else {
    console.error("Usage: npm run webhook:set | webhook:info | webhook:delete");
    process.exitCode = 1;
  }
} catch (error) {
  logError(error);
  console.error(
    "Webhook operation failed. Check .env and connectivity (secrets are never printed).",
  );
  process.exitCode = 1;
}
