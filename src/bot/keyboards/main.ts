import { InlineKeyboard } from "grammy";
import { can } from "@/lib/permissions";
import type { Role } from "@/types/domain";
export function mainKeyboard(role: Role) {
  const k = new InlineKeyboard();
  if (can(role, "orders:create")) k.text("➕ سفارش جدید", "o:new").primary();
  if (can(role, "products:write")) k.text("➕ محصول جدید", "p:add").success();
  if (k.inline_keyboard.at(-1)?.length) k.row();
  if (can(role, "products:read"))
    k.text(can(role, "products:write") ? "📦 مدیریت محصولات" : "📦 موجودی محصولات", "p:list:0");
  if (can(role, "orders:read")) k.text("🛒 مدیریت سفارشات", "o:list:0");
  if (k.inline_keyboard.at(-1)?.length) k.row();
  if (can(role, "reports:read")) k.text("📊 گزارش‌ها", "r:menu");
  if (can(role, "orders:read")) k.text("🚚 صف آماده‌سازی ارسال", "o:queue:ready:0");
  if (k.inline_keyboard.at(-1)?.length) k.row();
  if (can(role, "users:manage")) k.text("👥 مدیریت کاربران", "u:list:0");
  if (can(role, "settings:manage")) k.text("⚙️ تنظیمات", "s:menu");
  if (k.inline_keyboard.at(-1)?.length) k.row();
  return k.text("❓ راهنمای استفاده", "m:help");
}
