import type { BotConversation, InnerContext } from "@/types/bot";
import { roles, type Role } from "@/types/domain";
import { nameInput, telegramIdInput, plainText, optionalText } from "@/lib/validation";
import { Wizard } from "./wizard";
import { categoryEditor, productEditor, type SelectedProduct } from "./selections";
import { money } from "@/lib/money";
import { roleLabel } from "@/bot/labels";

export async function userAdd(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "um", "users:manage");
  await w
    .form<{ telegramId: number; firstName: string; role: Role }>("افزودن کاربر")
    .text("telegramId", "شناسهٔ عددی تلگرام کاربر جدید", telegramIdInput)
    .text("firstName", "نام کاربر", nameInput)
    .select(
      "role",
      "نقش و سطح دسترسی",
      roles.map((role) => [{ label: roleLabel[role], value: role }]),
      { display: (role) => roleLabel[role] },
    )
    .complete({
      preview: (d) =>
        `کاربر: ${d.firstName}\nشناسه: ${d.telegramId}\nنقش: ${roleLabel[d.role]}\nاین حساب فعال می‌شود؛ دسترسی را آگاهانه تأیید کنید.`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.users.save(
            outer.principal.id,
            { ...d, isActive: true },
            w.key("save"),
            outer.lease,
          ),
        ),
      success: () => "✅ دسترسی کاربر ثبت شد.",
    });
}
export async function categoryAdd(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "ca", "products:write");
  let parentLabel = "ریشه";
  await w
    .form<{ name: string; parentId: string | null }>("دسته‌بندی جدید", { parentId: null })
    .text("name", "نام دسته‌بندی جدید", nameInput)
    .custom("parentId", "دسته‌بندی والد؛ برای ریشه، بدون دسته‌بندی را انتخاب کنید.", (editor) =>
      categoryEditor(w, editor, (label) => {
        parentLabel = label;
      }),
    )
    .complete({
      preview: (d) => `دسته‌بندی «${d.name}» ساخته شود؟\nوالد: ${parentLabel}`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.products.createCategory(
            outer.principal.id,
            d.name,
            d.parentId,
            w.key("create"),
            outer.lease,
          ),
        ),
      success: () => "✅ دسته‌بندی ساخته شد.",
    });
}
export async function settingsEdit(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "se", "settings:manage");
  const loaded = await w.external((outer) => outer.services.settings.get(outer.principal.id));
  if (!loaded.ok) {
    await w.finish(loaded.message);
    return;
  }
  await w
    .form<{ name: string; phone: string; address: string; paymentInstructions: string }>(
      "تنظیمات فروشگاه",
      loaded.value,
    )
    .text("name", "نام فروشگاه", nameInput)
    .text(
      "phone",
      "تلفن فروشگاه (اختیاری)",
      optionalText(plainText(50)).transform((value) => value ?? ""),
      { clear: { label: "⏭ بدون تلفن", value: "" } },
    )
    .text(
      "address",
      "نشانی فروشگاه (اختیاری)",
      optionalText(plainText(500)).transform((value) => value ?? ""),
      { clear: { label: "⏭ بدون نشانی", value: "" } },
    )
    .text(
      "paymentInstructions",
      "راهنمای پرداخت دستی؛ واریز واقعی به‌صورت خودکار انجام نمی‌شود.",
      plainText(1000).min(1),
    )
    .complete({
      preview: (d) =>
        `نام: ${d.name}\nتلفن: ${d.phone || "—"}\nنشانی: ${d.address || "—"}\nراهنمای پرداخت:\n${d.paymentInstructions}`,
      submit: (d) =>
        w.external((outer) =>
          outer.services.settings.save(outer.principal.id, d, w.key("save"), outer.lease),
        ),
      success: () => "✅ تنظیمات ذخیره شد.",
    });
}
export async function productSearch(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "ps", "products:read");
  await w
    .form<{ term: string; product: SelectedProduct }>("جستجوی محصول")
    .onChange((key, d) => {
      if (key === "term") delete d.product;
    })
    .text("term", "بخشی از نام یا SKU محصول", plainText(100).min(1))
    .custom("product", "انتخاب نتیجهٔ جستجو", (editor, d) => productEditor(w, editor, d.term!))
    .complete({
      readOnly: true,
      preview: (d) =>
        `📦 ${d.product.name}\nSKU: ${d.product.sku}\nموجودی: ${d.product.stockQuantity}\nقیمت: ${money(d.product.price)}`,
      submit: (d) =>
        w.external(async (outer) => {
          const p = await outer.services.products.get(outer.principal.id, d.product.id);
          return { name: p.name, sku: p.sku, stockQuantity: p.stockQuantity, price: p.price };
        }),
      success: (p) =>
        `📦 ${p.name}\nSKU: ${p.sku}\nموجودی: ${p.stockQuantity}\nقیمت: ${money(p.price)}`,
    });
}
