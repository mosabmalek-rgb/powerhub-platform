type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute),
  };
}

function wallTimeString(parts: ZonedParts): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatDateTimeLocalInTimeZone(value: Date | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid schedule anchor.");
  return wallTimeString(zonedParts(date, timeZone));
}

export function parseDateTimeLocalInTimeZone(value: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Invalid local schedule time.");
  const target: ZonedParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const targetWallMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const normalized = new Date(targetWallMs);
  if (normalized.getUTCFullYear() !== target.year || normalized.getUTCMonth() + 1 !== target.month ||
      normalized.getUTCDate() !== target.day || normalized.getUTCHours() !== target.hour || normalized.getUTCMinutes() !== target.minute) {
    throw new RangeError("Invalid local schedule date.");
  }

  let candidateMs = targetWallMs;
  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = zonedParts(new Date(candidateMs), timeZone);
    const actualWallMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const difference = targetWallMs - actualWallMs;
    if (difference === 0) {
      const candidate = new Date(candidateMs);
      if (formatDateTimeLocalInTimeZone(candidate, timeZone) === value) return candidate;
      break;
    }
    candidateMs += difference;
  }
  throw new RangeError("The selected wall time does not exist in the requested time zone.");
}
