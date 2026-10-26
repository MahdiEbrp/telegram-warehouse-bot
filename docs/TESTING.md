# راهنمای تست

```bash
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run test:stress
npm run ui:preview
npm run build
```

هیچ‌یک از این فرمان‌ها به توکن معتبر یا اتصال به Telegram/Turso واقعی نیاز ندارند. تولید HTML پوشش با provider `v8` انجام می‌شود. مسیر گزارش: `coverage/index.html` و `coverage/coverage-summary.json`.

## سطح‌ها

| فایل                             | پوشش رفتاری                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unit/domain.test.ts`            | پول صحیح و سرریز، موجودی، ارقام فارسی/عربی، اعتبارسنجی، RBAC، env و مرزهای زمانی/DST                                                                         |
| `unit/products-users.test.ts`    | کوئری واقعی SQLite حافظه‌ای، SKU یکتا، idempotency، PATCH بدون defaults مخرب، FK، موجودی منفی، کاربران و آخرین مدیرکل                                        |
| `unit/orders.test.ts`            | رزرو موجودی، snapshot قیمت، جلوگیری از فروش اضافه، لغو و بازپرداخت، پرداخت قبل از ارسال و گزارش فروش                                                         |
| `unit/reliability.test.ts`       | قفل چندنمونه‌ای، fencing، rollback کامل با trigger خطای عمدی و رقابت دو اتصال مستقل SQLite                                                                   |
| `integration/bot.test.ts`        | `/start`، فهرست محصولات، ویزارد کامل، cancel، دکمهٔ قدیمی، callback جعلی viewer، تغییر نقش حین ویزارد، عدم دسترسی گروه، dedup، ری‌استارت، انبار و سفارش کامل |
| `integration/management.test.ts` | ویرایش و بایگانی، دسته‌بندی، جستجوی viewer، کاربران، تنظیمات، چرخهٔ سفارش/پرداخت و صفحه‌بندی                                                                 |
| `integration/webhook.test.ts`    | آداپتور Fetch واقعی `std/http`، secret، بدنهٔ نامعتبر/بزرگ، 401/400/413/415، retry و 503 بدون نشت secret                                                     |

## تست‌های جدید رهگیری

- `unit/tracking.test.ts`: REF رمزنگارانه، برخورد و exhaustion تخصیص، کد/کد پستی، URL، هزینه، یکتایی بارکد و leading zero/case، مجوزها، revision/ABA، timestamp، rollback اتمیک در خطای audit، idempotency، جستجوی literal، سفارش قدیمی و رقابت واقعی دو client مستقل.
- `integration/tracking.test.ts`: ویزارد واقعی همهٔ فیلدها، حمل سفارشی/پیک/حضوری، `copy_text` و URL دکمه‌ها، ورودی نامعتبر، save غیرفعال/جعلی، تغییر و پاک‌کردن با علت، سابقه، انصراف، تعارض، نقش حین ویزارد، منع مشتری/بیننده، صف‌ها، جستجوی صفحه‌ای و restart/version invalidation. تماس‌های sendMessage بررسی می‌شوند تا ارسال به مشتری رخ ندهد؛ پیام رد دسترسی بیننده از اعلان مشتری جداست.
- `integration/upgrade.test.ts`: نصب اولیه، ارتقا از **مایگریشن واقعی v1** با سفارش/قلم/موجودی/لاگ/receipt/state موجود، برابری تمام ۱۲ جدول قبلی، backfill، rowid بسیار بزرگ، FK/CHECK/unique و تکرار migration بدون تغییر REF یا shipment.

اجرای هدفمند:

```bash
npx vitest run src/tests/unit/tracking.test.ts src/tests/integration/tracking.test.ts src/tests/integration/upgrade.test.ts
```

این تست‌ها اعتبار واقعی مرسوله یا محتوای لینک شرکت را تأیید نمی‌کنند؛ لینک از سرور fetch نمی‌شود. راهنمای عملکرد و ارتقا: [TRACKING.md](TRACKING.md).

## سناریوهای جدید v1.2

- `unit/parcels.test.ts`: چندمرسوله، ابهام legacy API، شمارندهٔ پایدار، سقف ۲۰، یکتایی بارکد، ارسال جزئی/جمعی، منع لغو و عدم رزرو دوبارهٔ موجودی، اصلاح بستهٔ تحویل‌شده، rollback و revision.
- `unit/exports.test.ts`: OOXML واقعی، رشته‌های literal/formula-safe، صفر/case، فیلتر/بازه، سقف ۱۰۰۰، عدد نامعتبر/خروجی خالی، sanitation XML و منع کنترل متنی پیش از ذخیره، دسترسی و audit بدون PII.
- `integration/parcels-export.test.ts`: افزودن و انتخاب مرسولهٔ مشخص از UI واقعی، ارسال/تحویل مستقل، stale confirmation، clear با علت و عدم تکرار شماره، `sendDocument` با InputFile از منوی Excel، منع نقش‌ها/مشتری و لغو unsafe.
- `integration/parcels-upgrade.test.ts`: ارتقای **واقعی v1.1 پرشده** با ۱۴ جدول به ۱۵ جدول، مقایسهٔ همهٔ ستون‌های قبلی، بارکد/نسخهٔ ۴۲/actor/audit/timestamp نامعلوم، state backfill، شمارنده و تکرار migration.
- `unit/local-database.test.ts`: read خارج از تراکنش پشت write محلی صف می‌شود، connection اضافی باز نمی‌شود، rollback صف را آزاد می‌کند و FK فعال می‌ماند. رقابت دو client فایل مشترک در تست‌های دامنه نیز وجود دارد.
- `unit/preflight.test.ts`: env تولیدی/URL، رد placeholder/فایل محلی، بررسی فقط‌خواندنی schema/FK/REF/شمارنده.

```bash
npx vitest run src/tests/unit/parcels.test.ts src/tests/unit/exports.test.ts src/tests/integration/parcels-export.test.ts src/tests/integration/parcels-upgrade.test.ts
```

نمونهٔ ساختگی `docs/samples/shipments-demo.xlsx` علاوه بر تست JS، با openpyxl مستقل باز شده است. این بررسی، بازکردن در Excel دسکتاپ یا دریافت واقعی Telegram نیست. جزئیات نتیجه: [VERIFICATION.md](VERIFICATION.md).

## سناریوهای جدید v1.3

- `integration/forms.test.ts`: تک‌فیلدی و انتخاب+Next، Back واقعی/مرور/retention، page/category labels، ویرایش مقدار هر مشخصه، سبد و قلمِ درحال‌تکمیل، clear اختیاری، dependency invalidation، retry duplicate بدون partial write، stock refresh، restart، revocation در تأیید، دکمهٔ جعلی/stale، message binding، late text و دو مسیر سقف ۳۰۰.
- `unit/validation-security.test.ts`: کنترل‌های C0/DEL، Unicode جفت‌نشده، Persian/ZWNJ/emoji و کوتاه‌سازی UTF-16 بدون ساخت surrogate ناقص، optional clear و URL عمومی ساختاری/حد canonical.
- `integration/contention.test.ts`: ۵۰ خریدار برای ۲۵ واحد و ۵۰ ویرایش optimistic برای یک baseline؛ بازنده‌ها دادهٔ ناقص یا موجودی اضافه نمی‌سازند.
- `integration/stress-harness.test.ts`: smoke واقعی ۵ کاربر / ۱۲۵ آپدیت و اعتبارسنجی قرارداد runner.
- `test:stress`: هدف پیش‌فرض ۵۰/۵۰۰۰، ۴ نقش، ساخت سفارش، fulfilment، جستجو/Back، browse و ۲۴۰ رد مجوزِ موردانتظار. این‌ها خطای ناخواسته حساب نمی‌شوند. گزارش JSON حاوی latency، منابع، source hash و invariantهاست.

حداقل‌های coverage در CI: statements=92، branches=84، functions=96، lines=93 درصد؛ این floorها جای تست امنیت یا تضمین کیفیت نیستند. اجرای بار کامل نیز در CI قرار دارد.

### پیش‌نمایش رابط و بررسی مرورگر (اختیاری)

`npm run ui:preview` بدون secret، ۱۲ پاسخ واقعی pipeline را با دادهٔ مصنوعی ثبت و `docs/ui-preview.html` / transcript را بازسازی می‌کند. این فایل Web App بات یا screenshot واقعی تلگرام نیست.

Playwright جزو وابستگی‌های بات نیست. برای بررسی اختیاری همین مستند HTML روی محیط Linux دارای کتابخانه‌های سیستم:

```bash
npm install --no-save --package-lock=false playwright
npx playwright install --with-deps chromium
node scripts/check-ui-browser.mjs
# npm ci در پایان، node_modules را به lockfile پروژه برمی‌گرداند.
```

این script، ۱۲ نما را در دو عرض، دکمه‌های disable، متن دقیق، عدم overflow و نبود درخواست HTTP بررسی می‌کند. اثبات پشتیبانی Telegram client نیست. خروجی‌های این تحویل در `docs/verification` هستند.

## روش شبیه‌سازی

تست‌ها `new TestBot<BotContext>()` از **`@bonkers-agency/grammy-test` نسخهٔ 0.1.3** می‌سازند و آن را به **همان `configureBot` محیط واقعی** می‌دهند. بنابراین authentication، RBAC، middleware قفل، conversations و سرویس‌های واقعی دیتابیس اجرا می‌شوند؛ فقط Telegram شبیه‌سازی می‌شود.

- SQLite از URL `file::memory:` استفاده می‌کند. همان مایگریشن‌های SQL تحویل‌داده‌شده اجرا می‌شوند؛ schema موازی مخصوص تست نداریم.
- تست‌های رقابت و ارتقا، استثنائاً فایل/پوشهٔ موقت و در تست‌های رقابت دو client مستقل می‌سازند و بعد پاک می‌کنند.
- برای فایل SQLite، تمام clientهای همان process به صف مشترک و یک connection برای هر client محدودند؛ این تست، تضمین چندprocess یا Turso شبکه‌ای نیست.
- `TestBot` ممکن است `globalThis.fetch` را intercept کند؛ `fileParallelism: false` و اجرای ترتیبی تست‌ها عمدی است. `dispose()` و بازیابی spy در `afterEach` الزامی است.
- spy شبکه در تست‌های یکپارچه باید **هیچ فراخوانی واقعی‌ای** نبیند. APIهای داخل replay نیز توسط شبیه‌ساز پاسخ می‌گیرند.
- کلیک ویزارد از `callback_data` و شناسهٔ **پیام واقعی آخرین prompt** استفاده می‌کند؛ nonce به‌صورت هاردکد دور زده نمی‌شود.
- تست restart حافظهٔ قبلی Bot را دور می‌ریزد و state را از جدول conversation می‌خواند. شمارندهٔ update شبیه‌ساز به شناسهٔ تازه منتقل می‌شود تا با receipt قبلی اشتباه نشود.

## محدودیت‌ها و پوشش

پوشش v8 برای `src/lib`، `src/db/queries` و `src/bot` فعال است؛ اتصال singleton، فایل‌های اتصال/adapter محلی زیر `src/db` خارج از queries و parsing env در درصد coverage کلی نیستند، هرچند adapter محلی و اعتبارسنجی env تست مستقیم دارند. درصدها تضمین عدم وجود باگ نیستند. تعداد و درصد دقیق آخرین اجرای تحویل در [VERIFICATION.md](VERIFICATION.md) آمده است.

تست‌های محلی، رفتار شبکهٔ Turso ابری، محدودیت سهمیهٔ واقعی Telegram، محیط Vercel، پرداخت بانکی یا ظرفیت ابری را تأیید نمی‌کنند. قبل از انتشار واقعی، staging را با بات و دیتابیس جدا و کلیدهای خودتان smoke-test کنید. فایل CI نیز typecheck، coverage و build را بدون secret اجرا می‌کند.

پس از تغییر ترتیب مراحل، `CONVERSATION_VERSION` را افزایش دهید و یک سناریوی regression با ورودی نامعتبر، cancel و role revocation اضافه کنید. برای افزودن قابلیت نوشتنی، هم RBAC callback و هم مجوز سرویس داخل تراکنش را تست کنید.
