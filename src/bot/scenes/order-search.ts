import { clipText } from "@/lib/text";
import { InlineKeyboard } from "grammy";
import type { BotConversation, InnerContext } from "@/types/bot";
import { plainText } from "@/lib/validation";
import { Wizard } from "./wizard";
import { statusLabel } from "@/bot/labels";
import { backHome } from "@/bot/keyboards/common";
interface FoundOrder {
  id: string;
  referenceCode: string;
  customerName: string;
  status: keyof typeof statusLabel;
}
export async function orderSearch(conversation: BotConversation, ctx: InnerContext) {
  const w = await Wizard.create(conversation, ctx, "os", "orders:read");
  await w
    .form<{ query: string; order: FoundOrder }>("جستجوی سفارش")
    .onChange((key, d) => {
      if (key === "query") delete d.order;
    })
    .text(
      "query",
      "کد REF، شماره ORD، کد مرسوله، نام مشتری یا تلفن (فقط کارکنان)",
      plainText(100).min(2),
    )
    .custom("order", "انتخاب نتیجهٔ جستجو", (editor, d) =>
      w.select(
        editor,
        async (pageNumber) => {
          const result = await w.external(async (outer) => {
            const page = await outer.services.orders.list(
              outer.principal.id,
              pageNumber,
              "all",
              d.query!,
            );
            return {
              ...page,
              items: page.items.map((o) => ({
                id: o.id,
                referenceCode: o.referenceCode ?? o.orderNumber,
                customerName: o.customerName,
                status: o.status,
              })),
            };
          });
          if (!result.ok) {
            await w.finish(result.message);
            return null;
          }
          const page = result.value;
          return {
            page: page.page,
            pages: page.pages,
            empty: page.total
              ? ""
              : "سفارشی با این کد یا مشخصات پیدا نشد؛ با مرحله قبل جستجو را اصلاح کنید.",
            rows: page.items.map((order) => [
              {
                label: `${order.referenceCode} | ${clipText(order.customerName, 25)} | ${statusLabel[order.status]}`,
                value: order,
              },
            ]),
          };
        },
        { identity: (o) => o.id, display: (o) => `${o.referenceCode} | ${o.customerName}` },
      ),
    )
    .complete({
      readOnly: true,
      preview: (d) =>
        `🧾 ${d.order.referenceCode}\nمشتری: ${d.order.customerName}\nوضعیت: ${statusLabel[d.order.status]}`,
      submit: (d) =>
        w.external(async (outer) => {
          const o = await outer.services.orders.get(outer.principal.id, d.order.id);
          return {
            id: o.id,
            referenceCode: o.referenceCode,
            customerName: o.customerName,
            status: o.status,
          };
        }),
      success: (o) =>
        `🧾 کد پیگیری سفارش: ${o.referenceCode}\nمشتری: ${o.customerName}\nوضعیت: ${statusLabel[o.status]}`,
      keyboard: (o) =>
        backHome(new InlineKeyboard().text("🧾 مشاهده سفارش", `o:view:${o.id}`).primary()),
    });
}
