import { timingSafeEqual } from "node:crypto";
import { webhookCallback, type Bot } from "grammy";
import { z } from "zod";
import type { BotContext } from "@/types/bot";
import { logError } from "./errors";

const MAX_BODY = 262_144;
const telegramUser = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.boolean(),
    first_name: z.string().min(1).max(128),
  })
  .passthrough();
const telegramMessage = z
  .object({
    message_id: z.number().int().min(0),
    date: z.number().int().min(0),
    chat: z
      .object({
        id: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
        type: z.enum(["private", "group", "supergroup", "channel"]),
      })
      .passthrough(),
    from: telegramUser.optional(),
    text: z.string().max(4096).optional(),
  })
  .passthrough();
const updateEnvelope = z
  .object({
    update_id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    message: telegramMessage.optional(),
    callback_query: z
      .object({
        id: z.string().min(1).max(256),
        from: telegramUser,
        chat_instance: z.string().max(256),
        message: telegramMessage.optional(),
        data: z
          .string()
          .refine((v) => Buffer.byteLength(v, "utf8") <= 64)
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export function secretMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readLimitedBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function createWebhookHandler(config: {
  secret: string;
  loadBot: () => Promise<Bot<BotContext>>;
}) {
  let callback: ReturnType<typeof webhookCallback<BotContext, "std/http">> | undefined;
  return async function handle(request: Request): Promise<Response> {
    if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token"), config.secret))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
      return Response.json({ error: "Expected JSON" }, { status: 415 });
    let body: string | null;
    try {
      body = await readLimitedBody(request);
    } catch {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    if (body === null) return Response.json({ error: "Payload too large" }, { status: 413 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const envelope = updateEnvelope.safeParse(parsed);
    if (!envelope.success) return Response.json({ error: "Invalid update" }, { status: 400 });
    if (!("message" in envelope.data) && !("callback_query" in envelope.data))
      return Response.json({ ok: true });
    try {
      callback ??= webhookCallback(await config.loadBot(), "std/http", {
        secretToken: config.secret,
        timeoutMilliseconds: 55_000,
        onTimeout: "throw",
      });
      // App Router is Fetch Request/Response, even on Vercel's Node runtime.
      return await callback(
        new Request(request.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": config.secret,
          },
          body,
        }),
      );
    } catch (error) {
      logError(error, envelope.data.update_id);
      return Response.json(
        { error: "Temporary failure; retry" },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
  };
}
