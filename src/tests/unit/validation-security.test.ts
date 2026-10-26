import { describe, expect, it } from "vitest";
import {
  imageUrlInput,
  nameInput,
  optionalText,
  plainText,
  priceInput,
  productInput,
  storeInput,
  userInput,
} from "@/lib/validation";
import { safePublicHttpsUrl } from "@/lib/urls";
import { shipmentCarrierNameInput, shipmentNoteInput } from "@/lib/shipping";
import { clipText, wellFormedText } from "@/lib/text";
import { displayValue } from "@/bot/ui/cards";
import { testProduct } from "../helpers/database";

describe("bounded text and URL input security", () => {
  it("clips labels in UTF-16 units without splitting an emoji surrogate pair", () => {
    for (const text of ["a" + "🙂".repeat(600), "فارسی می‌رود 👩‍💻", "ASCII"]) {
      for (const limit of [0, 1, 2, 3, 20, 25, 28, 35, 40, 45, 60, 64, 100, 190, 1100]) {
        const clipped = clipText(text, limit);
        expect(clipped.length).toBeLessThanOrEqual(limit);
        expect(wellFormedText(clipped)).toBe(true);
        expect(text.startsWith(clipped)).toBe(true);
      }
    }
    expect(clipText("a🙂b", 2)).toBe("a");
    expect(clipText("a🙂b", 3)).toBe("a🙂");
  });
  it("keeps the card display bound while preserving valid Unicode", () => {
    const clipped = displayValue("a" + "🙂".repeat(600));
    expect(clipped.length).toBe(1099);
    expect(wellFormedText(clipped)).toBe(true);
    expect(displayValue("فارسی 🙂")).toBe("فارسی 🙂");
  });
  it.each([
    "\u0000",
    "\u0001",
    "\u0007",
    "\u000b",
    "\u000c",
    "\u001f",
    "\u007f",
    "\ud800",
    "\udfff",
  ])("rejects embedded invalid text %# across domain inputs", (bad) => {
    const value = `متن${bad}آزمون`;
    expect(plainText(100).safeParse(value).success).toBe(false);
    expect(nameInput.safeParse(value).success).toBe(false);
    expect(productInput.safeParse({ ...testProduct, description: value }).success).toBe(false);
    expect(shipmentNoteInput.safeParse(value).success).toBe(false);
    expect(shipmentCarrierNameInput.safeParse(value).success).toBe(false);
    expect(
      userInput.safeParse({ telegramId: 701, firstName: value, role: "viewer", isActive: true })
        .success,
    ).toBe(false);
    expect(
      storeInput.safeParse({
        name: "آزمون",
        phone: "",
        address: value,
        paymentInstructions: "بانکی",
      }).success,
    ).toBe(false);
  });
  it("preserves valid Persian, ZWNJ, emoji and multiline notes; names remain single-line", () => {
    const text = "ارسال می‌شود 🛒\nپلاک ۱۲\tواحد ۳";
    expect(plainText(500).parse(text)).toBe(text);
    expect(wellFormedText("😀 فارسی")).toBe(true);
    expect(nameInput.safeParse("نام\nدیگر").success).toBe(false);
    expect(nameInput.parse("  می‌رود 🛒  ")).toBe("می‌رود 🛒");
  });
  it.each([
    "http://example.com/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://name:password@example.com/a",
    "https://example.com:8443/a",
    "https://a.internal/a",
    "https://example.com/a\u0000b",
    "https://example.com/a\nb",
    "https://example.com/\ud800",
    "not a URL",
  ])("rejects unsafe image URL %#", (value) => {
    expect(safePublicHttpsUrl(value)).toBe(false);
    expect(imageUrlInput.safeParse(value).success).toBe(false);
    expect(productInput.safeParse({ ...testProduct, imageUrl: value }).success).toBe(false);
  });
  it("canonicalizes a structural HTTPS URL without fetching or claiming DNS safety", () => {
    expect(imageUrlInput.parse("https://EXAMPLE.com/photo?q=01")).toBe(
      "https://example.com/photo?q=01",
    );
    expect(safePublicHttpsUrl("https://a.example.com/path")).toBe(true);
    expect(imageUrlInput.safeParse(`https://example.com/${"ا".repeat(200)}`).success).toBe(false);
    expect(safePublicHttpsUrl("https://example.com/\u001f")).toBe(false);
    expect(safePublicHttpsUrl("https://example.com/with space")).toBe(false);
  });
  it("supports explicit optional clearing, numeric zero and strict field validation", () => {
    const schema = optionalText(priceInput);
    expect(schema.parse("-")).toBeNull();
    expect(schema.parse("  ")).toBeNull();
    expect(schema.parse("۰")).toBe(0);
    expect(schema.safeParse("-1").success).toBe(false);
    expect(plainText(3).safeParse("چهار").success).toBe(false);
  });
});
