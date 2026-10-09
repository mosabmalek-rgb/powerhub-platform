import { formatDateTimeLocalInTimeZone, parseDateTimeLocalInTimeZone } from "./zoned-date-time";
export const MESSAGE_SCHEDULE_TIME_ZONE = "Asia/Gaza";
const pad = (n: number) => String(n).padStart(2, "0");
function assertCycleTime(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RangeError("Invalid schedule time.");
}
export function buildMonthlyScheduleAnchor(day: number, time: string, now = new Date(), zone = MESSAGE_SCHEDULE_TIME_ZONE): string {
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new RangeError("Invalid monthly schedule day.");
  assertCycleTime(time);
  const current = formatDateTimeLocalInTimeZone(now, zone);
  const [year, month] = current.slice(0,10).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let y = year, m = month;
  if (day > last) { const next = new Date(Date.UTC(year, month, 1)); y = next.getUTCFullYear(); m = next.getUTCMonth()+1; }
  return parseDateTimeLocalInTimeZone(`${y}-${pad(m)}-${pad(day)}T${time}`, zone).toISOString();
}
export function buildWeeklyScheduleAnchor(day: number, time: string, now = new Date(), zone = MESSAGE_SCHEDULE_TIME_ZONE): string {
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new RangeError("Invalid weekly schedule day.");
  assertCycleTime(time);
  const date = new Date(`${formatDateTimeLocalInTimeZone(now, zone).slice(0,10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + (day - date.getUTCDay() + 7) % 7);
  return parseDateTimeLocalInTimeZone(`${date.toISOString().slice(0,10)}T${time}`, zone).toISOString();
}
