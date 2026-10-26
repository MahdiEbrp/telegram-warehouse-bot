import { z } from "zod";
import { wellFormedText } from "./text";
import { publicHttpsInput } from "./urls";
import { MAX_MONEY, MAX_PRICE, MAX_STOCK, roles } from "@/types/domain";

export function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
export function plainText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `حداکثر ${max} نویسه مجاز است.`)
    .refine(
      (value) =>
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) && wellFormedText(value),
      "متن حاوی نویسهٔ کنترلی یا Unicode نامعتبر است.",
    );
}
export function optionalText<T>(schema: z.ZodType<T>): z.ZodType<T | null> {
  return z.string().transform((raw, ctx) => {
    if (raw.trim() === "" || raw.trim() === "-") return null;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message: parsed.error.issues[0]?.message ?? "مقدار نامعتبر است.",
      });
      return z.NEVER;
    }
    return parsed.data;
  });
}
export const nameInput = plainText(100)
  .min(2, "حداقل ۲ نویسه وارد کنید.")
  .max(100, "حداکثر ۱۰۰ نویسه مجاز است.")
  .refine((value) => !/[\r\n\t]/.test(value), "نام باید در یک سطر باشد.");
export const skuInput = z
  .string()
  .trim()
  .transform((v) => normalizeDigits(v).toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/, "SKU باید ۲ تا ۴۰ نویسهٔ لاتین/عدد/خط تیره باشد."),
  );
export function integerInput(max: number, min = 0) {
  return z
    .string()
    .transform((v) => normalizeDigits(v.trim()).replace(/[,٬]/g, ""))
    .pipe(z.string().regex(/^\d+$/, "فقط عدد صحیح وارد کنید."))
    .transform(Number)
    .pipe(
      z.number().int().min(min, `حداقل مقدار ${min} است.`).max(max, `حداکثر مقدار ${max} است.`),
    );
}
export const priceInput = integerInput(MAX_PRICE);
export const stockInput = integerInput(MAX_STOCK);
export const quantityInput = integerInput(MAX_STOCK, 1);
export const telegramIdInput = integerInput(Number.MAX_SAFE_INTEGER, 1);
export const phoneInput = z
  .string()
  .transform((v) => normalizeDigits(v).replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, "شماره تلفن معتبر وارد کنید؛ ۷ تا ۱۵ رقم."));
export const uuid = z.uuid();
export const imageUrlInput = publicHttpsInput(1024);
export const productInput = z.object({
  name: nameInput,
  sku: skuInput,
  price: z.number().int().min(0).max(MAX_PRICE),
  costPrice: z.number().int().min(0).max(MAX_PRICE).default(0),
  stockQuantity: z.number().int().min(0).max(MAX_STOCK),
  minStockLevel: z.number().int().min(0).max(MAX_STOCK).default(5),
  categoryId: uuid.nullable().default(null),
  description: plainText(1000).nullable().default(null),
  imageUrl: imageUrlInput.nullable().default(null),
});
export type ProductInput = z.input<typeof productInput>;
// PATCH schemas intentionally have NO defaults: editing a name must not reset cost/category.
export const productPatch = z
  .object({
    name: nameInput,
    sku: skuInput,
    price: z.number().int().min(0).max(MAX_PRICE),
    costPrice: z.number().int().min(0).max(MAX_PRICE),
    minStockLevel: z.number().int().min(0).max(MAX_STOCK),
    categoryId: uuid.nullable(),
    description: plainText(1000).nullable(),
    imageUrl: imageUrlInput.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "No fields to update");
export const customerInput = z.object({
  telegramId: z.number().int().positive().max(MAX_MONEY),
  name: nameInput,
  phone: phoneInput,
  address: plainText(500).min(5),
});
export const orderInput = z.object({
  customer: customerInput,
  items: z
    .array(
      z.object({
        productId: uuid,
        quantity: z.number().int().min(1).max(MAX_STOCK),
        expectedUnitPrice: z.number().int().min(0).max(MAX_PRICE),
      }),
    )
    .min(1)
    .max(20),
  notes: plainText(500).default(""),
});
export const userInput = z.object({
  telegramId: z.number().int().positive().max(MAX_MONEY),
  firstName: plainText(100).min(1),
  role: z.enum(roles),
  isActive: z.boolean(),
});
export const storeInput = z.object({
  name: nameInput,
  phone: plainText(50),
  address: plainText(500),
  paymentInstructions: plainText(1000).min(1),
});
export type StoreSettings = z.infer<typeof storeInput>;
