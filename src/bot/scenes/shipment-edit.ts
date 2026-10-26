import type { BotConversation, InnerContext } from "@/types/bot";
import { carriers, type Carrier } from "@/types/domain";
import {
  carrierLabels,
  carrierLabel,
  canEditShipment,
  canAddShipment,
  shipmentCarrierNameInput,
  shipmentNoteInput,
  trackingNumberInput,
  trackingRequired,
  postalCodeInput,
  trackingUrlInput,
} from "@/lib/shipping";
import { priceInput, optionalText, plainText } from "@/lib/validation";
import { money } from "@/lib/money";
import { Wizard } from "./wizard";
import { shipmentActions } from "@/bot/handlers/shipping";
interface ShippingForm {
  carrier: Carrier;
  carrierName: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  postalCode: string | null;
  shippingCost: number;
  note: string;
  reason: string;
}
export async function shipmentEdit(
  conversation: BotConversation,
  ctx: InnerContext,
  orderId: string,
  shipmentId?: string,
) {
  const w = await Wizard.create(conversation, ctx, "sm", "orders:shipping");
  const loaded = await w.external(async (outer) => {
    const order = await outer.services.orders.get(outer.principal.id, orderId);
    const row = shipmentId ? order.shipments.find((p) => p.id === shipmentId) : undefined;
    return {
      status: order.status,
      referenceCode: order.referenceCode,
      editable: shipmentId
        ? !!row && canEditShipment(outer.principal.role, order.status, row.state)
        : canAddShipment(outer.principal.role, order.status, order.shipments.length),
      shipment: row
        ? {
            id: row.id,
            parcelNumber: row.parcelNumber,
            version: row.version,
            carrier: row.carrier,
            carrierName: row.carrierName,
            trackingNumber: row.trackingNumber,
            trackingUrl: row.trackingUrl,
            postalCode: row.postalCode,
            shippingCost: row.shippingCost,
            note: row.note,
          }
        : null,
    };
  });
  if (!loaded.ok) {
    await w.finish(loaded.message);
    return;
  }
  if (!loaded.value.editable) {
    await w.finish("⛔ این سفارش قابل ویرایش ارسال نیست؛ اصلاح سفارش تحویل‌شده فقط با مدیر است.");
    return;
  }
  const old = loaded.value.shipment,
    revision = old ? { id: old.id, version: old.version } : null;
  const needsReason = !!old || ["shipped", "delivered"].includes(loaded.value.status);
  const code = trackingNumberInput.refine(
    (value) => value.toUpperCase() !== loaded.value.referenceCode,
    "این کد پیگیری سفارش است؛ کد واقعی شرکت حمل را وارد کنید.",
  );
  await w
    .form<ShippingForm>(`ارسال • ${loaded.value.referenceCode}`, {
      ...(old ? { carrier: old.carrier } : {}),
      carrierName: old?.carrierName ?? "",
      trackingNumber: old?.trackingNumber ?? null,
      trackingUrl: old?.trackingUrl ?? null,
      postalCode: old?.postalCode ?? null,
      shippingCost: old?.shippingCost ?? 0,
      note: old?.note ?? "",
      reason: "",
    })
    .onChange((key, d) => {
      if (key === "carrier") {
        d.carrierName = "";
        d.trackingNumber = null;
        d.trackingUrl = null;
      }
    })
    .select(
      "carrier",
      "شرکت / روش حمل",
      carriers.map((carrier) => [{ label: carrierLabels[carrier], value: carrier }]),
      { display: (carrier) => carrierLabels[carrier] },
    )
    .text(
      "carrierName",
      "نام شرکت حمل",
      shipmentCarrierNameInput.min(2, "نام شرکت حداقل ۲ نویسه باشد."),
      {
        when: (d) => d.carrier === "other",
      },
    )
    .text(
      "trackingNumber",
      "کد رهگیری واقعی شرکت حمل؛ متفاوت از REF سفارش",
      (d) => (trackingRequired(d.carrier!) ? code : optionalText(code)),
      {
        field: (d) =>
          trackingRequired(d.carrier!)
            ? {}
            : { clear: { label: "⏭ بدون بارکد (پیک / حضوری)", value: null } },
      },
    )
    .text(
      "trackingUrl",
      "لینک HTTPS اختصاصی (اختیاری؛ بدون استعلام زنده)",
      optionalText(trackingUrlInput),
      { clear: { label: "⏭ سامانهٔ پیش‌فرض شرکت / بدون لینک", value: null } },
    )
    .text("postalCode", "کد پستی ۱۰ رقمی گیرنده (اختیاری)", optionalText(postalCodeInput), {
      clear: { label: "⏭ بدون کد پستی", value: null },
    })
    .text("shippingCost", "هزینهٔ داخلی حمل به تومان؛ به مبلغ مشتری افزوده نمی‌شود.", priceInput)
    .text(
      "note",
      "یادداشت ارسال (اختیاری)",
      optionalText(shipmentNoteInput).transform((value) => value ?? ""),
      { clear: { label: "⏭ بدون یادداشت", value: "" } },
    )
    .text(
      "reason",
      "علت اصلاح یا تکمیل اطلاعات قدیمی؛ در تاریخچه ثبت می‌شود.",
      plainText(200).min(3, "علت حداقل ۳ نویسه باشد."),
      { when: () => needsReason },
    )
    .complete({
      preview: (d) =>
        `🚚 اطلاعات ارسال\nمرسوله: ${old ? `#${old.parcelNumber}` : "جدید"}\nشرکت: ${carrierLabel(d.carrier, d.carrierName)}\nکد: ${d.trackingNumber ?? "بدون بارکد"}\nکد پستی: ${d.postalCode ?? "—"}\nهزینهٔ داخلی: ${money(d.shippingCost)}\nلینک: ${d.trackingUrl ?? "پیش‌فرض / ندارد"}\nیادداشت: ${d.note || "—"}\nعلت: ${d.reason || "ثبت اولیه"}\nاین عمل وضعیت را ارسال‌شده نمی‌کند و هیچ پیامی به مشتری نمی‌فرستد.`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.shipments.save(
            outer.principal.id,
            orderId,
            d,
            revision,
            d.reason,
            w.key("save"),
            outer.lease,
          ),
        ),
      success: () =>
        "✅ اطلاعات ارسال و کد رهگیری ثبت شد؛ برای ثبت زمان، ارسال همین مرسوله یا وضعیت کل سفارش را تأیید کنید.",
      keyboard: shipmentActions(orderId),
    });
}
export async function shipmentClear(
  conversation: BotConversation,
  ctx: InnerContext,
  orderId: string,
  shipmentId?: string,
) {
  const w = await Wizard.create(conversation, ctx, "sm", "orders:shipping");
  const loaded = await w.external(async (outer) => {
    const o = await outer.services.orders.get(outer.principal.id, orderId);
    const row = shipmentId ? o.shipments.find((p) => p.id === shipmentId) : o.shipment;
    return {
      status: o.status,
      shipment:
        row && row.state === "draft"
          ? { id: row.id, version: row.version, parcelNumber: row.parcelNumber }
          : null,
    };
  });
  if (!loaded.ok) {
    await w.finish(loaded.message);
    return;
  }
  const parcel = loaded.value.shipment;
  if (!parcel || !["pending", "confirmed", "processing"].includes(loaded.value.status)) {
    await w.finish("فقط پیش‌نویس ارسال سفارشِ هنوز ارسال‌نشده قابل پاک‌کردن است.");
    return;
  }
  await w
    .form<{ reason: string }>(`پاک‌کردن پیش‌نویس #${parcel.parcelNumber}`)
    .text(
      "reason",
      "علت پاک‌کردن؛ سابقه حذف نمی‌شود.",
      plainText(200).min(3, "علت حداقل ۳ نویسه باشد."),
    )
    .complete({
      preview: (d) =>
        `پیش‌نویس #${parcel.parcelNumber} پاک شود؟\nعلت: ${d.reason}\nموجودی، پرداخت و REF تغییر نمی‌کنند. وضعیت کل ممکن است بر اساس مرسوله‌های باقی‌مانده به‌روز شود.`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.shipments.clearDraft(
            outer.principal.id,
            orderId,
            parcel,
            d.reason,
            w.key("clear"),
            outer.lease,
          ),
        ),
      success: () => "✅ پیش‌نویس ارسال پاک شد؛ سابقهٔ تغییر محفوظ است.",
      keyboard: shipmentActions(orderId),
    });
}
