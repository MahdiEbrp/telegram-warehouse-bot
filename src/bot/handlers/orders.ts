import { clipText } from "@/lib/text";
import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext } from "@/types/bot";
import { can } from "@/lib/permissions";
import { money } from "@/lib/money";
import {
  orderStatuses,
  orderListFilters,
  type OrderStatus,
  type OrderListFilter,
} from "@/types/domain";
import { carrierLabel, shipmentReady } from "@/lib/shipping";
import { z } from "zod";
import { statusLabel, paymentLabel } from "@/bot/labels";
import { addPager, backHome } from "@/bot/keyboards/common";
import { transitions } from "@/db/queries/orders";

export async function showOrderList(
  ctx: BotContext,
  pageNumber = 0,
  filter: OrderListFilter = "all",
) {
  const page = await ctx.services.orders.list(ctx.principal.id, pageNumber, filter);
  const k = new InlineKeyboard();
  for (const order of page.items)
    k.text(
      `${order.referenceCode ?? order.orderNumber.slice(-10)} | ${statusLabel[order.status]} | ${clipText(order.customerName, 20)}`,
      `o:view:${order.id}`,
    ).row();
  if (can(ctx.principal.role, "orders:create")) k.text("➕ ثبت سفارش", "o:new");
  k.row().text("🔎 جستجوی کد / مشتری", "o:search").row();
  if (can(ctx.principal.role, "orders:export"))
    k.text("📊 خروجی Excel مرسوله‌ها", "exp:menu").row();
  k.text("🚚 آماده ارسال", "o:queue:ready:0").text("📦 ارسال‌شده‌ها", "o:queue:shipped:0").row();
  k.text("⚠️ ارسال قدیمی بدون اطلاعات", "o:queue:untracked:0").row();
  if (filter !== "all") k.text("🛒 همه سفارشات", "o:list:0").row();
  addPager(k, page, filter === "all" ? "o:list" : `o:queue:${filter}`);
  backHome(k);
  await ctx.reply(
    `🛒 سفارشات — ${page.total} سفارش${filter === "all" ? "" : ` | ${filter === "ready" ? "آماده ارسال (پرداخت‌شده)" : filter === "shipped" ? "ارسال‌شده" : "قدیمی بدون اطلاعات ارسال"}`}\n${page.total ? "برای مشاهدهٔ جزئیات، سفارش را انتخاب کنید." : "سفارشی ثبت نشده است."}`,
    { reply_markup: k },
  );
}
export async function showOrder(ctx: BotContext, id: string) {
  const order = await ctx.services.orders.get(ctx.principal.id, id);
  const k = new InlineKeyboard();
  if (can(ctx.principal.role, "orders:status") && transitions[order.status].length)
    k.text("🔄 تغییر وضعیت", `o:status:${id}`).row();
  if (
    can(ctx.principal.role, "orders:payment") &&
    order.paymentStatus === "unpaid" &&
    order.status !== "cancelled"
  )
    k.text("💳 تأیید پرداخت دستی", `o:pay:${id}`).row();
  if (
    can(ctx.principal.role, "orders:payment") &&
    order.status === "cancelled" &&
    order.paymentStatus === "paid"
  )
    k.text("↩️ ثبت بازپرداخت دستی", `o:refund:${id}`).row();
  k.text("🚚 اطلاعات ارسال و رهگیری", `sh:view:${id}`).row();
  k.copyText("📋 کپی کد پیگیری سفارش", order.referenceCode).row();
  if (order.shipment?.trackingNumber)
    k.copyText("📋 کپی کد مرسوله", order.shipment.trackingNumber).row();
  k.text("⬅️ سفارشات", "o:list:0");
  backHome(k);
  const lines = order.items
    .map((p) => `${clipText(p.name, 50)} × ${p.quantity} = ${money(p.totalPrice)}`)
    .join("\n");
  await ctx.reply(
    `🧾 ${order.orderNumber}\nکد پیگیری سفارش: ${order.referenceCode}\nارسال: ${order.shipments.length > 1 ? `${order.shipments.length} مرسوله | ${order.shipments.filter((p) => p.state !== "draft").length} ارسال / ${order.shipments.filter((p) => p.state === "delivered").length} تحویل` : order.shipment ? `${carrierLabel(order.shipment.carrier, order.shipment.carrierName)} | ${order.shipment.trackingNumber ?? "بدون بارکد"}` : "اطلاعات ثبت نشده"}\nوضعیت: ${statusLabel[order.status]}\nپرداخت: ${paymentLabel[order.paymentStatus]}\nمشتری: ${order.customerName} (${order.customerTelegramId})\nتلفن: ${order.customerPhone}\nنشانی: ${order.shippingAddress}\n\n${lines}\nجمع: ${money(order.totalAmount)}\nتوضیحات: ${order.notes || "—"}`,
    { reply_markup: k },
  );
}
export function registerOrders(bot: Bot<BotContext>) {
  bot.callbackQuery(/^o:list:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^o:view:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showOrder(ctx, ctx.match[1]!);
  });
  bot.callbackQuery("o:search", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("orderSearch");
  });
  bot.callbackQuery(/^o:queue:(ready|shipped|untracked):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, Number(ctx.match[2]), z.enum(orderListFilters).parse(ctx.match[1]));
  });
  bot.callbackQuery("o:new", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("orderCreate");
  });
  bot.callbackQuery(/^o:status:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const order = await ctx.services.orders.get(ctx.principal.id, id);
    const k = new InlineKeyboard();
    for (const status of transitions[order.status]) {
      if (
        status === "shipped" &&
        (order.paymentStatus !== "paid" ||
          !(order.shipments.length > 0 && order.shipments.every(shipmentReady)))
      )
        k.disabled("ارسال: ابتدا پرداخت و اطلاعات حمل تکمیل شود").row();
      else k.text(statusLabel[status], `o:change:${id}:${status}`).row();
    }
    if (
      order.status === "processing" &&
      !(order.shipments.length > 0 && order.shipments.every(shipmentReady))
    )
      k.text("🚚 تکمیل اطلاعات ارسال", `sh:view:${id}`).row();
    if (!transitions[order.status].length) k.disabled("وضعیت نهایی است");
    backHome(k);
    await ctx.reply(`وضعیت فعلی: ${statusLabel[order.status]}\nوضعیت بعدی را انتخاب کنید.`, {
      reply_markup: k,
    });
  });
  bot.callbackQuery(/^o:change:([a-f0-9-]{36}):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const status = z.enum(orderStatuses).parse(ctx.match[2]);
    await ctx.reply(
      `تغییر وضعیت به «${statusLabel[status]}» تأیید شود؟${status === "shipped" || status === "delivered" ? "\nاین تأیید برای همهٔ مرسوله‌های جاری سفارش است. برای ارسال/تحویل جزئی از کارت همان مرسوله استفاده کنید." : ""}${status === "cancelled" ? "\nموجودی رزروشده فقط یک‌بار برمی‌گردد؛ بازپرداخت واقعی خودکار نیست." : ""}`,
      {
        reply_markup: backHome(
          new InlineKeyboard()
            .text("✅ تأیید", `o:set:${id}:${status}`)
            .row()
            .text("↩️ بازگشت", `o:view:${id}`),
        ),
      },
    );
  });
  bot.callbackQuery(/^o:set:([a-f0-9-]{36}):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const status: OrderStatus = z.enum(orderStatuses).parse(ctx.match[2]);
    await ctx.services.orders.setStatus(
      ctx.principal.id,
      id,
      status,
      `update:${ctx.update.update_id}:status`,
      ctx.lease,
    );
    await showOrder(ctx, id);
  });
  bot.callbackQuery(/^o:(pay|refund):([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match[1]!;
    const id = ctx.match[2]!;
    await ctx.reply(
      kind === "pay"
        ? "آیا وجه واقعاً دریافت شده است؟ این فقط تأیید حسابداری است، نه اتصال به درگاه."
        : "آیا وجه واقعاً به مشتری بازپرداخت شده است؟ بات انتقال وجه انجام نمی‌دهد.",
      {
        reply_markup: backHome(
          new InlineKeyboard()
            .text("✅ بله، ثبت شود", `o:${kind}Yes:${id}`)
            .row()
            .text("↩️ بازگشت", `o:view:${id}`),
        ),
      },
    );
  });
  bot.callbackQuery(/^o:(payYes|refundYes):([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[2]!;
    await ctx.services.orders.setPayment(
      ctx.principal.id,
      id,
      ctx.match[1] === "payYes" ? "paid" : "refunded",
      `update:${ctx.update.update_id}:payment`,
      ctx.lease,
    );
    await showOrder(ctx, id);
  });
}
