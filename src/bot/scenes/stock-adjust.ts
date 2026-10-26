import type { BotConversation, InnerContext } from "@/types/bot";
import { stockInput } from "@/lib/validation";
import { MAX_STOCK } from "@/types/domain";
import { Wizard } from "./wizard";
export async function stockAdjust(conversation: BotConversation, ctx: InnerContext, id: string) {
  const w = await Wizard.create(conversation, ctx, "st", "inventory:write");
  const product = await w.external(async (outer) => {
    const p = await outer.services.products.get(outer.principal.id, id);
    return { name: p.name, stock: p.stockQuantity };
  });
  if (!product.ok) {
    await w.finish(product.message);
    return;
  }
  let expected = product.value.stock;
  await w
    .form<{ stock: number }>("تنظیم موجودی", { stock: expected })
    .custom("stock", `موجودی • ${product.value.name}`, async (editor) => {
      for (;;) {
        const value = editor.get()!;
        const action = await w.menu(
          editor.meta,
          `📦 ${product.value.name}\nموجودی هنگام شروع: ${expected}\nموجودی پیشنهادی: ${value}\nکاهش/افزایش فقط پیش‌نویس را تغییر می‌دهد.`,
          [
            [
              { label: "−۱۰", value: "minus10", disabled: value < 10 },
              { label: "−۱", value: "minus", disabled: value === 0 },
              { label: String(value), value: "value", disabled: true },
              { label: "+۱", value: "plus", disabled: value >= MAX_STOCK },
              { label: "+۱۰", value: "plus10", disabled: value > MAX_STOCK - 10 },
            ],
            [
              { label: "⌨️ ورود عددی", value: "number" },
              { label: "🔄 موجودی تازه", value: "refresh" },
            ],
            [{ label: "مرحله بعد ➡️", value: "next" }],
          ],
        );
        if (action === null) return "cancel";
        if (action === "back") return "back";
        if (action === "next") return "next";
        if (action === "refresh") {
          const fresh = await w.external(
            async (outer) =>
              (await outer.services.products.get(outer.principal.id, id)).stockQuantity,
          );
          if (!fresh.ok) {
            await w.finish(fresh.message);
            return "cancel";
          }
          expected = fresh.value;
          editor.set(expected);
          continue;
        }
        if (action === "number") {
          const nav = await w.input(
            { ...editor, meta: { ...editor.meta, label: "موجودی نهایی جدید", back: true } },
            stockInput,
          );
          if (nav === "cancel") return nav;
          continue;
        }
        editor.set(
          Math.max(
            0,
            Math.min(
              MAX_STOCK,
              value + ({ minus10: -10, minus: -1, plus: 1, plus10: 10 }[action] ?? 0),
            ),
          ),
        );
      }
    })
    .complete({
      preview: (d) =>
        `موجودی از ${expected} به ${d.stock} تغییر کند؟\nاگر موجودی در حین ویزارد تغییر کرده باشد، ثبت رد می‌شود؛ مقدار جدید بی‌صدا بازنویسی نمی‌شود.`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.products.adjustStock(
            outer.principal.id,
            id,
            expected,
            d.stock,
            w.key("adjust"),
            outer.lease,
          ),
        ),
      success: () => "✅ موجودی تنظیم و گردش انبار ثبت شد.",
    });
}
