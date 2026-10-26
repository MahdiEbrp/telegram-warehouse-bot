import { InlineKeyboard } from "grammy";
import type { Page } from "@/types/domain";
export function homeOnly() {
  return new InlineKeyboard().text("🏠 منوی اصلی", "m:home");
}
export function addPager<T>(keyboard: InlineKeyboard, page: Page<T>, prefix: string) {
  keyboard.row();
  if (page.page > 0) keyboard.text("⬅️ قبلی", `${prefix}:${page.page - 1}`);
  else keyboard.disabled("⬅️ قبلی");
  keyboard.disabled(`${page.page + 1} / ${page.pages}`);
  if (page.page + 1 < page.pages) keyboard.text("بعدی ➡️", `${prefix}:${page.page + 1}`);
  else keyboard.disabled("بعدی ➡️");
  return keyboard;
}
export function backHome(keyboard: InlineKeyboard) {
  return keyboard.row().text("🏠 منوی اصلی", "m:home");
}
