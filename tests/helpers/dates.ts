// Calendar helpers for tests that run against the REAL clock (their server code reads `new Date()`), so expected day labels
// are computed from "now" instead of being typed in. Hand-typed labels such as "Fri 30 Oct" were only true on the day they
// were written: they failed once "Friday" became "tomorrow", and an undated order's default day also depends on the hour
// (before 9:00 St Lucia time it is today). America/St_Lucia is UTC-4 all year (no daylight saving).

const OFFSET_HOURS = -4;

/** Calendar parts of `now` in St Lucia time. */
function local(now: Date) {
  const shifted = new Date(now.getTime() + OFFSET_HOURS * 3_600_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/** The day `daysFromToday` away, in the form the app writes: label "Fri 30 Oct", input "30 Oct". */
export function stLuciaDay(daysFromToday: number, now: Date = new Date()): { label: string; input: string; weekday: string } {
  const t = local(now);
  const date = new Date(Date.UTC(t.y, t.m, t.d + daysFromToday, 12));
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(date);
  const input = `${date.getUTCDate()} ${fmt({ month: "short" })}`;
  return { label: `${fmt({ weekday: "short" })} ${input}`, input, weekday: fmt({ weekday: "long" }) };
}

/** The day an undated order is for: today before 9:00 St Lucia time, otherwise tomorrow. */
export function defaultOrderDay(now: Date = new Date()) {
  return stLuciaDay(local(now).minutes < 9 * 60 ? 0 : 1, now);
}

/** The next occurrence of `weekday` ("Friday") after today; a request for today's weekday means next week. */
export function nextWeekday(weekday: string, now: Date = new Date()) {
  for (let i = 1; i <= 7; i += 1) {
    const day = stLuciaDay(i, now);
    if (day.weekday.toLowerCase() === weekday.toLowerCase()) return day;
  }
  throw new Error(`unknown weekday ${weekday}`);
}
