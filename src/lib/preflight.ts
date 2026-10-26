import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { parseEnv } from "./env";
import { invariant } from "./errors";
import { safeTrackingUrl } from "./shipping";

export function productionConfiguration(source: Record<string, string | undefined>) {
  const env = parseEnv({ ...source, VERCEL: "1" });
  invariant(
    env.APP_URL && safeTrackingUrl(env.APP_URL),
    "APP_URL_REQUIRED",
    "APP_URL باید دامنهٔ عمومی HTTPS استقرار باشد.",
  );
  const app = new URL(env.APP_URL);
  invariant(
    app.pathname === "/" && !app.search && !app.hash,
    "APP_URL_ORIGIN",
    "APP_URL فقط origin است؛ مسیر webhook یا query را اضافه نکنید.",
  );
  const placeholders = [
    env.BOT_TOKEN,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.TURSO_DATABASE_URL,
    env.TURSO_AUTH_TOKEN ?? "",
    env.APP_URL,
  ];
  invariant(
    !placeholders.some((value) =>
      /REPLACE_WITH|replace_with|your-database|your-turso|your-app|YOUR_DATABASE|YOUR_TOKEN/.test(
        value,
      ),
    ),
    "PLACEHOLDER_ENV",
    "مقادیر نمونه را با مقادیر حساب خودتان در تنظیمات محرمانه جایگزین کنید.",
  );
  return env;
}
// Read-only. Does not migrate, seed, bootstrap users, call Telegram or register a webhook.
export async function databaseReadiness(db: Database) {
  const columns = await db.all<{ name: string }>(sql`pragma table_info(shipments)`);
  invariant(
    ["parcel_number", "state", "tracking_number"].every((name) =>
      columns.some((column) => column.name === name),
    ),
    "MIGRATION_REQUIRED",
    "ابتدا db:migrate نسخهٔ 1.2 را روی دیتابیس درست اجرا کنید.",
  );
  const sequenceTable = await db.all(
    sql`select name from sqlite_master where type='table' and name='shipment_sequences'`,
  );
  invariant(
    sequenceTable.length === 1,
    "MIGRATION_REQUIRED",
    "جدول شمارندهٔ مرسوله وجود ندارد؛ migration کامل نیست.",
  );
  const obsoleteIndex = await db.all(
    sql`select name from sqlite_master where type='index' and name='shipments_order_id_unique'`,
  );
  invariant(
    obsoleteIndex.length === 0,
    "MIGRATION_REQUIRED",
    "ایندکس تک‌مرسوله‌ای قدیمی هنوز حذف نشده است.",
  );
  const foreignKeys = await db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`);
  invariant(
    Number(foreignKeys[0]?.foreign_keys) === 1,
    "FOREIGN_KEYS_OFF",
    "بررسی کلیدهای خارجی دیتابیس باید فعال باشد.",
  );
  const violations = await db.all(sql`select * from pragma_foreign_key_check limit 1`);
  invariant(
    violations.length === 0,
    "FOREIGN_KEY_VIOLATION",
    "دیتابیس ناسازگاری کلید خارجی دارد؛ بدون بررسی داده‌ها منتشر نکنید.",
  );
  const missing = await db.all<{ n: number }>(
    sql`select count(*) as n from orders o left join order_references r on r.order_id=o.id where r.order_id is null`,
  );
  invariant(
    Number(missing[0]?.n) === 0,
    "MISSING_REFERENCES",
    "بعضی سفارش‌ها REF ندارند؛ احتمال اجرای کد قدیمی پس از ارتقا وجود دارد. داده‌ها را حذف نکنید و رفع رو به جلو انجام دهید.",
  );
  const badCounters = await db.all(
    sql`select s.order_id from shipments s left join shipment_sequences c on c.order_id=s.order_id group by s.order_id having coalesce(max(c.last_number),0) < max(s.parcel_number) limit 1`,
  );
  invariant(
    badCounters.length === 0,
    "BAD_PARCEL_COUNTER",
    "شمارندهٔ مرسوله با داده‌های موجود سازگار نیست؛ اصلاح داده لازم است.",
  );
  const counts = await db.all<{ orders: number; shipments: number }>(
    sql`select (select count(*) from orders) as orders, (select count(*) from shipments) as shipments`,
  );
  return { orders: Number(counts[0]?.orders ?? 0), shipments: Number(counts[0]?.shipments ?? 0) };
}
