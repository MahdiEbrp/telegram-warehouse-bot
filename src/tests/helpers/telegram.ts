import type { BotResponse, TestBot } from "@bonkers-agency/grammy-test";
import type { Chat, Message, User } from "grammy/types";
import type { BotContext } from "@/types/bot";
/** Snapshot real sent/edited messages so old-button tests do not mutate with the fake server. */
export function view(response: BotResponse): BotResponse {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(response)) as BotResponse,
    response,
  );
  Object.assign(copy, {
    messages: structuredClone(response.messages),
    editedMessages: structuredClone(response.editedMessages),
  });
  const last = response.apiCalls
    .slice()
    .reverse()
    .find(
      (call) =>
        call.response !== null &&
        typeof call.response === "object" &&
        "message_id" in call.response,
    );
  if (last?.method.startsWith("editMessage"))
    copy.messages.push(structuredClone(last.response) as Message);
  return copy;
}
export async function click(
  bot: TestBot<BotContext>,
  user: User,
  chat: Chat,
  response: BotResponse,
  label: string,
) {
  const message = response.messages.at(-1) ?? response.editedMessages.at(-1);
  const button = response.keyboard?.inline
    ?.flat()
    .find((b) => b.text === label || b.text === `✓ ${label}`);
  if (!button || !("callback_data" in button))
    throw new Error(
      `Clickable button not found: ${label}; text: ${response.text}; buttons: ${JSON.stringify(response.keyboard)}`,
    );
  if (!message) throw new Error("Missing prompt message");
  return view(await bot.clickButton(user, chat, button.callback_data, structuredClone(message)));
}
export async function field(bot: TestBot<BotContext>, user: User, chat: Chat, text: string) {
  return click(bot, user, chat, view(await bot.sendMessage(user, chat, text)), "مرحله بعد ➡️");
}
/** A selection is two explicit button interactions, never an automatic production advance. */
export async function choose(
  bot: TestBot<BotContext>,
  user: User,
  chat: Chat,
  response: BotResponse,
  label: string,
) {
  const selected = await click(bot, user, chat, response, label);
  return click(bot, user, chat, selected, "مرحله بعد ➡️");
}
