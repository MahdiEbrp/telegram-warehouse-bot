import type { BotResponse, TestBot } from "@bonkers-agency/grammy-test";
import type { Chat, User } from "grammy/types";
import type { BotContext } from "@/types/bot";
import { click, field } from "./telegram";
/** Complete the sequential shipping fields after the explicit carrier + Next interaction. */
export async function fillShipping(
  bot: TestBot<BotContext>,
  user: User,
  chat: Chat,
  current: BotResponse,
  values: Partial<
    Record<
      | "carrierName"
      | "trackingNumber"
      | "trackingUrl"
      | "postalCode"
      | "shippingCost"
      | "note"
      | "reason",
      string
    >
  > = {},
) {
  if (current.text?.includes("نام شرکت حمل"))
    current = await field(bot, user, chat, values.carrierName ?? "شرکت آزمایشی");
  for (const key of [
    "trackingNumber",
    "trackingUrl",
    "postalCode",
    "shippingCost",
    "note",
  ] as const) {
    current =
      values[key] === undefined
        ? await click(bot, user, chat, current, "مرحله بعد ➡️")
        : await field(bot, user, chat, values[key]);
  }
  if (current.text?.includes("علت اصلاح یا تکمیل"))
    current = await field(bot, user, chat, values.reason ?? "اصلاح آزمایشی کارکنان");
  return current;
}
