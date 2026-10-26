import { publicHttpsInput, safePublicHttpsUrl as safeTrackingUrl } from "./urls";
import { z } from "zod";
import {
  carriers,
  MAX_PRICE,
  MAX_SHIPMENTS_PER_ORDER,
  type Carrier,
  type OrderStatus,
  type Role,
  type ShipmentState,
} from "@/types/domain";
import { normalizeDigits, plainText } from "./validation";
import { can } from "./permissions";

export const carrierLabels: Record<Carrier, string> = {
  iran_post: "پست ایران",
  tipax: "تیپاکس",
  chapar: "چاپار",
  courier: "پیک",
  pickup: "تحویل حضوری",
  other: "سایر شرکت‌ها",
};
export function carrierLabel(carrier: Carrier, name = ""): string {
  return carrier === "other" ? name || carrierLabels.other : carrierLabels[carrier];
}
export function trackingRequired(carrier: Carrier): boolean {
  return carrier !== "courier" && carrier !== "pickup";
}
export const trackingNumberInput = z
  .string()
  .trim()
  .transform((v) => normalizeDigits(v).replace(/\s/g, ""))
  // IDs remain strings, preserve leading zeros and case. This does NOT validate carrier existence.
  .pipe(
    z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_./-]{3,63}$/,
        "کد رهگیری باید ۴ تا ۶۴ نویسهٔ لاتین، عدد یا - _ . / باشد.",
      ),
  );
export const postalCodeInput = z
  .string()
  .trim()
  .transform((v) => normalizeDigits(v).replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^\d{10}$/, "کد پستی باید دقیقاً ۱۰ رقم باشد."));
export { safeTrackingUrl };
export const trackingUrlInput = publicHttpsInput(512);
export const shipmentCarrierNameInput = plainText(60);
export const shipmentNoteInput = plainText(300);

export const shipmentInput = z
  .object({
    carrier: z.enum(carriers),
    carrierName: shipmentCarrierNameInput.default(""),
    trackingNumber: trackingNumberInput.nullable().default(null),
    trackingUrl: trackingUrlInput.nullable().default(null),
    postalCode: postalCodeInput.nullable().default(null),
    shippingCost: z.number().int().min(0).max(MAX_PRICE).default(0),
    note: shipmentNoteInput.default(""),
  })
  .superRefine((value, ctx) => {
    if (trackingRequired(value.carrier) && !value.trackingNumber)
      ctx.addIssue({
        code: "custom",
        path: ["trackingNumber"],
        message: "برای این شرکت حمل، ثبت کد رهگیری الزامی است.",
      });
    if (value.carrier === "other" && value.carrierName.length < 2)
      ctx.addIssue({
        code: "custom",
        path: ["carrierName"],
        message: "نام شرکت حمل را وارد کنید.",
      });
    if (value.carrier !== "other" && value.carrierName !== "")
      ctx.addIssue({
        code: "custom",
        path: ["carrierName"],
        message: "برای شرکت از پیش تعریف‌شده، نام اضافی ثبت نکنید.",
      });
  });
export type ShipmentInput = z.output<typeof shipmentInput>;
export const shipmentRevision = z
  .object({ id: z.uuid(), version: z.number().int().positive() })
  .nullable();
export type ShipmentRevision = z.infer<typeof shipmentRevision>;
export function shipmentReady(value: unknown): boolean {
  return value !== null && value !== undefined && shipmentInput.safeParse(value).success;
}
export function canEditShipment(
  role: Role,
  status: OrderStatus,
  parcelState?: ShipmentState,
): boolean {
  return (
    can(role, "orders:shipping") &&
    status !== "cancelled" &&
    ((status !== "delivered" && parcelState !== "delivered") ||
      can(role, "orders:shipping:correct"))
  );
}
// Open the provider's generic portal; never invent query params or claim live tracking.
export function trackingLink(
  value: Pick<ShipmentInput, "carrier" | "trackingUrl" | "trackingNumber">,
): string | null {
  if (value.trackingUrl && safeTrackingUrl(value.trackingUrl)) return value.trackingUrl;
  if (!value.trackingNumber) return null;
  return (
    {
      iran_post: "https://tracking.post.ir/",
      tipax: "https://tipaxco.com/tracking",
      chapar: "https://chaparnet.com/track/",
      courier: null,
      pickup: null,
      other: null,
    } satisfies Record<Carrier, string | null>
  )[value.carrier];
}

export const shipmentStateLabels: Record<ShipmentState, string> = {
  draft: "آماده‌سازی",
  dispatched: "ارسال‌شده",
  delivered: "تحویل‌شده",
};
export function canAddShipment(role: Role, status: OrderStatus, count: number): boolean {
  return (
    count < MAX_SHIPMENTS_PER_ORDER &&
    canEditShipment(role, status) &&
    (["pending", "confirmed", "processing"].includes(status) || count === 0)
  );
}
