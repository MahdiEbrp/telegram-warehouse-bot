import { randomBytes } from "node:crypto";
import { GrammyError, InlineKeyboard } from "grammy";
import type { ZodType } from "zod";
import type { BotContext, BotConversation, InnerContext } from "@/types/bot";
import { can, type Permission } from "@/lib/permissions";
import { DomainError } from "@/lib/errors";
import { mainKeyboard } from "@/bot/keyboards/main";
import { homeOnly } from "@/bot/keyboards/common";
import { card, displayValue, progress, uiText } from "@/bot/ui/cards";
import { WizardForm } from "./wizard-form";

export type Choice = { label: string; value: string; disabled?: boolean };
export type Navigation = "next" | "back" | "cancel";
export type ExternalResult<T> =
  { ok: true; value: T } | { ok: false; message: string; code?: string };
export interface FieldMeta {
  title: string;
  label: string;
  index: number;
  total: number;
  back: boolean;
  hint?: string;
}
export interface FieldEditor<T> {
  meta: FieldMeta;
  get(): T | undefined;
  set(value: T): void;
}
export interface FieldOptions<T> {
  clear?: { label: string; value: T };
  format?: (value: T) => string;
}
export interface SelectOption<T> {
  label: string;
  value: T;
  disabled?: boolean;
}
export interface SelectPage<T> {
  rows: SelectOption<T>[][];
  page?: number;
  pages?: number;
  empty?: string;
}
// Caps adversarial replay growth; a normal 20-item order is comfortably below this.
export const MAX_WIZARD_EVENTS = 300;
export class Wizard {
  private sequence = 0;
  private events = 0;
  private lastUpdateId: number;
  private panel?: { chatId: number; messageId: number };
  private context: InnerContext;
  private push = false;
  private constructor(
    readonly conversation: BotConversation,
    readonly initial: InnerContext,
    readonly scene: string,
    readonly permission: Permission,
    readonly nonce: string,
  ) {
    this.context = initial;
    this.lastUpdateId = initial.update.update_id;
  }
  static async create(
    conversation: BotConversation,
    ctx: InnerContext,
    scene: string,
    permission: Permission,
  ) {
    const nonce = await conversation.external(() => randomBytes(16).toString("base64url"));
    return new Wizard(conversation, ctx, scene, permission, nonce);
  }
  get prefix() {
    return `w:${this.scene}:${this.nonce}`;
  }
  key(operation: string) {
    return `scene:${this.scene}:${this.initial.update.update_id}:${this.nonce}:${operation}`;
  }
  form<D extends object>(title: string, initial: Partial<D> = {}) {
    return new WizardForm<D>(this, title, initial);
  }
  private keyboard(token: string, rows: Choice[][]) {
    const k = new InlineKeyboard();
    for (const row of rows) {
      for (const choice of row) {
        const data = `${this.prefix}:${token}:${choice.value}`;
        if (Buffer.byteLength(data, "utf8") > 64)
          throw new Error("Wizard callback exceeds Telegram limit");
        if (choice.disabled) k.disabled(choice.label);
        else {
          k.text(choice.label, data);
          if (choice.value === "next") k.primary();
          if (choice.value === "yes") k.success();
        }
      }
      k.row();
    }
    return k.text(uiText.cancel, `${this.prefix}:${token}:cancel`).danger();
  }
  private async retire() {
    if (!this.panel) return;
    try {
      await this.context.api.editMessageReplyMarkup(this.panel.chatId, this.panel.messageId, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      if (!(error instanceof GrammyError && error.error_code === 400)) throw error;
    }
  }
  private async render(text: string, token: string, rows: Choice[][]) {
    const keyboard = this.keyboard(token, rows);
    if (text.length > 4000) throw new Error("Wizard message exceeds safe length");
    if (this.panel && !this.push) {
      try {
        await this.context.api.editMessageText(this.panel.chatId, this.panel.messageId, text, {
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
        return this.panel.messageId;
      } catch (error) {
        if (!(error instanceof GrammyError && error.error_code === 400)) throw error;
      }
    }
    await this.retire();
    const prompt = await this.context.reply(text, {
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    this.panel = { chatId: prompt.chat.id, messageId: prompt.message_id };
    this.push = false;
    return prompt.message_id;
  }
  private async event(
    token: string,
    messageId: number,
  ): Promise<{ ctx: InnerContext; action?: string; text?: string } | null> {
    for (;;) {
      const ctx = await this.conversation.wait();
      this.context = ctx;
      const role = await this.conversation.external((outer) => outer.principal.role);
      if (!can(role, this.permission)) {
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({
            text: "دسترسی این عملیات لغو شده است.",
            show_alert: true,
          });
        await this.retire();
        await ctx.reply("⛔ دسترسی این عملیات لغو شده است.", { reply_markup: mainKeyboard(role) });
        return null;
      }
      const data = ctx.callbackQuery?.data;
      this.events++;
      if (this.events > MAX_WIZARD_EVENTS) {
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({ text: "نشست بیش از حد طولانی شده است." });
        await this.finish(
          "⏳ این نشست به سقف ۳۰۰ تعامل رسید و بدون ثبت اطلاعات بسته شد. از منوی اصلی دوباره شروع کنید.",
        );
        return null;
      }
      // Webhook retries can arrive out of order. Never assign an older text to a newer field.
      // IDs are monotonic during an active (<30 minute idle) Telegram session.
      if (ctx.update.update_id <= this.lastUpdateId) {
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({
            text: "این تعامل قدیمی یا خارج از ترتیب است؛ از آخرین پیام استفاده کنید.",
          });
        else
          await ctx.reply(
            "پیام قدیمی یا خارج از ترتیب نادیده گرفته شد؛ مقدار فیلد فعلی را دوباره وارد کنید.",
          );
        continue;
      }
      this.lastUpdateId = ctx.update.update_id;
      if (ctx.hasCommand("start") || data === "m:home") {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        await this.retire();
        await ctx.reply("عملیات لغو شد. 🏠 منوی اصلی", { reply_markup: mainKeyboard(role) });
        return null;
      }
      if (ctx.callbackQuery) {
        if (
          ctx.from?.id !== this.initial.from?.id ||
          ctx.callbackQuery.message?.chat.id !== this.panel?.chatId ||
          ctx.callbackQuery.message?.message_id !== messageId ||
          !data?.startsWith(`${this.prefix}:${token}:`)
        ) {
          await ctx.answerCallbackQuery({
            text: "این دکمه متعلق به مرحلهٔ جاری نیست؛ از آخرین پیام استفاده کنید.",
          });
          continue;
        }
        await ctx.answerCallbackQuery();
        const action = data.slice(`${this.prefix}:${token}:`.length);
        if (action === "cancel") {
          await this.retire();
          await ctx.reply("عملیات لغو شد. 🏠 منوی اصلی", { reply_markup: mainKeyboard(role) });
          return null;
        }
        return { ctx, action };
      }
      if (ctx.message?.text && !ctx.message.text.startsWith("/")) {
        this.push = true;
        return { ctx, text: ctx.message.text };
      }
      await ctx.reply("لطفاً مقدار خواسته‌شده یا دکمه‌های آخرین پیام را استفاده کنید.");
    }
  }
  private nav(meta: FieldMeta, valid: boolean): Choice[][] {
    return [
      [
        { label: uiText.back, value: "back", disabled: !meta.back },
        { label: uiText.next, value: "next", disabled: !valid },
      ],
    ];
  }
  private fieldCard(meta: FieldMeta, value: string, error: string) {
    return card(`🧭 ${meta.title}`, [
      progress(meta.index, meta.total),
      `\n${meta.label}`,
      meta.hint ?? "",
      `\nمقدار: ${value}`,
      error ? `\n⚠️ ${error}` : "",
      "\nفقط همین فیلد را تکمیل کنید؛ سپس «مرحله بعد» را بزنید.",
    ]);
  }
  async input<T>(
    editor: FieldEditor<T>,
    schema: ZodType<T>,
    options: FieldOptions<T> = {},
  ): Promise<Navigation> {
    let error = "",
      invalid = false;
    const format = options.format ?? ((value: T) => (value === null ? "" : String(value)));
    for (;;) {
      const value = editor.get();
      const valid = !invalid && value !== undefined && schema.safeParse(format(value)).success;
      const token = (this.sequence++).toString(36);
      const rows: Choice[][] = options.clear
        ? [[{ label: options.clear.label, value: "empty" }], ...this.nav(editor.meta, valid)]
        : this.nav(editor.meta, valid);
      const id = await this.render(
        this.fieldCard(editor.meta, displayValue(value), error),
        token,
        rows,
      );
      const event = await this.event(token, id);
      if (!event) return "cancel";
      if (event.action === "back" && editor.meta.back) return "back";
      if (event.action === "next" && valid) return "next";
      if (event.action === "empty" && options.clear) {
        editor.set(options.clear.value);
        invalid = false;
        error = "";
        continue;
      }
      if (event.text === undefined) {
        error = "ابتدا مقدار معتبر وارد کنید؛ «مرحله بعد» هنوز فعال نیست.";
        continue;
      }
      const parsed = schema.safeParse(event.text);
      if (!parsed.success) {
        invalid = true;
        error = parsed.error.issues[0]?.message ?? "مقدار نامعتبر است.";
        continue;
      }
      editor.set(parsed.data);
      invalid = false;
      error = "دریافت شد؛ برای ادامه «مرحله بعد» را بزنید یا مقدار را اصلاح کنید.";
    }
  }
  async select<T>(
    editor: FieldEditor<T>,
    load: (page: number) => Promise<SelectPage<T> | null>,
    options: { display?: (value: T) => string; identity?: (value: T) => string } = {},
  ): Promise<Navigation> {
    let pageNumber = 0,
      error = "";
    const identity = options.identity ?? ((value: T) => JSON.stringify(value));
    for (;;) {
      const page = await load(pageNumber);
      if (!page) return "cancel";
      const current = editor.get(),
        optionsFlat = page.rows.flat();
      const token = (this.sequence++).toString(36);
      const rows: Choice[][] = page.rows.map((row) =>
        row.map((option) => ({
          label: `${current !== undefined && identity(current) === identity(option.value) ? "✓ " : ""}${option.label}`,
          value: `o${optionsFlat.indexOf(option)}`,
          disabled: option.disabled,
        })),
      );
      if (page.pages !== undefined)
        rows.push([
          { label: "⬅️ قبلی", value: "pgprev", disabled: !page.page },
          { label: `${(page.page ?? 0) + 1}/${page.pages}`, value: "page", disabled: true },
          { label: "بعدی ➡️", value: "pgnext", disabled: (page.page ?? 0) + 1 >= page.pages },
        ]);
      rows.push(...this.nav(editor.meta, current !== undefined));
      const shown =
        current === undefined
          ? displayValue(undefined)
          : (options.display?.(current) ??
            optionsFlat.find((option) => identity(option.value) === identity(current))?.label ??
            displayValue(current));
      const id = await this.render(
        this.fieldCard(editor.meta, shown, error || page.empty || ""),
        token,
        rows,
      );
      const event = await this.event(token, id);
      if (!event) return "cancel";
      if (event.action === "back" && editor.meta.back) return "back";
      if (event.action === "next" && current !== undefined) return "next";
      if (event.action === "pgprev" && (page.page ?? 0) > 0) {
        pageNumber = page.page! - 1;
        continue;
      }
      if (event.action === "pgnext" && (page.page ?? 0) + 1 < (page.pages ?? 0)) {
        pageNumber = page.page! + 1;
        continue;
      }
      const chosen = event.action?.match(/^o(\d+)$/);
      const option = chosen ? optionsFlat[Number(chosen[1])] : undefined;
      if (option && !option.disabled) {
        editor.set(option.value);
        error = "گزینه انتخاب شد؛ «مرحله بعد» را بزنید.";
      } else error = "یکی از گزینه‌های فعال را انتخاب کنید.";
    }
  }
  async menu(meta: FieldMeta, label: string, rows: Choice[][]): Promise<string | null> {
    const token = (this.sequence++).toString(36);
    const allowed = new Set(
      rows
        .flat()
        .filter((choice) => !choice.disabled)
        .map((choice) => choice.value),
    );
    if (meta.back) {
      rows = [...rows, [{ label: uiText.back, value: "back" }]];
      allowed.add("back");
    } else rows = [...rows, [{ label: uiText.back, value: "back", disabled: true }]];
    const id = await this.render(
      card(`🧭 ${meta.title}`, [progress(meta.index, meta.total), label]),
      token,
      rows,
    );
    for (;;) {
      const event = await this.event(token, id);
      if (!event) return null;
      if (event.action && allowed.has(event.action)) return event.action;
      await event.ctx.reply("یکی از دکمه‌های آخرین پیام را انتخاب کنید.");
    }
  }
  async review(
    meta: FieldMeta,
    summary: string,
    error = "",
    readOnly = false,
  ): Promise<Navigation> {
    const action = await this.menu(
      meta,
      `${summary}\n\n${error ? `⚠️ ${error}\n` : ""}${readOnly ? "این جستجو فقط‌خواندنی است؛ تأیید نهایی فقط نتیجه را نمایش می‌دهد." : "ذخیره فقط با تأیید نهایی انجام می‌شود."} با «مرحله قبل» می‌توانید اصلاح کنید.`,
      [[{ label: uiText.confirm, value: "yes" }]],
    );
    return action === null ? "cancel" : action === "back" ? "back" : "next";
  }
  async external<T>(work: (ctx: BotContext) => Promise<T>): Promise<ExternalResult<T>> {
    return this.conversation.external(async (ctx) => {
      try {
        return { ok: true as const, value: await work(ctx) };
      } catch (error) {
        if (error instanceof DomainError)
          return { ok: false as const, message: error.message, code: error.code };
        throw error;
      }
    });
  }
  async finish(text: string, keyboard = homeOnly()) {
    await this.retire();
    await this.context.reply(text, { reply_markup: keyboard });
  }
}
