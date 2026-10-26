import type { BotConversation, InnerContext } from "@/types/bot";
import { nameInput, priceInput, skuInput, stockInput } from "@/lib/validation";
import { money } from "@/lib/money";
import { Wizard } from "./wizard";
import { categoryEditor } from "./selections";
interface ProductForm {
  name: string;
  sku: string;
  price: number;
  stockQuantity: number;
  categoryId: string | null;
}
export async function productAdd(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "pa", "products:write");
  let categoryLabel = "بدون دسته‌بندی";
  await w
    .form<ProductForm>("افزودن محصول", { categoryId: null })
    .text("name", "نام محصول را وارد کنید.", nameInput)
    .text("sku", "SKU یکتا؛ مانند SKU-001", skuInput)
    .text("price", "قیمت فروش به تومان (عدد صحیح)", priceInput)
    .text("stockQuantity", "موجودی اولیه", stockInput)
    .custom("categoryId", "دسته‌بندی محصول", (editor) =>
      categoryEditor(w, editor, (label) => {
        categoryLabel = label;
      }),
    )
    .complete({
      preview: (d) =>
        `📦 پیش‌نمایش محصول\nنام: ${d.name}\nSKU: ${d.sku}\nقیمت: ${money(d.price)}\nموجودی: ${d.stockQuantity}\nدسته‌بندی: ${categoryLabel}\nحداقل موجودی پیش‌فرض: ۵\nبهای خرید پیش‌فرض: ۰ (قابل ویرایش)`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.products.create(outer.principal.id, d, w.key("create"), outer.lease),
        ),
      success: () => "✅ محصول با موفقیت ثبت شد.",
    });
}
