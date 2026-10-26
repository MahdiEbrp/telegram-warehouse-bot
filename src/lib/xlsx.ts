import { zipSync, strToU8 } from "fflate";
import type { ShipmentExport } from "@/db/queries/exports";
import { carrierLabel, shipmentStateLabels } from "@/lib/shipping";
import { paymentLabel, statusLabel } from "@/bot/labels";
import { MAX_EXPORT_ROWS } from "@/types/domain";
import { invariant } from "@/lib/errors";

// OOXML inline strings are literal, never formulas. No macros, hyperlinks or external relationships.
export function xmlText(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const n = char.codePointAt(0)!;
      return (
        n === 9 ||
        n === 10 ||
        n === 13 ||
        (n >= 32 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff)
      );
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function column(index: number): string {
  let value = index + 1,
    text = "";
  while (value > 0) {
    value--;
    text = String.fromCharCode(65 + (value % 26)) + text;
    value = Math.floor(value / 26);
  }
  return text;
}
type Cell = string | number | null;
function sheet(headers: string[], rows: Cell[][]): string {
  const last = column(headers.length - 1);
  const render = (cells: Cell[], row: number) =>
    `<row r="${row}"${row === 1 ? ' ht="32" customHeight="1"' : ""}>${cells
      .map((value, c) => {
        const ref = `${column(c)}${row}`;
        if (value === null) return `<c r="${ref}" s="1"/>`;
        if (typeof value === "number") {
          invariant(
            Number.isSafeInteger(value) && value >= 0,
            "BAD_EXPORT_NUMBER",
            "مقدار عددی خروجی معتبر نیست.",
          );
          return `<c r="${ref}" s="2"><v>${value}</v></c>`;
        }
        return `<c r="${ref}" s="${row === 1 ? 0 : 1}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value.slice(0, 32767))}</t></is></c>`;
      })
      .join("")}</row>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}${rows.length + 1}"/><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols><col min="1" max="${headers.length}" width="24" customWidth="1"/></cols><sheetData>${render(headers, 1)}${rows.map((row, i) => render(row, i + 2)).join("")}</sheetData><autoFilter ref="A1:${last}${rows.length + 1}"/></worksheet>`;
}
export function shipmentWorkbook(data: ShipmentExport): Uint8Array {
  invariant(
    data.rows.length <= MAX_EXPORT_ROWS,
    "EXPORT_LIMIT",
    "تعداد ردیف خروجی بیش از حد مجاز است.",
  );
  const headers = [
    "کد پیگیری سفارش",
    "شماره سفارش",
    "مشتری",
    "تلفن",
    "نشانی",
    "کد پستی",
    "وضعیت سفارش",
    "وضعیت پرداخت",
    "شماره مرسوله",
    "وضعیت مرسوله",
    "شرکت حمل",
    "کد رهگیری مرسوله",
    "لینک اختصاصی",
    "هزینه داخلی حمل (تومان)",
    "ثبت ارسال (UTC)",
    "ثبت تحویل (UTC)",
    "یادداشت ارسال",
    "ایجاد سفارش (UTC)",
    "ایجاد مرسوله (UTC)",
    "ویرایش مرسوله (UTC)",
    "نسخه مرسوله",
  ];
  const rows: Cell[][] = data.rows.map((row) => [
    row.referenceCode ?? row.orderNumber,
    row.orderNumber,
    row.customerName,
    row.customerPhone,
    row.address,
    row.postalCode,
    statusLabel[row.orderStatus],
    paymentLabel[row.paymentStatus],
    row.parcelNumber,
    row.state ? shipmentStateLabels[row.state] : "اطلاعات ثبت نشده",
    row.carrier ? carrierLabel(row.carrier, row.carrierName ?? "") : "",
    row.trackingNumber,
    row.trackingUrl,
    row.shippingCost,
    row.dispatchedAt?.toISOString() ?? null,
    row.deliveredAt?.toISOString() ?? null,
    row.note,
    row.orderCreatedAt.toISOString(),
    row.shipmentCreatedAt?.toISOString() ?? null,
    row.updatedAt?.toISOString() ?? null,
    row.version,
  ]);
  const info: Cell[][] = [
    ["نسخه", "1.3.0"],
    ["زمان تولید (UTC)", data.generatedAt.toISOString()],
    ["فیلتر سفارش", data.options.filter],
    ["فیلتر مرسوله", data.options.state],
    ["بازه", data.options.period],
    ["منطقه زمانی مرز بازه", data.timeZone],
    ["شروع بازه (شامل)", data.range?.start ?? "همه"],
    ["پایان بازه (غیرشامل)", data.range?.end ?? "همه"],
    ["مبنای بازه", "تاریخ ایجاد سفارش؛ ماه میلادی است"],
    ["ردیف‌ها", rows.length],
    [
      "تفسیر",
      "هر ردیف یک مرسوله؛ سفارش بدون مرسوله یک ردیف خالی دارد. مبلغ کل سفارش تکرار نشده است.",
    ],
    ["هزینه", "هزینه حمل داخلی است، نه افزایش مبلغ مشتری یا سود خالص."],
    ["زمان نامعلوم", "خالی است؛ برای سفارش قدیمی زمان ساختگی ثبت نشده."],
    ["کدها", "کد، تلفن و کد پستی متن هستند؛ صفر ابتدایی و بزرگی حروف حفظ شده."],
    ["ایمنی", "همه رشته‌ها literal هستند؛ فرمول، macro و ارتباط خارجی ساخته نشده."],
    ["محرمانگی", "فقط کارکنان مجاز؛ فایل حاوی اطلاعات مشتری است و نباید عمومی/فوروارد شود."],
  ];
  const contents = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="مرسوله‌ها" sheetId="1" r:id="rId1"/><sheet name="راهنما" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font><font><sz val="11"/><name val="Tahoma"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173D57"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyAlignment="1" applyFill="1" applyFont="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1"/></xf><xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheet(headers, rows),
    "xl/worksheets/sheet2.xml": sheet(["موضوع", "توضیح"], info),
  };
  const bytes = zipSync(
    Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, strToU8(value)])),
    { level: 6, mtime: new Date(2000, 0, 1) },
  );
  invariant(
    bytes.byteLength <= 8 * 1024 * 1024,
    "EXPORT_TOO_LARGE",
    "فایل خروجی بزرگ‌تر از سقف ۸ مگابایت است؛ بازه را محدود کنید.",
  );
  return bytes;
}
