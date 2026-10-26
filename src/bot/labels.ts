import type { OrderStatus, PaymentStatus, Role } from "@/types/domain";
export const statusLabel: Record<OrderStatus, string> = {
  pending: "در انتظار تأیید",
  confirmed: "تأییدشده",
  processing: "در حال آماده‌سازی",
  shipped: "ارسال‌شده",
  delivered: "تحویل‌شده",
  cancelled: "لغوشده",
};
export const paymentLabel: Record<PaymentStatus, string> = {
  unpaid: "پرداخت‌نشده",
  paid: "پرداخت‌شده",
  refunded: "بازپرداخت ثبت‌شده",
};
export const roleLabel: Record<Role, string> = {
  super_admin: "مدیرکل",
  admin: "مدیر",
  operator: "اپراتور",
  viewer: "مشاهده‌گر",
};
