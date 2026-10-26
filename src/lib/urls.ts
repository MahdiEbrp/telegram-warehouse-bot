import { isIP } from "node:net";
import { z } from "zod";
import { wellFormedText } from "./text";
/** Syntactic guard only: does not fetch, resolve DNS or certify a destination. */
export function safePublicHttpsUrl(value: string): boolean {
  try {
    if (/[\u0000-\u0020\u007f]/.test(value) || !wellFormedText(value)) return false;
    const url = new URL(value),
      host = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      host.includes(".") &&
      !isIP(host.replace(/^\[|\]$/g, "")) &&
      host !== "localhost" &&
      ![".localhost", ".local", ".internal"].some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}
export function publicHttpsInput(max: number) {
  return z
    .string()
    .trim()
    .max(max, `حداکثر ${max} نویسه مجاز است.`)
    .refine(safePublicHttpsUrl, "لینک HTTPS عمومی بدون نام کاربری، رمز یا پورت سفارشی وارد کنید.")
    .transform((value) => new URL(value).toString())
    .pipe(z.string().max(max, `حداکثر ${max} نویسه مجاز است.`));
}
