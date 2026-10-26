import { z } from "zod";

const databaseSchema = z
  .object({
    TURSO_DATABASE_URL: z
      .string()
      .default("file:./data/warehouse.db")
      .refine(
        (v) => v.startsWith("file:") || v.startsWith("libsql://") || v.startsWith("https://"),
        "Use file:, libsql://, or https://",
      ),
    TURSO_AUTH_TOKEN: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined),
  })
  .superRefine((v, ctx) => {
    if (!v.TURSO_DATABASE_URL.startsWith("file:") && !v.TURSO_AUTH_TOKEN)
      ctx.addIssue({
        code: "custom",
        path: ["TURSO_AUTH_TOKEN"],
        message: "Required for remote Turso",
      });
  });
export function parseDatabaseEnv(source: Record<string, string | undefined>) {
  const value = databaseSchema.parse(source);
  if (source.VERCEL === "1" && value.TURSO_DATABASE_URL.startsWith("file:"))
    throw new Error("Vercel requires remote Turso, not an ephemeral SQLite file");
  return value;
}
const runtimeSchema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  SUPER_ADMIN_TELEGRAM_IDS: z
    .string()
    .transform((v) => v.split(",").map((x) => Number(x.trim())))
    .pipe(z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1)),
  APP_URL: z
    .url()
    .refine((v) => new URL(v).protocol === "https:", "Webhook URL must use HTTPS")
    .optional(),
  STORE_TIMEZONE: z
    .string()
    .default("Asia/Tehran")
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA timezone"),
  CONVERSATION_VERSION: z.string().min(1).max(80).default("4"),
  WEBHOOK_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(1),
});
export function parseEnv(source: Record<string, string | undefined>) {
  return { ...parseDatabaseEnv(source), ...runtimeSchema.parse(source) };
}
let cached: ReturnType<typeof parseEnv> | undefined;
export function getEnv() {
  return (cached ??= parseEnv(process.env));
}
