import assert from "node:assert/strict";
import { wellFormedText } from "@/lib/text";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { availableParallelism, platform, arch } from "node:os";
import { join, relative, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { TestBot, type BotResponse } from "@bonkers-agency/grammy-test";
import type { Chat, User } from "grammy/types";
import { configureBot } from "@/bot/factory";
import {
  auditLogs,
  botConversations,
  chatLocks,
  inventoryLogs,
  mutationKeys,
  orderItems,
  orderReferences,
  orders,
  products,
  shipments,
  users,
} from "@/db/schema";
import type { BotContext } from "@/types/bot";
import type { Role } from "@/types/domain";
import { customer, testDatabase } from "./database";
import { click, view } from "./telegram";

interface Actor {
  index: number;
  id: string;
  role: Role;
  kind: "creator" | "operator" | "viewer";
  user: User;
  chat: Chat;
  seedOrders: { id: string; referenceCode: string }[];
}
interface Sample {
  tag: string;
  role: Role;
  ms: number;
}
export interface StressOptions {
  users: number;
  updates: number;
  progress?: (done: number, total: number) => void;
}
const round = (n: number) => Math.round(n * 100) / 100;
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (n: number) => sorted[Math.max(0, Math.ceil(sorted.length * n) - 1)] ?? 0;
  return {
    count: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    p99: round(percentile(0.99)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(values.reduce((s, n) => s + n, 0) / (values.length || 1)),
  };
}
async function sourceFingerprint() {
  const root = resolve("."),
    files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|mjs|sql|json|html)$/.test(entry.name)) files.push(path);
    }
  }
  for (const dir of ["src", "scripts", "drizzle"]) await walk(resolve(dir));
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "next.config.ts",
    "drizzle.config.ts",
    "vercel.json",
    ".github/workflows/ci.yml",
  ])
    files.push(resolve(name));
  files.sort();
  const hash = createHash("sha256"),
    manifest: Record<string, string> = {};
  for (const file of files) {
    const path = relative(root, file).replaceAll("\\", "/"),
      data = await readFile(file);
    manifest[path] = createHash("sha256").update(data).digest("hex");
    hash.update(path).update("\0").update(data).update("\0");
  }
  return { sha256: hash.digest("hex"), files: manifest };
}
function checkNativePayload(payload: Record<string, unknown>) {
  if (typeof payload.text === "string") {
    assert(payload.text.length <= 4096, "Message exceeds Telegram text bound");
    assert(wellFormedText(payload.text), "Message contains an unpaired surrogate");
  }
  if (!payload.reply_markup) return;
  const markup: unknown =
    typeof payload.reply_markup === "string"
      ? JSON.parse(payload.reply_markup)
      : payload.reply_markup;
  assert(markup !== null && typeof markup === "object" && "inline_keyboard" in markup);
  assert(Array.isArray(markup.inline_keyboard));
  const actions = [
    "callback_data",
    "url",
    "copy_text",
    "web_app",
    "login_url",
    "switch_inline_query",
    "switch_inline_query_current_chat",
    "switch_inline_query_chosen_chat",
    "callback_game",
    "pay",
    "disabled",
  ];
  for (const row of markup.inline_keyboard as unknown[]) {
    assert(Array.isArray(row));
    for (const value of row as unknown[]) {
      assert(value !== null && typeof value === "object");
      const button = value as Record<string, unknown>;
      assert(typeof button.text === "string" && wellFormedText(button.text), "Invalid button text");
      assert.equal(
        actions.filter((action) => action in button).length,
        1,
        "Exactly one inline action is required",
      );
      if ("disabled" in button) {
        assert.deepEqual(button.disabled, {});
        assert(!("callback_data" in button));
      }
      if (typeof button.callback_data === "string")
        assert(Buffer.byteLength(button.callback_data) <= 64, "Callback exceeds 64 bytes");
    }
  }
}
/** Closed-loop application-handler load. The transport is fake and cannot contact Telegram. */
export async function runStress(options: StressOptions) {
  assert(
    Number.isSafeInteger(options.users) &&
      options.users >= 5 &&
      options.users <= 100 &&
      options.users % 5 === 0,
    "users must be 5..100, divisible by 5",
  );
  assert(
    Number.isSafeInteger(options.updates) &&
      options.updates > 0 &&
      options.updates <= 100000 &&
      options.updates % (options.users * 25) === 0,
    "updates must be a multiple of users × 25 (max 100000)",
  );
  const cycles = options.updates / options.users / 25,
    creatorCount = (options.users * 3) / 5,
    operatorCount = options.users / 5;
  const fingerprint = await sourceFingerprint(),
    t = await testDatabase();
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts++;
    throw new Error("Real network forbidden by offline stress runner");
  };
  const bot = configureBot(new TestBot<BotContext>(), {
    db: t.db,
    services: t.services,
    timeZone: "Asia/Tehran",
    conversationVersion: "4",
  });
  const actors: Actor[] = [],
    productIds: string[] = [],
    initialStock = 20000,
    unitPrice = 100000;
  let interval: ReturnType<typeof setInterval> | undefined;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  try {
    for (let i = 0; i < 8; i++)
      productIds.push(
        (
          await t.services.products.create(
            t.actor.id,
            {
              name: `LOAD کالای ${String(i).padStart(2, "0")}`,
              sku: `LOAD-${i}`,
              price: unitPrice,
              stockQuantity: initialStock,
            },
            `load:seed:product:${i}`,
          )
        ).id,
      );
    for (let i = 0; i < options.users; i++) {
      const role: Role =
        i === 0
          ? "super_admin"
          : i < creatorCount
            ? "admin"
            : i < creatorCount + operatorCount
              ? "operator"
              : "viewer";
      const saved = await t.services.users.save(
        t.actor.id,
        { telegramId: 10000 + i, firstName: `همکار بار ${i}`, role, isActive: true },
        `load:seed:user:${i}`,
      );
      const actor: Actor = {
        index: i,
        id: saved.id,
        role,
        kind: i < creatorCount ? "creator" : role === "operator" ? "operator" : "viewer",
        user: bot.createUser({ id: 10000 + i, first_name: `همکار بار ${i}` }),
        chat: bot.createChat({ id: 10000 + i, type: "private" }),
        seedOrders: [],
      };
      if (actor.kind === "operator")
        for (let n = 0; n < cycles; n++) {
          const key = `load:seed:${i}:${n}`,
            o = await t.services.orders.create(
              t.actor.id,
              {
                customer,
                items: [{ productId: productIds[0]!, quantity: 1, expectedUnitPrice: unitPrice }],
              },
              `${key}:create`,
            );
          await t.services.orders.setStatus(t.actor.id, o.id, "confirmed", `${key}:confirm`);
          await t.services.orders.setStatus(t.actor.id, o.id, "processing", `${key}:processing`);
          await t.services.orders.setPayment(t.actor.id, o.id, "paid", `${key}:pay`);
          await t.services.shipments.save(
            t.actor.id,
            o.id,
            { carrier: "pickup" },
            null,
            "",
            `${key}:parcel`,
          );
          actor.seedOrders.push(o);
        }
      actors.push(actor);
    }
    await bot.init();
    const beforeAudits = new Set((await t.db.select().from(auditLogs)).map((a) => a.id)),
      beforeKeys = (await t.db.select().from(mutationKeys)).length,
      apiStart = bot.getApiCalls().length;
    const samples: Sample[] = [],
      failures: { actor: number; tag: string; error: string }[] = [],
      byActor = Array<number>(options.users).fill(0);
    let active = 0,
      peak = 0,
      completed = 0,
      expectedDenials = 0,
      apiErrorCount = 0,
      observedSessionBytes = 0,
      sessionSamples = 0;
    const baselineMemory = process.memoryUsage();
    let maxRss = baselineMemory.rss,
      maxHeap = baselineMemory.heapUsed;
    const memory = () => {
      const m = process.memoryUsage();
      maxRss = Math.max(maxRss, m.rss);
      maxHeap = Math.max(maxHeap, m.heapUsed);
    };
    interval = setInterval(memory, 50);
    eventLoop.enable();
    const cpuStart = process.cpuUsage(),
      startedAt = new Date().toISOString(),
      start = performance.now();
    async function worker(actor: Actor) {
      let r: BotResponse | undefined;
      async function step(tag: string, work: () => Promise<BotResponse>, denial = false) {
        // Fake-server rate limiting is intentionally reset, not treated as Telegram capacity.
        bot.server.memberState.resetRateLimit(actor.chat.id);
        active++;
        peak = Math.max(peak, active);
        const began = performance.now();
        try {
          const result = await work();
          samples.push({ tag, role: actor.role, ms: performance.now() - began });
          if (result.error) throw result.error;
          for (const call of result.apiCalls) {
            if (call.error) apiErrorCount++;
            if ("chat_id" in call.payload)
              assert.equal(Number(call.payload.chat_id), actor.chat.id, "Cross-chat API response");
            checkNativePayload(call.payload);
          }
          if (denial) {
            assert(result.callbackAnswer?.showAlert);
            assert(
              result.callbackAnswer.text?.includes("اجازه"),
              "Missing expected RBAC rejection",
            );
            expectedDenials++;
          }
          if (result.apiCalls.some((c) => c.method === "answerCallbackQuery"))
            assert.equal(
              result.apiCalls.filter((c) => c.method === "answerCallbackQuery").length,
              1,
              "Callback answered more than once",
            );
          r = view(result);
          byActor[actor.index] = (byActor[actor.index] ?? 0) + 1;
          return r;
        } catch (error) {
          failures.push({
            actor: actor.index,
            tag,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          });
          throw error;
        } finally {
          active--;
          const done = ++completed;
          if (done % 250 === 0) {
            const s = await t.client.execute(
              "SELECT coalesce(max(length(cast(value AS blob))),0) AS bytes FROM bot_conversations",
            );
            observedSessionBytes = Math.max(observedSessionBytes, Number(s.rows[0]?.bytes ?? 0));
            sessionSamples++;
          }
          if (done % 1000 === 0) options.progress?.(done, options.updates);
        }
      }
      const callback = (tag: string, data: string, denial = false) =>
        step(tag, () => bot.clickButton(actor.user, actor.chat, data), denial);
      const text = (tag: string, value: string) =>
        step(tag, () => bot.sendMessage(actor.user, actor.chat, value));
      const button = (tag: string, label: string) => {
        assert(r, "Missing current keyboard");
        const current = r;
        return step(tag, () => click(bot, actor.user, actor.chat, current, label));
      };
      const matching = (tag: string, predicate: (text: string, data: string) => boolean) => {
        assert(r);
        const b = r.keyboard?.inline
          ?.flat()
          .find((b) => "callback_data" in b && predicate(b.text, b.callback_data));
        assert(b, "Expected native button not found");
        return button(tag, b.text);
      };
      for (let cycle = 0; cycle < cycles; cycle++) {
        if (actor.kind === "creator") {
          await callback("order.start", "o:new");
          await matching("order.selectProduct", (_, data) => /:o\d+$/.test(data));
          await button("order.nextProduct", "مرحله بعد ➡️");
          await text("order.quantity", String(1 + (actor.index % 3)));
          await button("order.nextQuantity", "مرحله بعد ➡️");
          await button("order.cartNext", "مرحله بعد: اطلاعات مشتری ➡️");
          await text("order.customerId", String(20000 + actor.index));
          await button("order.nextCustomerId", "مرحله بعد ➡️");
          await text("order.customerName", `مشتری بار ${actor.index}`);
          await button("order.nextCustomerName", "مرحله بعد ➡️");
          await text("order.phone", "09123456789");
          await button("order.nextPhone", "مرحله بعد ➡️");
          await text("order.address", `نشانی ساختگی کاربر ${actor.index} پلاک ۱۲`);
          await button("order.nextAddress", "مرحله بعد ➡️");
          await text("order.notes", `آزمون آفلاین ${actor.index}`);
          await button("order.review", "مرحله بعد ➡️");
          assert(r?.text?.includes(`مشتری بار ${actor.index}`), "Wrong user's order draft");
          assert(r?.text?.includes(`آزمون آفلاین ${actor.index}`), "Mixed session notes");
          await button("order.commit", "✅ تأیید نهایی");
          assert(r?.text?.includes("سفارش ثبت شد"));
          await callback("browse.home", "m:home");
          await callback("browse.products", "p:list:0");
          await matching("browse.product", (_, d) => d.startsWith("p:view:"));
          await callback("browse.orders", "o:list:0");
          await matching("browse.order", (_, d) => d.startsWith("o:view:"));
          await callback("browse.homeAgain", "m:home");
          await callback("browse.help", "m:help");
          await callback("browse.end", "m:home");
        } else if (actor.kind === "operator") {
          const order = actor.seedOrders[cycle]!;
          await callback("fulfillment.order", `o:view:${order.id}`);
          await callback("fulfillment.status", `o:status:${order.id}`);
          await button("fulfillment.chooseShip", "ارسال‌شده");
          await button("fulfillment.confirmShip", "✅ تأیید");
          assert(r?.text?.includes("ارسال‌شده"));
          await callback("fulfillment.orderAgain", `o:view:${order.id}`);
          await callback("fulfillment.statusAgain", `o:status:${order.id}`);
          await button("fulfillment.chooseDeliver", "تحویل‌شده");
          await button("fulfillment.confirmDeliver", "✅ تأیید");
          assert(r?.text?.includes("تحویل‌شده"));
          await callback("fulfillment.parcel", `sh:view:${order.id}`);
          await callback("fulfillment.history", `sh:history:${order.id}:0`);
          await callback("search.orderStart", "o:search");
          await text("search.orderQuery", order.referenceCode);
          await button("search.orderNext", "مرحله بعد ➡️");
          await matching("search.orderSelect", (label) => label.includes(order.referenceCode));
          await button("search.orderReview", "مرحله بعد ➡️");
          await button("search.orderFinish", "✅ تأیید نهایی");
          await button("search.openOrder", "🧾 مشاهده سفارش");
          await callback("browse.home", "m:home");
          await callback("browse.orders", "o:list:0");
          await callback("rbac.stockDenied", `p:stock:${productIds[0]}`, true);
          await callback("rbac.settingsDenied", "s:menu", true);
          await callback("rbac.reportDenied", "r:menu", true);
          await callback("browse.help", "m:help");
          await callback("browse.queue", "o:queue:shipped:0");
          await callback("browse.end", "m:home");
        } else {
          await step("browse.start", () => bot.sendCommand(actor.user, actor.chat, "/start"));
          await callback("browse.products", "p:list:0");
          await callback("browse.reports", "r:menu");
          await callback("browse.daily", "r:day");
          await callback("browse.home", "m:home");
          await callback("rbac.productDenied", "p:add", true);
          await callback("rbac.ordersDenied", "o:list:0", true);
          await callback("rbac.usersDenied", "u:list:0", true);
          await callback("search.productStart", "p:search");
          await text("search.productQuery", "LOAD");
          await button("search.productNext", "مرحله بعد ➡️");
          await matching("search.productSelect", (_, d) => /:o\d+$/.test(d));
          await button("search.productReview", "مرحله بعد ➡️");
          await button("search.backSelection", "⬅️ مرحله قبل");
          await button("search.backQuery", "⬅️ مرحله قبل");
          await button("search.reuseQuery", "مرحله بعد ➡️");
          await button("search.reuseSelection", "مرحله بعد ➡️");
          await button("search.productFinish", "✅ تأیید نهایی");
          await callback("browse.homeAgain", "m:home");
          await callback("browse.lowStock", "r:low:0");
          await callback("browse.movements", "r:moves:0");
          await callback("browse.monthly", "r:month");
          await callback("browse.help", "m:help");
          await callback("browse.productsAgain", "p:list:0");
          await callback("browse.end", "m:home");
        }
      }
    }
    await Promise.allSettled(actors.map(worker));
    const durationMs = performance.now() - start,
      cpu = process.cpuUsage(cpuStart);
    memory();
    clearInterval(interval);
    interval = undefined;
    eventLoop.disable();
    const finalOrders = await t.db.select().from(orders),
      items = await t.db.select().from(orderItems),
      references = await t.db.select().from(orderReferences),
      stock = await t.db.select().from(products),
      ledger = await t.db.select().from(inventoryLogs),
      parcels = await t.db.select().from(shipments),
      accounts = await t.db.select().from(users),
      audits = (await t.db.select().from(auditLogs)).filter((a) => !beforeAudits.has(a.id));
    const keys = (await t.db.select().from(mutationKeys)).length - beforeKeys,
      receipts = await t.db.select().from((await import("@/db/schema")).processedUpdates),
      locks = await t.db.select().from(chatLocks),
      conversations = await t.db.select().from(botConversations);
    const foreignKeys = await t.client.execute("PRAGMA foreign_key_check"),
      integrity = await t.client.execute("PRAGMA integrity_check");
    const expectedNewOrders = creatorCount * cycles,
      expectedDelivered = operatorCount * cycles,
      expectedUnits = Array.from({ length: creatorCount }, (_, i) => (1 + (i % 3)) * cycles).reduce(
        (a, b) => a + b,
        0,
      );
    const createdOrders = finalOrders.filter(
      (o) => o.customerTelegramId >= 20000 && o.customerTelegramId < 20000 + creatorCount,
    );
    const invariants: Record<string, boolean> = {
      exactUpdateCount: completed === options.updates && samples.length === options.updates,
      allVirtualUsersCompleted: byActor.every((count) => count === cycles * 25),
      reachedTargetConcurrency: peak === options.users,
      noUnexpectedFailures: failures.length === 0 && apiErrorCount === 0,
      noRealNetwork: networkAttempts === 0,
      expectedRbacDenials: expectedDenials === operatorCount * cycles * 6,
      everyUpdateDeduplicatable: receipts.length === options.updates,
      noLeasesOrDraftsLeft: locks.length === 0 && conversations.length === 0,
      expectedBusinessMutationCount: keys === expectedNewOrders + expectedDelivered * 2,
      expectedOrderCount:
        finalOrders.length === expectedNewOrders + expectedDelivered &&
        createdOrders.length === expectedNewOrders,
      uniqueReferences:
        references.length === finalOrders.length &&
        new Set(references.map((r) => r.code)).size === finalOrders.length &&
        references.every((r) => /^REF-[A-Z0-9]{12}$/.test(r.code)),
      exactStockAndNoOversell:
        stock.length === 8 &&
        stock.every(
          (p) =>
            p.stockQuantity ===
              (p.id === productIds[0]
                ? initialStock - expectedUnits - expectedDelivered
                : initialStock) && p.stockQuantity >= 0,
        ),
      inventoryLedgerBalances:
        stock.every(
          (p) =>
            ledger
              .filter((l) => l.productId === p.id)
              .reduce((sum, l) => sum + l.quantityChange, 0) === p.stockQuantity,
        ) && ledger.every((l) => l.previousStock + l.quantityChange === l.newStock),
      exactOrderItemsAndTotals:
        items.length === finalOrders.length &&
        finalOrders.every(
          (o) =>
            items.filter((i) => i.orderId === o.id).reduce((sum, i) => sum + i.totalPrice, 0) ===
            o.totalAmount,
        ) &&
        items.every(
          (i) =>
            i.totalPrice === i.unitPrice * i.quantity &&
            i.unitPrice === unitPrice &&
            i.productId === productIds[0],
        ),
      isolatedCustomerAndCartDrafts: actors
        .filter((a) => a.kind === "creator")
        .every((a) => {
          const rows = createdOrders.filter((o) => o.customerTelegramId === 20000 + a.index);
          return (
            rows.length === cycles &&
            rows.every(
              (o) =>
                o.customerName === `مشتری بار ${a.index}` &&
                o.shippingAddress === `نشانی ساختگی کاربر ${a.index} پلاک ۱۲` &&
                o.notes === `آزمون آفلاین ${a.index}` &&
                o.totalAmount === (1 + (a.index % 3)) * unitPrice &&
                o.paymentStatus === "unpaid" &&
                o.status === "pending",
            )
          );
        }),
      fulfillmentAndParcelTimes:
        parcels.length === expectedDelivered &&
        parcels.every(
          (p) => p.state === "delivered" && p.dispatchedAt !== null && p.deliveredAt !== null,
        ) &&
        finalOrders.filter((o) => o.status === "delivered" && o.paymentStatus === "paid").length ===
          expectedDelivered,
      noRoleEscalation: actors.every((a) =>
        accounts.some((u) => u.id === a.id && u.role === a.role && u.isActive),
      ),
      noCustomerAccess: accounts
        .filter(
          (u) =>
            (u.telegramId >= 20000 && u.telegramId < 20000 + creatorCount) ||
            u.telegramId === customer.telegramId,
        )
        .every((u) => !u.isActive && u.role === "viewer"),
      noForbiddenAuditWrites: audits.every((log) => {
        const a = actors.find((a) => a.id === log.userId);
        return (
          !!a &&
          (a.kind === "creator"
            ? log.action === "order.create"
            : a.kind === "operator"
              ? ["order.status", "shipment.dispatched", "shipment.delivered"].includes(log.action)
              : false)
        );
      }),
      noForeignKeyOrIntegrityErrors:
        foreignKeys.rows.length === 0 && integrity.rows[0]?.integrity_check === "ok",
    };
    const calls = bot.getApiCalls().slice(apiStart),
      apiMethods: Record<string, number> = {};
    for (const call of calls) apiMethods[call.method] = (apiMethods[call.method] ?? 0) + 1;
    const allRoles: Role[] = ["super_admin", "admin", "operator", "viewer"];
    const byRole = Object.fromEntries(
      allRoles.map((role) => [
        role,
        distribution(samples.filter((s) => s.role === role).map((s) => s.ms)),
      ]),
    );
    const report = {
      schemaVersion: 1,
      release: "1.3.0",
      startedAt,
      finishedAt: new Date().toISOString(),
      passed: Object.values(invariants).every(Boolean),
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        hostReportedParallelism: availableParallelism(),
        database:
          "libSQL/SQLite file::memory:, single process, local whole-client queue and concurrency=1",
        transport:
          "grammy-test 0.1.3; AsyncLocalStorage response isolation; mock per-chat rate limits reset before each update",
      },
      target: {
        concurrentUsers: options.users,
        updates: options.updates,
        mode: "closed-loop; one outstanding update per private chat; no think time",
        cyclesPerUser: cycles,
        updatesPerCycle: 25,
      },
      workload: {
        roles: Object.fromEntries(
          allRoles.map((role) => [role, actors.filter((a) => a.role === role).length]),
        ),
        initialProducts: 8,
        seedFulfillmentOrders: expectedDelivered,
        createdOrders: createdOrders.length,
        fulfilledOrders: finalOrders.filter((o) => o.status === "delivered").length,
        reservedUnitsInNewOrders: expectedUnits,
        expectedRbacDenials: expectedDenials,
        unexpectedFailures: failures.length,
        realNetworkAttempts: networkAttempts,
      },
      result: {
        completedUpdates: completed,
        latencySamples: samples.length,
        successfulUpdates: byActor.reduce((sum, n) => sum + n, 0),
        peakConcurrentHandlers: peak,
        durationMs: round(durationMs),
        updatesPerSecond: round(completed / (durationMs / 1000)),
        latencyMs: distribution(samples.map((s) => s.ms)),
        latencyByRoleMs: byRole,
        mockApiCalls: calls.length,
        mockApiErrors: apiErrorCount,
        apiMethods,
      },
      resources: {
        rssBaselineBytes: baselineMemory.rss,
        rssPeakObservedBytes: maxRss,
        heapBaselineBytes: baselineMemory.heapUsed,
        heapPeakObservedBytes: maxHeap,
        cpuUserMs: round(cpu.user / 1000),
        cpuSystemMs: round(cpu.system / 1000),
        eventLoopDelayMs: {
          mean: round(Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : 0),
          p99: round(eventLoop.percentile(99) / 1e6),
          max: round(eventLoop.max / 1e6),
        },
        memorySampleIntervalMs: 50,
        maxObservedSerializedSessionBytes: observedSessionBytes,
        sessionSizeSamples: sessionSamples,
      },
      persistence: {
        orders: finalOrders.length,
        orderItems: items.length,
        orderReferences: references.length,
        parcels: parcels.length,
        remainingStockOfSharedProduct: stock.find((p) => p.id === productIds[0])?.stockQuantity,
        updateReceipts: receipts.length,
        newMutationKeys: keys,
        remainingLeases: locks.length,
        remainingConversations: conversations.length,
      },
      invariants,
      failures,
      source: fingerprint,
      limitations: [
        "Not a Telegram API, HTTP, Vercel or Turso Cloud benchmark; no production capacity or 10/10 guarantee.",
        "50 virtual users means asynchronous handlers in flight, not 50 parallel SQLite writers. All local database access serializes in this process.",
        "Mock transport bypasses real Telegram rate limits; real deployments must handle 429/retries and platform quotas.",
        "Latency includes client harness/JSON/assertion overhead; RSS/heap include retained mock message/API history. Session-byte peak is sampled, not exhaustive.",
        "Synthetic workload: 8 products, ample stock, fixed 25-update recipes. Large catalogs, network faults and distributed contention need separate testing.",
        "Cryptographic IDs and timestamps vary between runs; workload and postconditions are reproducible, timings are observations, not an SLA.",
      ],
    };
    return report;
  } finally {
    if (interval) clearInterval(interval);
    eventLoop.disable();
    bot.dispose();
    globalThis.fetch = originalFetch;
    t.close();
  }
}
