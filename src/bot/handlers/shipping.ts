import { clipText } from "@/lib/text";
import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext } from "@/types/bot";
import { carriers, type Json } from "@/types/domain";
import type { Shipment } from "@/db/schema";
import { can } from "@/lib/permissions";
import {
  canAddShipment,
  canEditShipment,
  carrierLabel,
  shipmentStateLabels,
  trackingLink,
} from "@/lib/shipping";
import { money } from "@/lib/money";
import { dateLabel } from "@/lib/time";
import { addPager, backHome } from "@/bot/keyboards/common";
import { z } from "zod";

export function shipmentActions(orderId: string) {
  return backHome(
    new InlineKeyboard()
      .text("🚚 اطلاعات ارسال", `sh:view:${orderId}`)
      .row()
      .text("🧾 سفارش", `o:view:${orderId}`),
  );
}
function detailText(parcel: Shipment, timeZone: string) {
  return [
    `مرسولهٔ #${parcel.parcelNumber} — ${shipmentStateLabels[parcel.state]}`,
    `شرکت حمل: ${carrierLabel(parcel.carrier, parcel.carrierName)}`,
    `کد رهگیری مرسوله: ${parcel.trackingNumber ?? "بدون بارکد (پیک / تحویل حضوری)"}`,
    `کد پستی گیرنده: ${parcel.postalCode ?? "—"}`,
    `هزینهٔ داخلی حمل: ${money(parcel.shippingCost)} (جدا از جمع سفارش)`,
    `زمان ثبت ارسال: ${parcel.dispatchedAt ? dateLabel(parcel.dispatchedAt, timeZone) : parcel.state !== "draft" ? "نامشخص؛ سابقهٔ قدیمی" : "هنوز ارسال ثبت نشده"}`,
    `زمان تحویل: ${parcel.deliveredAt ? dateLabel(parcel.deliveredAt, timeZone) : "ثبت نشده / نامشخص"}`,
    `یادداشت ارسال: ${parcel.note || "—"}`,
    ...(parcel.trackingUrl ? [`لینک اختصاصی: ${parcel.trackingUrl}`] : []),
    `نسخهٔ اطلاعات: ${parcel.version}`,
  ].join("\n");
}
function parcelButtons(
  ctx: BotContext,
  orderStatus: string,
  parcel: Shipment,
  keyboard: InlineKeyboard,
) {
  if (parcel.trackingNumber) keyboard.copyText("📋 کپی کد مرسوله", parcel.trackingNumber).row();
  const link = trackingLink(parcel);
  if (link)
    keyboard.url(parcel.trackingUrl ? "🔗 لینک اختصاصی رهگیری" : "🔗 سامانهٔ شرکت حمل", link).row();
  if (
    canEditShipment(
      ctx.principal.role,
      z
        .enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"])
        .parse(orderStatus),
      parcel.state,
    )
  )
    keyboard.text("✏️ ثبت / ویرایش ارسال", `sh:editParcel:${parcel.id}`).row();
  if (
    ["pending", "confirmed", "processing"].includes(orderStatus) &&
    parcel.state === "draft" &&
    can(ctx.principal.role, "orders:shipping")
  )
    keyboard.text("🗑 پاک‌کردن پیش‌نویس ارسال", `sh:clearParcel:${parcel.id}`).row();
  if (
    can(ctx.principal.role, "orders:shipping") &&
    ["processing", "shipped"].includes(orderStatus)
  ) {
    if (parcel.state === "draft")
      keyboard.text("🚚 ثبت ارسال همین مرسوله", `sh:send:${parcel.id}`).row();
    if (parcel.state === "dispatched")
      keyboard.text("📬 ثبت تحویل همین مرسوله", `sh:deliver:${parcel.id}`).row();
  }
}
export async function showShipping(ctx: BotContext, orderId: string, timeZone: string) {
  const order = await ctx.services.orders.get(ctx.principal.id, orderId);
  const rows = order.shipments;
  const keyboard = new InlineKeyboard().copyText("📋 کپی کد سفارش", order.referenceCode).row();
  if (rows.length === 1) parcelButtons(ctx, order.status, rows[0]!, keyboard);
  for (const row of rows)
    keyboard
      .text(
        `📦 #${row.parcelNumber} | ${shipmentStateLabels[row.state]} | ${clipText(row.trackingNumber ?? carrierLabel(row.carrier, row.carrierName), 25)}`,
        `sh:parcel:${row.id}`,
      )
      .row();
  if (canAddShipment(ctx.principal.role, order.status, rows.length))
    keyboard
      .text(rows.length ? "➕ افزودن مرسولهٔ جدید" : "✏️ ثبت / ویرایش ارسال", `sh:add:${orderId}`)
      .row();
  keyboard
    .text("📜 تاریخچهٔ ارسال", `sh:history:${orderId}:0`)
    .row()
    .text("🧾 بازگشت به سفارش", `o:view:${orderId}`);
  backHome(keyboard);
  const sent = rows.filter((row) => row.state !== "draft").length,
    delivered = rows.filter((row) => row.state === "delivered").length;
  const detail =
    rows.length === 1
      ? detailText(rows[0]!, timeZone)
      : rows.length
        ? rows
            .map(
              (row) =>
                `#${row.parcelNumber} | ${shipmentStateLabels[row.state]} | ${clipText(row.trackingNumber ?? "بدون بارکد", 40)}`,
            )
            .join("\n")
        : "⚠️ اطلاعات ارسال هنوز ثبت نشده است. برای ارسال جدید ابتدا شرکت حمل و کد مرسوله را ثبت کنید؛ پیک/تحویل حضوری می‌تواند بدون کد باشد.";
  await ctx.reply(
    `🚚 ارسال و رهگیری\nکد پیگیری سفارش: ${order.referenceCode}\nشمارهٔ سفارش: ${order.orderNumber}\nمرسوله‌ها: ${rows.length} | ارسال: ${sent} | تحویل: ${delivered}\nجمع هزینهٔ داخلی حمل: ${money(rows.reduce((sum, row) => sum + row.shippingCost, 0))}\n\n${detail}\n\nارسال جزئی، موجودی را دوباره کم نمی‌کند. وضعیت کل پس از ارسال/تحویل همهٔ مرسوله‌های جاری به‌روز می‌شود. صرفاً ثبت دستی است؛ وضعیت زندهٔ شرکت حمل دریافت نمی‌شود.`,
    { reply_markup: keyboard, link_preview_options: { is_disabled: true } },
  );
}
export async function showParcel(ctx: BotContext, parcelId: string, timeZone: string) {
  const parcel = await ctx.services.shipments.getById(ctx.principal.id, parcelId);
  const order = await ctx.services.orders.get(ctx.principal.id, parcel.orderId);
  const keyboard = new InlineKeyboard().copyText("📋 کپی کد سفارش", order.referenceCode).row();
  parcelButtons(ctx, order.status, parcel, keyboard);
  keyboard
    .text("📦 همهٔ مرسوله‌ها", `sh:view:${order.id}`)
    .row()
    .text("🧾 سفارش", `o:view:${order.id}`);
  backHome(keyboard);
  await ctx.reply(
    `🚚 ${order.referenceCode}\n${detailText(parcel, timeZone)}\n\nثبت دستی است؛ برای رهگیری، کد کپی‌شده را در سامانهٔ شرکت وارد کنید.`,
    { reply_markup: keyboard, link_preview_options: { is_disabled: true } },
  );
}
function record(value: Json | undefined): { [key: string]: Json } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function codeLabel(value: Json | undefined): string {
  return typeof value === "string" ? value : "—";
}
function historySnapshot(value: Json | undefined): string {
  const object = record(value);
  if (!object) return "—";
  const carrier =
    typeof object.carrier === "string" &&
    carriers.includes(object.carrier as (typeof carriers)[number])
      ? carrierLabel(object.carrier as (typeof carriers)[number], codeLabel(object.carrierName))
      : "—";
  return `#${typeof object.parcelNumber === "number" ? object.parcelNumber : "—"} | ${clipText(carrier, 60)} | ${clipText(codeLabel(object.trackingNumber), 64)} | نسخه ${typeof object.version === "number" ? object.version : "—"}`;
}
export function registerShipping(bot: Bot<BotContext>, timeZone: string) {
  bot.callbackQuery(/^sh:view:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showShipping(ctx, ctx.match[1]!, timeZone);
  });
  bot.callbackQuery(/^sh:parcel:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showParcel(ctx, ctx.match[1]!, timeZone);
  });
  bot.callbackQuery(/^sh:add:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("shipmentEdit", ctx.match[1]!);
  });
  // v1.1 button compatibility: never silently pick the first of several parcels.
  bot.callbackQuery(/^sh:edit:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const order = await ctx.services.orders.get(ctx.principal.id, ctx.match[1]!);
    if (order.shipments.length > 1) {
      await showShipping(ctx, order.id, timeZone);
      return;
    }
    await ctx.conversation.enter("shipmentEdit", order.id, order.shipment?.id);
  });
  bot.callbackQuery(/^sh:clear:([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const order = await ctx.services.orders.get(ctx.principal.id, ctx.match[1]!);
    if (order.shipments.length > 1) {
      await showShipping(ctx, order.id, timeZone);
      return;
    }
    await ctx.conversation.enter("shipmentClear", order.id, order.shipment?.id);
  });
  bot.callbackQuery(/^sh:(editParcel|clearParcel):([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parcel = await ctx.services.shipments.getById(ctx.principal.id, ctx.match[2]!);
    await ctx.conversation.enter(
      ctx.match[1] === "editParcel" ? "shipmentEdit" : "shipmentClear",
      parcel.orderId,
      parcel.id,
    );
  });
  bot.callbackQuery(/^sh:(send|deliver):([a-f0-9-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parcel = await ctx.services.shipments.getById(ctx.principal.id, ctx.match[2]!);
    const dispatch = ctx.match[1] === "send";
    await ctx.reply(
      `ثبت ${dispatch ? "ارسال" : "تحویل"} فقط مرسولهٔ #${parcel.parcelNumber} تأیید شود؟\nکد: ${parcel.trackingNumber ?? "بدون بارکد"}\nاین کار ثبت دستی است؛ پس از تکمیل همهٔ مرسوله‌ها، وضعیت کل سفارش هم به‌روز می‌شود.`,
      {
        reply_markup: backHome(
          new InlineKeyboard()
            .text(
              "✅ تأیید همین مرسوله",
              `sh:${dispatch ? "sd" : "dl"}:${parcel.id}:${parcel.version}`,
            )
            .row()
            .text("↩️ بازگشت به مرسوله", `sh:parcel:${parcel.id}`),
        ),
      },
    );
  });
  bot.callbackQuery(/^sh:(sd|dl):([a-f0-9-]{36}):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[2]!;
    await ctx.services.shipments.transition(
      ctx.principal.id,
      id,
      ctx.match[1] === "sd" ? "dispatched" : "delivered",
      { id, version: Number(ctx.match[3]) },
      `update:${ctx.update.update_id}:parcel-status`,
      ctx.lease,
    );
    await showParcel(ctx, id, timeZone);
  });
  bot.callbackQuery(/^sh:history:([a-f0-9-]{36}):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = ctx.match[1]!;
    const page = await ctx.services.shipments.history(
      ctx.principal.id,
      orderId,
      Number(ctx.match[2]),
    );
    const actions: Record<string, string> = {
      "shipment.create": "ثبت اطلاعات",
      "shipment.update": "اصلاح اطلاعات",
      "shipment.clear": "پاک‌کردن پیش‌نویس",
      "shipment.dispatched": "ثبت ارسال",
      "shipment.delivered": "ثبت تحویل",
    };
    const text = page.items
      .map((item) => {
        const details = record(item.details);
        return `${actions[item.action] ?? item.action}\nقبلی: ${historySnapshot(details?.before)}\nجدید: ${historySnapshot(details?.after)}\nعلت: ${clipText(codeLabel(details?.reason), 100)}\n${clipText(item.actorName, 40)} (${item.actorTelegramId}) | ${dateLabel(item.createdAt, timeZone)}`;
      })
      .join("\n\n");
    const keyboard = new InlineKeyboard();
    addPager(keyboard, page, `sh:history:${orderId}`);
    keyboard.row().text("🚚 اطلاعات ارسال", `sh:view:${orderId}`);
    backHome(keyboard);
    await ctx.reply(
      `📜 تاریخچهٔ ارسال — ${page.total} رویداد\n${text || "هنوز رویدادی ثبت نشده است."}`,
      { reply_markup: keyboard },
    );
  });
}
