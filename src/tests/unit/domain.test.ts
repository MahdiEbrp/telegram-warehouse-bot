import { describe, expect, it } from "vitest";
import { calculateTotal, lineTotal, validateStock } from "@/lib/money";
import { can, callbackPermission } from "@/lib/permissions";
import {
  normalizeDigits,
  priceInput,
  skuInput,
  stockInput,
  productPatch,
  phoneInput,
} from "@/lib/validation";
import { parseDatabaseEnv, parseEnv } from "@/lib/env";
import { periodBounds } from "@/lib/time";

describe("pure domain functions", () => {
  it("calculates integer money without rounding", () => {
    expect(
      calculateTotal([
        { unitPrice: 12500, quantity: 2 },
        { unitPrice: 100, quantity: 3 },
      ]),
    ).toBe(25300);
  });
  it.each([
    [-1, 1],
    [100, 0],
    [100.5, 2],
    [1e12, 1e6],
  ])("rejects invalid/overflow line %s x %s", (price, quantity) => {
    expect(() => lineTotal(price, quantity)).toThrow();
  });
  it("rejects aggregate overflow", () => {
    expect(() =>
      calculateTotal([
        { unitPrice: Number.MAX_SAFE_INTEGER, quantity: 1 },
        { unitPrice: 1, quantity: 1 },
      ]),
    ).toThrow();
  });
  it("validates available stock", () => {
    expect(() => validateStock(5, 5)).not.toThrow();
    expect(() => validateStock(4, 5)).toThrow();
    expect(() => validateStock(10, -1)).toThrow();
  });
  it("normalizes Persian/Arabic digits and separators", () => {
    expect(normalizeDigits("۱۲٣٤۵")).toBe("12345");
    expect(priceInput.parse("۱٬۲۵۰,۰۰۰")).toBe(1250000);
    expect(skuInput.parse("sku-۱۲")).toBe("SKU-12");
    expect(phoneInput.parse("+۹۸ ۹۱۲ ۳۴۵ ۶۷۸۹")).toBe("+989123456789");
  });
  it.each(["-1", "1.5", "", "abc", "1e3", "1000001"])("rejects invalid stock %s", (input) => {
    expect(stockInput.safeParse(input).success).toBe(false);
  });
  it("PATCH never applies create defaults", () => {
    expect(productPatch.parse({ name: "نام جدید" })).toEqual({ name: "نام جدید" });
    expect(productPatch.safeParse({ stockQuantity: 8 }).success).toBe(false);
  });
  it("enforces role grants and callback permissions", () => {
    expect(can("super_admin", "users:manage")).toBe(true);
    expect(can("admin", "users:manage")).toBe(false);
    expect(can("operator", "orders:status")).toBe(true);
    expect(can("operator", "orders:payment")).toBe(false);
    expect(can("viewer", "products:write")).toBe(false);
    expect(callbackPermission("w:pa:nonce:save:yes")).toBe("products:write");
    expect(callbackPermission("o:change:id:cancelled")).toBe("orders:status");
    expect(callbackPermission("u:list:0")).toBe("users:manage");
  });
});
describe("environment validation", () => {
  it("defaults to local SQLite but requires cloud authentication", () => {
    expect(parseDatabaseEnv({}).TURSO_DATABASE_URL).toMatch(/^file:/);
    expect(() => parseDatabaseEnv({ TURSO_DATABASE_URL: "libsql://store.turso.io" })).toThrow();
    expect(() => parseDatabaseEnv({ TURSO_DATABASE_URL: "file:db.sqlite", VERCEL: "1" })).toThrow();
  });
  it("rejects weak webhook secrets and invalid owner IDs", () => {
    expect(() =>
      parseEnv({
        BOT_TOKEN: "123:abcdefghijklmnopqrstuvwxyz123456789",
        TELEGRAM_WEBHOOK_SECRET: "x",
        SUPER_ADMIN_TELEGRAM_IDS: "name",
      }),
    ).toThrow();
  });
});
describe("time-zone reports", () => {
  it("uses Tehran local midnight instead of UTC", () => {
    const b = periodBounds(new Date("2026-10-24T21:00:00Z"), "day", "Asia/Tehran");
    expect(b.start.toISOString()).toBe("2026-10-24T20:30:00.000Z");
    expect(b.end.toISOString()).toBe("2026-10-25T20:30:00.000Z");
  });
  it("handles a 23-hour DST day", () => {
    const b = periodBounds(new Date("2026-03-29T12:00:00Z"), "day", "Europe/Berlin");
    expect((b.end.getTime() - b.start.getTime()) / 3600000).toBe(23);
  });
  it("handles a 25-hour DST day", () => {
    const b = periodBounds(new Date("2026-10-25T12:00:00Z"), "day", "Europe/Berlin");
    expect((b.end.getTime() - b.start.getTime()) / 3600000).toBe(25);
  });
  it("rolls Gregorian months across years", () => {
    const b = periodBounds(new Date("2026-12-31T18:00:00Z"), "month", "Asia/Tehran");
    expect(b.start.toISOString()).toBe("2026-11-30T20:30:00.000Z");
    expect(b.end.toISOString()).toBe("2026-12-31T20:30:00.000Z");
  });
});
