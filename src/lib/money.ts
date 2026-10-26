import { MAX_MONEY, MAX_STOCK } from "@/types/domain";
import { invariant } from "./errors";

export function lineTotal(price: number, quantity: number): number {
  invariant(
    Number.isSafeInteger(price) && price >= 0 && Number.isSafeInteger(quantity) && quantity > 0,
    "BAD_AMOUNT",
    "قیمت یا تعداد نامعتبر است.",
  );
  const total = price * quantity;
  invariant(
    Number.isSafeInteger(total) && total <= MAX_MONEY,
    "AMOUNT_OVERFLOW",
    "مبلغ بیش از محدودهٔ مجاز است.",
  );
  return total;
}
export function calculateTotal(items: readonly { unitPrice: number; quantity: number }[]): number {
  return items.reduce((sum, item) => {
    const total = sum + lineTotal(item.unitPrice, item.quantity);
    invariant(Number.isSafeInteger(total), "AMOUNT_OVERFLOW", "مبلغ بیش از محدودهٔ مجاز است.");
    return total;
  }, 0);
}
export function validateStock(current: number, requested: number): void {
  invariant(
    Number.isSafeInteger(requested) &&
      requested > 0 &&
      requested <= MAX_STOCK &&
      current >= requested,
    "INSUFFICIENT_STOCK",
    "موجودی کافی نیست یا تعداد نامعتبر است.",
  );
}
export function money(value: number): string {
  return `${value.toLocaleString("fa-IR")} تومان`;
}
