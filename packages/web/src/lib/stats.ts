import type { API } from "@weer/common";

type Interval = API.Url.Analytics["interval"];

// The time zone of the visitor, so the days of the charts are theirs
export const timeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

// 1,284 or 12.9K
export const formatNumber = (value: number): string =>
  new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);

export const formatPercent = (value: number, total: number): string => {
  if (!total || !value) return "0%";
  const percent = (value / total) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
};

// A bar of the timeline starts like "2026-10-19T14:00", in the time zone of the visitor
export const parseBarStart = (start: string): Date => {
  const [date, time] = start.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time || "00:00").split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
};

const format = (date: Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en", options).format(date);

// The short label under a bar
export const axisLabel = (start: string, interval: Interval): string => {
  const date = parseBarStart(start);
  switch (interval) {
    case "hour":
      return format(date, { hour: "numeric" });
    case "month":
      return format(date, { month: "short", year: "2-digit" });
    default:
      return format(date, { month: "short", day: "numeric" });
  }
};

// The full label of a bar in its tooltip
export const barLabel = (start: string, interval: Interval): string => {
  const date = parseBarStart(start);
  switch (interval) {
    case "hour": {
      const end = new Date(date.getTime() + 60 * 60 * 1000);
      return `${format(date, { month: "short", day: "numeric" })}, ${format(date, {
        hour: "numeric",
        minute: "2-digit",
      })} – ${format(end, { hour: "numeric", minute: "2-digit" })}`;
    }
    case "week":
      return `Week of ${format(date, { month: "short", day: "numeric", year: "numeric" })}`;
    case "month":
      return format(date, { month: "long", year: "numeric" });
    default:
      return format(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
};

// "3 hours ago"
export const timeAgo = (iso: string): string => {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 24 * 3600],
    ["month", 30 * 24 * 3600],
    ["day", 24 * 3600],
    ["hour", 3600],
    ["minute", 60],
  ];

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
};

export const formatDateTime = (iso: string): string =>
  format(new Date(iso), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// "United States" for "US"
export const countryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
};

// The flag emoji of a country code: each letter as a regional indicator symbol
export const countryFlag = (code: string): string =>
  /^[A-Z]{2}$/.test(code)
    ? String.fromCodePoint(...code.split("").map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
    : "";
