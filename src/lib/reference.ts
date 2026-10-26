import { randomBytes } from "node:crypto";
import { normalizeDigits } from "./validation";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 symbols; no I/O/0/1.
export function generateOrderReference(): string {
  const bytes = randomBytes(12);
  return `REF-${Array.from(bytes, (b) => ALPHABET[b & 31]).join("")}`;
}
// Accept copied/spaced/dashed references; legacy migration codes may contain 0 and 1.
export function compactReference(value: string): string {
  return normalizeDigits(value).replace(/[\s-]/g, "").toUpperCase();
}
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
