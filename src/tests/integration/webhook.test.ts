import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestBot } from "@bonkers-agency/grammy-test";
import { configureBot } from "@/bot/factory";
import { createWebhookHandler, secretMatches } from "@/lib/webhook";
import type { BotContext } from "@/types/bot";
import { testDatabase, type TestDatabase } from "../helpers/database";

const secret = "a".repeat(64);
const update = {
  update_id: 100,
  message: {
    message_id: 1,
    date: 1792850000,
    chat: { id: 101, type: "private", first_name: "Admin" },
    from: { id: 101, first_name: "Admin", is_bot: false },
    text: "/start",
    entities: [{ offset: 0, length: 6, type: "bot_command" }],
  },
};
let t: TestDatabase;
let bot: TestBot<BotContext>;
let loadBot: ReturnType<typeof vi.fn<() => Promise<TestBot<BotContext>>>>;
let handler: ReturnType<typeof createWebhookHandler>;
let networkGuard: import("vitest").MockInstance<typeof fetch>;
beforeEach(async () => {
  t = await testDatabase();
  networkGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: "1",
  });
  bot.createChat({ id: 101, type: "private" });
  loadBot = vi.fn(async () => bot);
  handler = createWebhookHandler({ secret, loadBot });
});
afterEach(() => {
  bot.dispose();
  expect(networkGuard).not.toHaveBeenCalled();
  networkGuard.mockRestore();
  t.close();
  vi.restoreAllMocks();
});
function request(
  body = JSON.stringify(update),
  token: string | null = secret,
  contentType = "application/json",
) {
  return new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(token === null ? {} : { "x-telegram-bot-api-secret-token": token }),
    },
    body,
  });
}
describe("Fetch-standard webhook handler for Next App Router", () => {
  it("compares secrets safely and rejects unauthorized requests before bot initialization", async () => {
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(null, secret)).toBe(false);
    expect(secretMatches("x", secret)).toBe(false);
    expect((await handler(request(undefined, "wrong"))).status).toBe(401);
    expect(loadBot).not.toHaveBeenCalled();
  });
  it("accepts a valid update with std/http and deduplicates Telegram retries", async () => {
    expect((await handler(request())).status).toBe(200);
    const count = bot.getApiCalls().length;
    expect(count).toBeGreaterThan(0);
    expect((await handler(request())).status).toBe(200);
    expect(bot.getApiCalls()).toHaveLength(count);
    expect(loadBot).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed JSON, envelopes and nested Telegram data", async () => {
    expect((await handler(request("{"))).status).toBe(400);
    expect((await handler(request(JSON.stringify({ update_id: -1 })))).status).toBe(400);
    expect((await handler(request(JSON.stringify({ update_id: 2, message: {} })))).status).toBe(
      400,
    );
    expect(loadBot).not.toHaveBeenCalled();
  });
  it.each([
    { text: "x".repeat(4097) },
    { from: { id: 101, is_bot: false, first_name: "x".repeat(129) } },
    { from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false, first_name: "Admin" } },
  ])(
    "rejects excessive nested text or invalid identity before loading the bot %#",
    async (patch) => {
      const invalid = { ...update, message: { ...update.message, ...patch } };
      expect((await handler(request(JSON.stringify(invalid)))).status).toBe(400);
      expect(loadBot).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized streamed bodies even without Content-Length", async () => {
    expect((await handler(request("x".repeat(262145)))).status).toBe(413);
    expect(loadBot).not.toHaveBeenCalled();
  });
  it("rejects oversized declared Content-Length", async () => {
    const req = request();
    req.headers.set("content-length", "999999");
    expect((await handler(req)).status).toBe(413);
  });
  it("requires the JSON content type", async () => {
    expect((await handler(request("{}", secret, "text/plain"))).status).toBe(415);
  });
  it("acknowledges unsupported update types without loading the bot", async () => {
    expect(
      (await handler(request(JSON.stringify({ update_id: 2, poll: { id: "ignored" } })))).status,
    ).toBe(200);
    expect(loadBot).not.toHaveBeenCalled();
  });
  it("returns 503 for transient failures rather than losing the update with 200", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createWebhookHandler({
      secret,
      loadBot: async () => {
        throw new Error(`do not leak ${secret}`);
      },
    });
    const response = await failing(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});
