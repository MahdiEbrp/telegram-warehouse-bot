import { getBot } from "@/bot/bot";
import { getEnv } from "@/lib/env";
import { createWebhookHandler } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
let handle: ReturnType<typeof createWebhookHandler> | undefined;
export async function POST(request: Request): Promise<Response> {
  handle ??= createWebhookHandler({ secret: getEnv().TELEGRAM_WEBHOOK_SECRET, loadBot: getBot });
  return handle(request);
}
