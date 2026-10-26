import type { Context } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { User } from "@/db/schema";
import type { Services } from "@/db/queries";
import type { Lease } from "./domain";
export type BotContext = ConversationFlavor<
  Context & { principal: User; services: Services; lease: Lease; callbackAnswered?: boolean }
>;
// Inner conversation contexts must NOT have ConversationFlavor.
export type InnerContext = Context;
export type BotConversation = Conversation<BotContext, InnerContext>;
