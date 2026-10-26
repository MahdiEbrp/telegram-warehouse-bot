import type { InlineKeyboard } from "grammy";
import type { ZodType } from "zod";
import type {
  Wizard,
  FieldMeta,
  FieldEditor,
  FieldOptions,
  Navigation,
  SelectOption,
  ExternalResult,
} from "./wizard";

export interface StepOptions<D> {
  when?: (draft: Readonly<Partial<D>>) => boolean;
  hint?: string;
}
type FieldStep = { key: string; run: (meta: FieldMeta) => Promise<Navigation> };
/** Local draft computations are replayed by conversations; only final submit writes domain data. */
export class WizardForm<D extends object> {
  readonly draft: Partial<D>;
  private readonly steps: (FieldStep & { enabled: () => boolean })[] = [];
  private changed?: (key: keyof D, data: Partial<D>, previous: unknown) => void;
  constructor(
    private readonly wizard: Wizard,
    private readonly title: string,
    initial: Partial<D> = {},
  ) {
    this.draft = { ...initial };
  }
  onChange(callback: (key: keyof D, draft: Partial<D>, previous: unknown) => void) {
    this.changed = callback;
    return this;
  }
  custom<K extends keyof D & string>(
    key: K,
    label: string,
    run: (editor: FieldEditor<D[K]>, draft: Readonly<Partial<D>>) => Promise<Navigation>,
    options: StepOptions<D> = {},
  ) {
    if (this.steps.some((step) => step.key === key)) throw new Error("Duplicate form field");
    this.steps.push({
      key,
      enabled: () => options.when?.(this.draft) ?? true,
      run: (meta) =>
        run(
          {
            meta: { ...meta, label, hint: options.hint },
            get: () => this.draft[key],
            set: (value) => {
              const previous = this.draft[key];
              this.draft[key] = value;
              if (JSON.stringify(previous) !== JSON.stringify(value))
                this.changed?.(key, this.draft, previous);
            },
          },
          this.draft,
        ),
    });
    return this;
  }
  text<K extends keyof D & string>(
    key: K,
    label: string,
    schema: ZodType<D[K]> | ((data: Readonly<Partial<D>>) => ZodType<D[K]>),
    options: StepOptions<D> &
      (FieldOptions<D[K]> | { field: (data: Readonly<Partial<D>>) => FieldOptions<D[K]> }) = {},
  ) {
    return this.custom(
      key,
      label,
      (editor, data) =>
        this.wizard.input(
          editor,
          typeof schema === "function" ? schema(data) : schema,
          "field" in options ? options.field(data) : options,
        ),
      options,
    );
  }
  select<K extends keyof D & string>(
    key: K,
    label: string,
    rows: SelectOption<D[K]>[][] | ((data: Readonly<Partial<D>>) => SelectOption<D[K]>[][]),
    options: StepOptions<D> & {
      display?: (value: D[K]) => string;
      identity?: (value: D[K]) => string;
    } = {},
  ) {
    return this.custom(
      key,
      label,
      (editor) =>
        this.wizard.select(
          editor,
          async () => ({ rows: typeof rows === "function" ? rows(this.draft) : rows }),
          options,
        ),
      options,
    );
  }
  async complete<R>(options: {
    preview: (data: D) => string;
    readOnly?: boolean;
    submit: (data: D) => Promise<ExternalResult<R>>;
    success: (result: R) => string;
    keyboard?: InlineKeyboard | ((result: R) => InlineKeyboard);
  }): Promise<void> {
    let index = 0,
      error = "";
    for (;;) {
      const steps = this.steps.filter((step) => step.enabled());
      index = Math.min(index, steps.length);
      const meta = {
        title: this.title,
        index: index + 1,
        total: steps.length + 1,
        back: index > 0,
        label: "بررسی و تأیید",
      };
      if (index === steps.length) {
        const missing = steps.findIndex((step) => this.draft[step.key as keyof D] === undefined);
        if (missing >= 0) {
          index = missing;
          continue;
        }
        const nav = await this.wizard.review(
          meta,
          options.preview(this.draft as D),
          error,
          options.readOnly,
        );
        if (nav === "cancel") return;
        if (nav === "back") {
          index--;
          continue;
        }
        const result = await options.submit(this.draft as D);
        if (result.ok) {
          await this.wizard.finish(
            options.success(result.value),
            typeof options.keyboard === "function"
              ? options.keyboard(result.value)
              : options.keyboard,
          );
          return;
        }
        if (["FORBIDDEN", "INACTIVE"].includes(result.code ?? "")) {
          await this.wizard.finish(result.message);
          return;
        }
        error = `${result.message}\n${result.code === "SHIPMENT_CHANGED" ? "این نسخه قدیمی است؛ برای جلوگیری از بازنویسی تغییر همکار، انصراف دهید و آخرین اطلاعات ارسال را دوباره باز کنید." : result.code === "STOCK_CHANGED" ? "با «مرحله قبل» برگردید و «موجودی تازه» را بزنید؛ سپس مقدار جدید را دوباره بررسی کنید." : "با «مرحله قبل» اطلاعات را اصلاح کنید؛ پیش‌نویس محفوظ است."}`;
        continue;
      }
      const nav = await steps[index]!.run(meta);
      if (nav === "cancel") return;
      error = "";
      index = nav === "back" ? Math.max(0, index - 1) : index + 1;
    }
  }
}
