import { clipText } from "@/lib/text";
/** Native Telegram presentation only: no HTML parsing, custom CSS or Web App. */
export const uiText = {
  next: "مرحله بعد ➡️",
  back: "⬅️ مرحله قبل",
  cancel: "✖️ انصراف",
  confirm: "✅ تأیید نهایی",
} as const;
const digits = new Intl.NumberFormat("fa-IR", { useGrouping: false });
export function progress(current: number, total: number): string {
  const n = Math.min(8, total);
  const filled = Math.max(1, Math.ceil((current / total) * n));
  return `${digits.format(current)}/${digits.format(total)}  ${"●".repeat(filled)}${"○".repeat(n - filled)}`;
}
export function card(title: string, lines: string[]): string {
  return `${title}\n━━━━━━━━━━━━━━━━\n${lines.filter(Boolean).join("\n")}`;
}
export function displayValue(value: unknown): string {
  if (value === undefined) return "هنوز وارد نشده";
  if (value === null || value === "") return "خالی / ندارد";
  return clipText(String(value), 1100);
}
