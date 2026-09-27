import { Temporal } from "@js-temporal/polyfill";

export function isoToLocalInput(iso: string, timezone: string): string {
  try {
    return Temporal.Instant.from(iso)
      .toZonedDateTimeISO(timezone)
      .toPlainDateTime()
      .toString({ smallestUnit: "minute" });
  } catch {
    return "";
  }
}

export function localInputToIso(local: string, timezone: string): string {
  return Temporal.PlainDateTime.from(local)
    .toZonedDateTime(timezone)
    .toInstant()
    .toString();
}

export function displayInstant(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}
