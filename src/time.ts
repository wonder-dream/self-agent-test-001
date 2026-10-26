const SHANGHAI = "Asia/Shanghai";

export type ShanghaiParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function shanghaiParts(date: Date): ShanghaiParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const parts = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
  };
}

export function shanghaiDay(date: Date): string {
  const parts = shanghaiParts(date);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

export function formatShanghai(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function nextShanghaiMidnight(now: Date): Date {
  const [year, month, day] = shanghaiDay(now).split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1, -8, 0, 0));
}

export function msUntil(now: Date, then: Date): number {
  return Math.max(0, then.getTime() - now.getTime());
}
