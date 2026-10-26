import { z } from "zod";
import type { BotConversation, InnerContext } from "@/types/bot";
import {
  nameInput,
  priceInput,
  skuInput,
  stockInput,
  plainText,
  optionalText,
  imageUrlInput,
} from "@/lib/validation";
import { Wizard } from "./wizard";
import { categoryEditor } from "./selections";
import type { FieldEditor } from "./wizard";
const fields = [
  "name",
  "sku",
  "price",
  "costPrice",
  "minStockLevel",
  "categoryId",
  "description",
  "imageUrl",
] as const;
type Field = (typeof fields)[number];
const labels: Record<Field, string> = {
  name: "نام",
  sku: "SKU",
  price: "قیمت فروش",
  costPrice: "بهای خرید",
  minStockLevel: "حداقل موجودی",
  categoryId: "دسته‌بندی",
  description: "توضیحات",
  imageUrl: "لینک تصویر",
};
interface ProductEditForm {
  field: Field;
  value: string | number | null;
}
export async function productEdit(conversation: BotConversation, ctx: InnerContext, id: string) {
  const w = await Wizard.create(conversation, ctx, "pe", "products:write");
  const loaded = await w.external(async (outer) => {
    const p = await outer.services.products.get(outer.principal.id, id);
    return {
      name: p.name,
      sku: p.sku,
      price: p.price,
      costPrice: p.costPrice,
      minStockLevel: p.minStockLevel,
      categoryId: p.categoryId,
      description: p.description,
      imageUrl: p.imageUrl,
    };
  });
  if (!loaded.ok) {
    await w.finish(loaded.message);
    return;
  }
  const values: Record<Field, string | number | null> = { ...loaded.value };
  let categoryLabel = "بدون دسته‌بندی";
  await w
    .form<ProductEditForm>("ویرایش محصول")
    .onChange((key, d) => {
      if (key === "field") d.value = values[d.field!];
      else if (key === "value" && d.field) values[d.field] = d.value!;
    })
    .select(
      "field",
      "کدام مشخصهٔ محصول ویرایش شود؟",
      fields.map((field) => [{ label: labels[field], value: field }]),
      { display: (value) => labels[value] },
    )
    .custom("value", "مقدار جدید مشخصهٔ انتخاب‌شده", async (editor, d) => {
      const field = d.field!;
      const input = { ...editor, meta: { ...editor.meta, label: `مقدار جدید • ${labels[field]}` } };
      if (field === "categoryId")
        return categoryEditor(w, input as FieldEditor<string | null>, (label) => {
          categoryLabel = label;
        });
      const schema: z.ZodType<string | number | null> =
        field === "name"
          ? nameInput
          : field === "sku"
            ? skuInput
            : field === "price" || field === "costPrice"
              ? priceInput
              : field === "minStockLevel"
                ? stockInput
                : field === "imageUrl"
                  ? optionalText(imageUrlInput)
                  : optionalText(plainText(1000));
      return w.input(
        input,
        schema,
        ["description", "imageUrl"].includes(field)
          ? { clear: { label: "⏭ پاک‌کردن مقدار", value: null } }
          : {},
      );
    })
    .complete({
      preview: (d) =>
        `مشخصه: ${labels[d.field]}\nمقدار جدید: ${d.field === "categoryId" ? categoryLabel : (d.value ?? "خالی")}\nسایر مشخصه‌ها تغییر نمی‌کنند.`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.products.update(
            outer.principal.id,
            id,
            { [d.field]: d.value },
            w.key("update"),
            outer.lease,
          ),
        ),
      success: () => "✅ مشخصات محصول ویرایش شد.",
    });
}
