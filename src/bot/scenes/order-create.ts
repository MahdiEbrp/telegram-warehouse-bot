import { InlineKeyboard } from "grammy";
import type { BotConversation, InnerContext } from "@/types/bot";
import { nameInput, phoneInput, telegramIdInput, plainText, optionalText } from "@/lib/validation";
import { calculateTotal, money } from "@/lib/money";
import { Wizard } from "./wizard";
import { cartEditor, cartSummary, type CartLine } from "./cart";
import { backHome } from "@/bot/keyboards/common";
interface OrderForm {
  cart: CartLine[];
  telegramId: number;
  name: string;
  phone: string;
  address: string;
  notes: string;
}
export async function orderCreate(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "oc", "orders:create");
  await w
    .form<OrderForm>("ثبت سفارش", { cart: [], notes: "" })
    .onChange((key, d) => {
      if (key === "telegramId") {
        delete d.name;
        delete d.phone;
        delete d.address;
      }
    })
    .custom("cart", "اقلام سبد", (editor) => cartEditor(w, editor))
    .text(
      "telegramId",
      "شناسهٔ عددی تلگرام مشتری؛ دسترسی مدیریتی ایجاد نمی‌شود.",
      telegramIdInput,
      { hint: "تغییر شناسه، نام و تلفن و نشانی مشتری را برای تکمیل مجدد پاک می‌کند." },
    )
    .text("name", "نام کامل مشتری", nameInput)
    .text("phone", "شمارهٔ تماس مشتری", phoneInput)
    .text("address", "نشانی کامل ارسال", plainText(500).min(5, "نشانی حداقل ۵ نویسه باشد."))
    .text(
      "notes",
      "توضیحات سفارش (اختیاری)",
      optionalText(plainText(500)).transform((v) => v ?? ""),
      { clear: { label: "⏭ بدون توضیحات", value: "" } },
    )
    .complete({
      preview: (d) =>
        `✅ پیش‌فاکتور\n${cartSummary(d.cart)}\nجمع: ${money(calculateTotal(d.cart.map((p) => ({ unitPrice: p.expectedUnitPrice, quantity: p.quantity }))))}\nمشتری: ${d.name} | ${d.phone}\nشناسه مشتری: ${d.telegramId}\nنشانی: ${d.address}\nتوضیحات: ${d.notes || "—"}\nموجودی فقط پس از تأیید رزرو می‌شود؛ پرداخت «پرداخت‌نشده» است.`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.orders.create(
            outer.principal.id,
            {
              customer: {
                telegramId: d.telegramId,
                name: d.name,
                phone: d.phone,
                address: d.address,
              },
              items: d.cart.map(({ productId, quantity, expectedUnitPrice }) => ({
                productId,
                quantity,
                expectedUnitPrice,
              })),
              notes: d.notes,
            },
            w.key("create"),
            outer.lease,
          ),
        ),
      success: (r) =>
        `✅ سفارش ثبت شد.\nشماره: ${r.orderNumber}\nکد پیگیری سفارش: ${r.referenceCode}\nجمع: ${money(r.totalAmount)}`,
      keyboard: (r) =>
        backHome(
          new InlineKeyboard()
            .text("🧾 مشاهده سفارش", `o:view:${r.id}`)
            .primary()
            .row()
            .text("➕ سفارش جدید", "o:new"),
        ),
    });
}
