import { formatDateTimeLocalInTimeZone, parseDateTimeLocalInTimeZone } from "./zoned-date-time";

export const MESSAGE_SCHEDULE_TIME_ZONE = "Asia/Gaza";
const pad = (n: number) => String(n).padStart(2, "0");

function assertCycleTime(value: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RangeError("Invalid schedule time.");
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  const next = new Date(Date.UTC(year, month, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function buildMonthlyScheduleAnchor(day: number, time: string, now = new Date(), zone = MESSAGE_SCHEDULE_TIME_ZONE): string {
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new RangeError("Invalid monthly schedule day.");
  assertCycleTime(time);

  const currentWall = formatDateTimeLocalInTimeZone(now, zone);
  const [currentYear, currentMonth] = currentWall.slice(0, 10).split("-").map(Number);
  let year = currentYear;
  let month = currentMonth;

  // Find the next valid occurrence. A day such as the 31st skips months
  // without that date, and a time already passed today advances a month.
  for (let attempt = 0; attempt < 14; attempt++) {
    if (day <= daysInMonth(year, month)) {
      const candidateWall = `${year}-${pad(month)}-${pad(day)}T${time}`;
      if (candidateWall > currentWall) return parseDateTimeLocalInTimeZone(candidateWall, zone).toISOString();
    }
    ({ year, month } = nextMonth(year, month));
  }
  throw new RangeError("Could not find the next valid monthly schedule occurrence.");
}

export function buildWeeklyScheduleAnchor(day: number, time: string, now = new Date(), zone = MESSAGE_SCHEDULE_TIME_ZONE): string {
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new RangeError("Invalid weekly schedule day.");
  assertCycleTime(time);

  const currentWall = formatDateTimeLocalInTimeZone(now, zone);
  const date = new Date(`${currentWall.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + (day - date.getUTCDay() + 7) % 7);
  let candidateWall = `${date.toISOString().slice(0, 10)}T${time}`;
  if (candidateWall <= currentWall) {
    date.setUTCDate(date.getUTCDate() + 7);
    candidateWall = `${date.toISOString().slice(0, 10)}T${time}`;
  }
  return parseDateTimeLocalInTimeZone(candidateWall, zone).toISOString();
}
