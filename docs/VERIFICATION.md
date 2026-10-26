# نتیجهٔ اعتبارسنجی تحویل — نسخهٔ 1.3.0

تاریخ: **۲۵ اکتبر ۲۰۲۶**؛ محیط Linux x64، Node **v24.22.1** و npm **10.8.2**. این‌ها نتایج اجرای محلی روی سورس تحویل‌اند، **نه امتیاز «۱۰/۱۰»، گواهی امنیت یا اثبات استقرار Vercel/Turso**. اطلاعات و فایل‌های آزمایشی ساختگی‌اند؛ دیتابیس عملیاتی یا secret واقعی کاربر دریافت/تغییر نشده است.

## خلاصهٔ بررسی‌ها

| بررسی                                                   | نتیجه                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| نصب تمیز `npm ci` از lockfile                           | موفق                                                                        |
| TypeScript strict / noUnused / noUncheckedIndexedAccess | بدون خطا                                                                    |
| Vitest + V8 با gate پوشش                                | **۲۲۳ تست موفق در ۲۰ فایل؛ ۳۴٫۳۵ ثانیه**                                    |
| Stress هدف انتخاب‌شده                                   | **۵۰ کاربر هم‌زمان / ۵۰۰۰ آپدیت آفلاین؛ ۲۰/۲۰ invariant**                   |
| `npm run build` نهایی                                   | موفق؛ Next.js **16.4.3**؛ بدون secret/تماس Telegram در build                |
| Prettier                                                | موفق؛ `npm run format:check`                                                |
| `npm audit` کامل و `--omit=dev`                         | هر دو **صفر آسیب‌پذیری گزارش‌شده**؛ محدود به advisoryهای registry همان زمان |
| `drizzle-kit generate`                                  | ۱۵ جدول؛ **بدون drift یا migration تازه**                                   |
| migrate/seed/bootstrap                                  | هر کدام دوبار روی فایل واقعی آزمایشی؛ نتیجه idempotent                      |
| پیش‌بررسی DB و cleanup                                  | فقط‌خواندنی بودن readiness، FK/integrity و حذف فقط رکوردهای منقضی تأیید شد  |
| Production HTTP smoke                                   | **۱۲/۱۲** پاسخ موردانتظار؛ سرور بعد از بررسی متوقف شد                       |
| ثبت رابط از pipeline واقعی TestBot                      | ۱۲ نما؛ بدون Telegram واقعی                                                 |
| مرورگر اختیاری Chromium                                 | **۲۴/۲۴** ترکیب نما/عرض؛ صفر خطای صفحه و صفر درخواست HTTP                   |
| نمونهٔ XLSX                                             | بازسازی با نویسندهٔ 1.3 و تأیید مستقل openpyxl/XML/CRC                      |

گیت کامل برای بازتولید محلی: `npm run check`؛ ترتیب آن format → typecheck → gated coverage → full stress → build → production audit است. CI همین کنترل‌های اصلی و artifact بار را پیکربندی کرده است؛ اجرای remote CI یا staging ابری در حساب شما ادعا نشده است.

## بررسی مستقل بسته

ZIP در پوشه‌ای مستقل، بدون node_modules یا build قبلی استخراج شد. `npm ci` و **کل `npm run check`** موفق بودند: **۲۲۳ تست در ۲۰ فایل، coverage با همان درصدهای زیر، بار کامل ۵۰/۵۰۰۰ با هر ۲۰ invariant، build و audit Production**. زمان تست در این اجرای مستقل ۳۷٫۱۷ ثانیه بود. تمام ۱۰۹ فایل fingerprint پس از اجرا با سورس اصلی byte-for-byte برابر ماندند.

[گزارش بررسی مستقل](verification/archive-check.json) · [خروجی کامل نصب و گیت‌ها](verification/archive-check-run.txt). زمان بار این اجرای مستقل از benchmark اصلی پایین جداست؛ فایل benchmark اصلی جایگزین نشده است. فقط مستندات/شواهد این بررسی پس از تست به بسته افزوده شدند؛ سورس اجرایی همان سورس آزموده‌شده است. ZIP نهایی نیز دوباره استخراج شد؛ CRC و بایت‌های تمام فایل‌ها با فایل‌های تحویل برابر بودند.

## کیفیت و پوشش V8

اجرای اصلی coverage پس از **نصب تمیز** و آخرین تغییرات سورس انجام شد. نسبت به v1.2، **۶۸ تست بیشتر** داریم. ۳۶ تست فرم شامل Back/Next/Cancel، retention، ادامه پس از restart، تغییر وابستگی، cart pending، fresh role در تأیید، جعل/stale callback، message binding، دیررس‌بودن متن و عبور از سقف ۳۰۰ حتی با آپدیت قدیمی هستند. دو regression اضافه، کوتاه‌سازی label/مقدار نمایشی را بدون ساخت surrogate معیوب در مرز emoji کنترل می‌کنند. تست رقابت، ۵۰ خریدار برای ۲۵ واحد و ۵۰ ویرایش برای یک baseline را نیز می‌سنجد.

| معیار      | درصد       | پوشش / کل   | حداقل کلی CI |
| ---------- | ---------- | ----------- | ------------ |
| Statements | **92.91%** | 1717 / 1848 | 92%          |
| Branches   | **85.94%** | 1033 / 1202 | 84%          |
| Functions  | **97.05%** | 429 / 442   | 96%          |
| Lines      | **94.03%** | 1607 / 1709 | 93%          |

[خلاصهٔ ماشین‌خوان coverage](verification/coverage-summary.json). محدودهٔ درصد: `src/lib`، `src/db/queries` و `src/bot`، به‌جز `src/lib/env.ts` و `src/bot/bot.ts`. اتصال/adapter/schema/Route Handlerها، scriptها و HTML مستندات داخل این درصد نیستند؛ بعضی مثل adapter/env/preflight/HTTP تست مستقیم جدا دارند. floorها **کلی** هستند، نه برای هر فایل. پوشهٔ generated گزارش HTML داخل ZIP نیست و با `npm run test:coverage` بازتولید می‌شود.

## تست فشار اصلی

[گزارش خام](verification/stress-50x5000.json) · [روش و محدودیت کامل](STRESS_TEST.md).

- زمان UTC: `2026-10-25T08:00:55.333Z` تا `2026-10-25T08:01:11.785Z`؛ مدت اندازه‌گیری **16407.36 ms**.
- ۵۰۰۰ update تکمیل‌شده، اوج واقعی ۵۰ handler، **صفر شکست ناخواسته، صفر خطای mock API و صفر تلاش شبکهٔ واقعی**.
- نرخ مصنوعی **304.74 update/s**؛ latency p50/p95/p99 برابر **95.95 / 554.64 / 808.87 ms**؛ بیشینه **1382.59 ms**.
- ۲۴۰ رد صحیح مجوز **جزء رفتار موردانتظار** است، نه ۲۴۰ شکست پنهان یا ۵۰۰۰ ثبت تجاری موفق.
- چهار نقش، ۱۲۰ سفارش تازه و ۴۰ fulfilment؛ در پایان ۱۶۰ سفارش/قلم/REF، ۴۰ مرسوله، موجودی دقیق ۱۹۷۲۰، ۵۰۰۰ receipt و صفر draft/lease رهاشده.
- تمام ۲۰ invariant شامل موجودی/ledger/جمع مبلغ، تفکیک مشتری/سبد، نقش، audit، FK و integrity موفق شدند.
- **event-loop delay p99=829.42 ms** و RSS اوجِ نمونه‌برداری **304.54 MiB** بود. در نتیجهٔ درست، ادعای latency یکنواخت یا مصرف ثابت Production وجود ندارد. حافظه، mock history و DB درون‌حافظه را هم شامل می‌شود.

بار closed-loop، بدون think time، با یک update outstanding در هر chat است؛ SQL محلی صف سریال دارد و محدودکنندهٔ per-chat شبیه‌ساز reset شده است. **این نرخ ظرفیت Telegram، HTTP، Vercel یا Turso نیست**؛ 429 واقعی، cold start و چندprocess شبکه‌ای آزمایش نشده‌اند. زمان مرحلهٔ setup/seed خارج از اندازه‌گیری است.

Fingerprint سورس تست‌شده، شامل **۱۰۹ فایل** executable/test/SQL/config/lockfile، با manifest مستقل هر فایل:

```text
aca15a7a0285810187ab7611da629dea131676435d3897e2b98d6a444bfa3404
```

پس از build/بررسی migration و پیش از بسته‌بندی نیز manifest با بایت‌های سورس تطبیق داده شد. مستندات/تصاویر/خروجی‌های generated در fingerprint اجرایی نیستند. برای هر تغییر سورس، گزارش بار تازه لازم است.

## فرم، رابط و سهولت استفاده

تمام **۱۱ conversation** به engine تک‌فیلدی `WizardForm` منتقل شده‌اند. انتخاب ← Next جداگانه، Back واقعی با مقدار حفظ‌شده، Cancel، مرور نهایی، retry خطای قابل اصلاح و دکمهٔ native `disabled:{}` اجرا می‌شوند. جزئیات workflow، پاک‌شدن وابستگی فقط هنگام تغییر مشتری/روش حمل و سقف‌ها: [WIZARDS.md](WIZARDS.md).

[گالری آفلاین](ui-preview.html) از ۱۲ payload واقعی pipeline با دادهٔ مصنوعی ساخته شده است. [transcript](verification/ui-transcript.json)، [گزارش مرورگر](verification/ui-browser-check.json)، [دسکتاپ](verification/ui-desktop.png) و [موبایل](verification/ui-mobile.png) همراه‌اند.

Chromium **156.0.8078.4** در عرض‌های **1280 و 390px**، هر ۱۲ نما را با متن/دکمهٔ مطابق transcript، disable، نبود overflow و ناوبری/toast کنترل کرده است؛ **۰ page error / ۰ HTTP request**. این بررسی مربوط به HTML مستندات با قاب و رنگ تقریبی است؛ **screenshot بومی، تست دستگاه Telegram، usability study یا وب‌اپ عملیاتی نیست**.

## دیتابیس، ارتقا و فرمان‌های اجرایی

[گزارش CLI/DB](verification/cli-database-check.json).

- تمام **۷ فایل SQL/metadata مایگریشن** در `drizzle` با ZIP v1.2 **byte-for-byte یکسان** هستند؛ 0003 وجود ندارد. generate هیچ drift نشان نداد.
- روی SQLite فایل آزمایشی تازه، migrate و seed دوبار بدون token Telegram اجرا شدند. سه migration، ۱۵ جدول کاربردی، یک دسته و یک settings به‌دست آمد؛ bootstrap صریح با credential ساختگی دوبار، فقط **یک کاربر مدیرکل و یک audit** ساخت.
- snapshot تمام ردیف‌های جدول‌ها پیش/پس از `databaseReadiness` برابر بود. `foreign_keys=1`، `foreign_key_check` خالی و `integrity_check=ok` بود.
- cleanup با رکورد expired و fresh برای conversation/lease/receipt آزمایش شد؛ expired حذف و fresh حفظ شد. فایل DB موقت سپس حذف شد و داخل ZIP نیست.
- CLI تولیدی با `VERCEL=1`، SQLite محلی را پیش از اتصال رد کرد. **اجرای مثبت `deploy:check` روی Turso ابری انجام نشده است**.
- تست‌های upgrade همچنان ارتقای v1.0 پرشده/۱۲ جدول و v1.1 پرشده/۱۴ جدول را با حفظ ستون‌های قدیمی، REF، نسخهٔ مرسوله، actor/audit و زمان نامعلوم می‌سنجند؛ مقصد ۱۵ جدول است. برای v1.2→1.3 schema عوض نشده، اما replay فرم قدیمی عمداً جدا می‌شود.

صف canonicalِ تمام عملیات محلی و concurrency=1، مسیر خطای native هم‌فرایندی را مدیریت می‌کند؛ dependency/vendor patch نشده است. این آزمون، قفل توزیع‌شده یا تضمین چندprocess با SQLite فایل مشترک نیست. [UPGRADE.md](UPGRADE.md) را قبل از دست‌زدن به دادهٔ واقعی بخوانید.

## Smoke سرور Production

[گزارش HTTP](verification/http-smoke.json). `next start` نسخهٔ ساخته‌شدهٔ 1.3، با env ساختگی روی `0.0.0.0:3000` اجرا و بعد متوقف شد. هیچ update تجاری معتبری برای اتصال به Telegram/DB ابری ارسال نشد.

| درخواست / بررسی                           | پاسخ                                |
| ----------------------------------------- | ----------------------------------- |
| `GET /`                                   | 200؛ JSON backend                   |
| `GET /api/health`                         | 200؛ liveness، نه سلامت DB/Telegram |
| `GET /api/telegram/webhook`               | 405                                 |
| POST بدون secret                          | 401                                 |
| JSON خراب با secret آزمایشی               | 400                                 |
| update بدون message/callback پشتیبانی‌شده | 200؛ بدون load بات                  |
| بدنهٔ بیش از 256 KiB                      | 413                                 |
| MIME غیر JSON                             | 415                                 |
| envelope غیرمعتبر                         | 400                                 |
| متن ۴۰۹۷نویسه‌ای                          | 400                                 |
| شناسهٔ بیشتر از safe integer              | 400                                 |
| callback با ۳۳ «ش» / ۶۶ بایت UTF-8        | 400                                 |

آداپتور App Router همان `std/http` است، نه نام نامعتبر `vercel`. `/start` و سناریوهای مجاز از pipeline با TestBot اجرا شده‌اند؛ این با تحویل واقعی از سرویس Telegram تفاوت دارد.

## نمونهٔ Excel و وابستگی‌ها

[بررسی نمونهٔ XLSX](verification/xlsx-sample-check.json) · [خود نمونه و SHA](samples/README.md).

نمونه با **سرویس و نویسندهٔ واقعی v1.3** و دادهٔ مصنوعی بازتولید و با **openpyxl 3.1.5**، مستقل از writer جاوااسکریپت باز شد: دو sheet فارسی/RTL، ۲۱ ستون و سه ردیف داده، freeze در `A2` و filter در `A1:U4`، بارکد `00Ab0091` و کد پستی `0123456789` رشته با صفر/case اصلی، `=SUM(1,2)` متن literal، هزینهٔ عددی ۲۵۰۰۰، ردیف بدون مرسوله خالی، metadata نسخهٔ 1.3.0، تمام XMLها parse و CRC هفت part سالم؛ هیچ formula/macro/external relationship وجود ندارد. دریافت واقعی Telegram و Excel دسکتاپ آزمایش نشده‌اند.

[audit خام کامل/Production](verification/dependency-audit.json) هر دو total=0 دارند. دو warning deprecation غیرمستقیم `@esbuild-kit/*` از ابزار توسعهٔ Drizzle Kit همچنان وجود دارند. override محدود esbuild که در v1.2 اعمال شده بود حفظ شده است؛ نه `audit fix --force`، downgrade ناسازگار یا patch دستی vendor. audit صفر تضمین امنیت منطق یا supply chain نیست.

## انجام‌نشده / مرز پذیرش

- استقرار Vercel، ساخت Turso ابری و تنظیم secretهای واقعی یا ثبت Webhook؛
- اتصال/مجوز write/سهمیه/region واقعی، مثبت‌بودن preflight ابری، `getWebhookInfo` و `/start` واقعی؛
- بار HTTP یا اینترنتی، rate limit Telegram، چندprocess، cold start، soak طولانی یا SLA؛
- penetration test، ممیزی مستقل امنیت، usability study و آزمون کلاینت Telegram/Excel واقعی؛
- پرداخت بانکی، استعلام زندهٔ carrier، پنل مشتری یا notification؛ این‌ها به دامنهٔ فقط‌کارکنان اضافه نشده‌اند.

نتایج بالا، پذیرش **قابل اندازه‌گیری آفلاین** هستند، نه تضمین «۱۰/۱۰». راهنمای نصب آماده است، اما کلیدها را فقط خصوصی در محیط خودتان تنظیم و staging واقعی را جدا اجرا کنید. [نصب تازه](INSTALL_VERCEL_TURSO.md) · [تست](TESTING.md) · [امنیت](../SECURITY.md).
