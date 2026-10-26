import { clipText } from "@/lib/text";
import type { FieldEditor, Navigation, Wizard } from "./wizard";
import { productEditor, type SelectedProduct } from "./selections";
import { calculateTotal, money } from "@/lib/money";
import { quantityInput } from "@/lib/validation";
export interface CartLine {
  productId: string;
  name: string;
  quantity: number;
  expectedUnitPrice: number;
  available: number;
}
const total = (cart: CartLine[]) =>
  calculateTotal(cart.map((p) => ({ unitPrice: p.expectedUnitPrice, quantity: p.quantity })));
export function cartSummary(cart: CartLine[]) {
  return cart
    .map(
      (p, i) =>
        `${i + 1}. ${clipText(p.name, 45)} × ${p.quantity} — ${money(p.expectedUnitPrice * p.quantity)}`,
    )
    .join("\n");
}
export async function cartEditor(w: Wizard, editor: FieldEditor<CartLine[]>): Promise<Navigation> {
  let cart = [...(editor.get() ?? [])],
    stage: "cart" | "product" | "quantity" = cart.length ? "cart" : "product";
  let product: SelectedProduct | undefined,
    quantity: number | undefined,
    editIndex: number | undefined;
  let pending: { product: SelectedProduct; quantity: number | undefined } | undefined;
  let error = "";
  const publish = () => editor.set(cart.map((line) => ({ ...line })));
  for (;;) {
    if (stage === "product") {
      const nav = await productEditor(
        w,
        {
          meta: {
            ...editor.meta,
            label: "سبد • انتخاب کالا",
            back: cart.length > 0,
            hint: "انتخاب کالا موجودی را رزرو نمی‌کند؛ ثبت نهایی دوباره موجودی و قیمت را بررسی می‌کند.",
          },
          get: () => product,
          set: (p) => {
            if (p.id !== product?.id) quantity = undefined;
            product = p;
            pending = { product: p, quantity };
          },
        },
        "",
        true,
      );
      if (nav === "cancel") return nav;
      if (nav === "back") {
        stage = "cart";
        continue;
      }
      stage = "quantity";
    }
    if (stage === "quantity") {
      const p = product!;
      const existing = cart.find((line) => line.productId === p.id);
      const inCart = editIndex === undefined ? (existing?.quantity ?? 0) : 0;
      const proposal = (q: number) => {
        const line = {
          productId: p.id,
          name: p.name,
          quantity: q + inCart,
          expectedUnitPrice: p.price,
          available: p.stockQuantity,
        };
        if (editIndex !== undefined)
          return cart.map((old, i) => (i === editIndex ? { ...line, quantity: q } : old));
        return existing
          ? cart.map((old) => (old.productId === p.id ? line : old))
          : [...cart, line];
      };
      const schema = quantityInput
        .refine((q) => q + inCart <= p.stockQuantity, "تعداد از موجودی هنگام انتخاب بیشتر است.")
        .refine((q) => {
          try {
            total(proposal(q));
            return true;
          } catch {
            return false;
          }
        }, "مبلغ از سقف مجاز بیشتر است.");
      const nav = await w.input(
        {
          meta: {
            ...editor.meta,
            label: `تعداد • ${clipText(p.name, 60)}`,
            back: true,
            hint: `قیمت واحد: ${money(p.price)} | موجودی هنگام انتخاب: ${p.stockQuantity}`,
          },
          get: () => quantity,
          set: (q) => {
            quantity = q;
            if (editIndex !== undefined) {
              cart = proposal(q);
              publish();
            } else pending = { product: p, quantity: q };
          },
        },
        schema,
      );
      if (nav === "cancel") return nav;
      if (nav === "back") {
        stage = editIndex === undefined ? "product" : "cart";
        continue;
      }
      cart = proposal(quantity!);
      publish();
      stage = "cart";
      editIndex = undefined;
      pending = undefined;
    }
    if (stage !== "cart") continue;
    const action = await w.menu(
      editor.meta,
      `🛒 سبد سفارش\n${cartSummary(cart) || "سبد خالی است."}\nجمع: ${money(total(cart))}\n${error}`,
      [
        ...cart.map((line, i) => [
          { label: `✏️ ${clipText(line.name, 28)} × ${line.quantity}`, value: `edit.${i}` },
          { label: "🗑 حذف قلم", value: `drop.${i}` },
        ]),
        [{ label: "➕ افزودن کالای دیگر", value: "add", disabled: cart.length >= 20 }],
        [{ label: "🔄 به‌روزکردن قیمت و موجودی", value: "refresh", disabled: cart.length === 0 }],
        [
          {
            label: "مرحله بعد: اطلاعات مشتری ➡️",
            value: "next",
            disabled: cart.length === 0 || cart.some((line) => line.quantity > line.available),
          },
        ],
      ],
    );
    if (action === null) return "cancel";
    if (action === "back") return "back";
    if (action === "next") return "next";
    if (action === "add") {
      product = pending?.product;
      quantity = pending?.quantity;
      editIndex = undefined;
      stage = "product";
      continue;
    }
    if (action === "refresh") {
      const refreshed = await w.external(async (outer) =>
        Promise.all(
          cart.map(async (line) => {
            const p = await outer.services.products.get(outer.principal.id, line.productId);
            return {
              ...line,
              name: p.name,
              expectedUnitPrice: p.price,
              available: p.isActive ? p.stockQuantity : 0,
            };
          }),
        ),
      );
      if (!refreshed.ok) {
        error = refreshed.message;
        continue;
      }
      try {
        total(refreshed.value);
        cart = refreshed.value;
        publish();
        error = "قیمت‌ها به‌روز شدند؛ اگر موجودی کم است، تعداد قلم را اصلاح کنید.";
      } catch {
        error = "جمع قیمت‌های جدید از سقف مجاز بیشتر است؛ تعدادها را کم کنید.";
      }
      continue;
    }
    const match = action.match(/^(edit|drop)\.(\d+)$/);
    if (!match) continue;
    const index = Number(match[2]),
      line = cart[index];
    if (!line) continue;
    if (match[1] === "drop") {
      cart.splice(index, 1);
      publish();
      continue;
    }
    const loaded = await w.external(async (outer) => {
      const p = await outer.services.products.get(outer.principal.id, line.productId);
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: p.price,
        stockQuantity: p.isActive ? p.stockQuantity : 0,
      };
    });
    if (!loaded.ok) {
      error = loaded.message;
      continue;
    }
    product = loaded.value;
    quantity = line.quantity;
    editIndex = index;
    stage = "quantity";
  }
}
