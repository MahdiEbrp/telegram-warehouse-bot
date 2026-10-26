import { clipText } from "@/lib/text";
import type { Wizard, FieldEditor } from "./wizard";

export interface SelectedProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  stockQuantity: number;
}
export async function categoryEditor(
  wizard: Wizard,
  editor: FieldEditor<string | null>,
  onDisplay?: (label: string) => void,
) {
  const labels = new Map<string, string>();
  const current = editor.get();
  if (current) {
    const loaded = await wizard.external((ctx) =>
      ctx.services.products.getCategory(ctx.principal.id, current),
    );
    if (loaded.ok) labels.set(loaded.value.id, loaded.value.name);
  }
  const label = (id: string | null) =>
    id === null ? "بدون دسته‌بندی / ریشه" : (labels.get(id) ?? "دستهٔ انتخاب‌شده");
  if (current !== undefined) onDisplay?.(label(current));
  return wizard.select(
    {
      ...editor,
      set: (value) => {
        editor.set(value);
        onDisplay?.(label(value));
      },
    },
    async (pageNumber) => {
      const result = await wizard.external((ctx) =>
        ctx.services.products.categories(ctx.principal.id, pageNumber),
      );
      if (!result.ok) {
        await wizard.finish(result.message);
        return null;
      }
      for (const c of result.value.items) labels.set(c.id, c.name);
      return {
        page: result.value.page,
        pages: result.value.pages,
        rows: [
          ...result.value.items.map((c) => [{ label: c.name, value: c.id as string | null }]),
          [{ label: "بدون دسته‌بندی / ریشه", value: null }],
        ],
      };
    },
    { display: label },
  );
}
export async function productEditor(
  wizard: Wizard,
  editor: FieldEditor<SelectedProduct>,
  search = "",
  requireStock = false,
) {
  return wizard.select(
    editor,
    async (pageNumber) => {
      const result = await wizard.external(async (ctx) => {
        const page = await ctx.services.products.list(ctx.principal.id, pageNumber, search);
        return {
          page: page.page,
          pages: page.pages,
          total: page.total,
          items: page.items.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            price: p.price,
            stockQuantity: p.stockQuantity,
          })),
        };
      });
      if (!result.ok) {
        await wizard.finish(result.message);
        return null;
      }
      return {
        page: result.value.page,
        pages: result.value.pages,
        empty: result.value.total ? "" : "محصولی پیدا نشد؛ با مرحله قبل، جستجو را اصلاح کنید.",
        rows: result.value.items.map((p) => [
          {
            label: `${clipText(p.name, 35)} | موجودی ${p.stockQuantity}`,
            value: p,
            disabled: requireStock && p.stockQuantity <= 0,
          },
        ]),
      };
    },
    {
      identity: (value) => value.id,
      display: (value) =>
        `${value.name} | ${value.sku} | موجودی هنگام انتخاب: ${value.stockQuantity}`,
    },
  );
}
