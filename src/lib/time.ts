function parts(date: Date, timeZone: string) {
  const entries = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (name: string) => Number(entries.find((x) => x.type === name)?.value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    min: get("minute"),
    s: get("second"),
  };
}
function localMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const local = Date.UTC(y, m - 1, d);
  let guess = local;
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(guess), timeZone);
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess;
    guess = local - offset;
  }
  return new Date(guess);
}
// Half-open local-calendar periods; not a fixed 24h, so DST days work as well.
export function periodBounds(now: Date, kind: "day" | "month", timeZone: string) {
  const p = parts(now, timeZone);
  const start = localMidnight(p.y, p.m, kind === "month" ? 1 : p.d, timeZone);
  const next = new Date(
    Date.UTC(p.y, kind === "month" ? p.m : p.m - 1, kind === "month" ? 1 : p.d + 1),
  );
  const end = localMidnight(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone,
  );
  return { start, end };
}
export function dateLabel(date: Date, timeZone: string) {
  return date.toLocaleString("fa-IR", { timeZone });
}
