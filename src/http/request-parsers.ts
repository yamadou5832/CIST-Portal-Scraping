import type { OfficeMemoFilter } from "../types.js";

export function getQueryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export function parsePositiveInteger(value: unknown): number | null {
  const raw = getQueryString(value);
  if (raw === undefined) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function parseOfficeMemoFilter(value: unknown): OfficeMemoFilter | null {
  const filter = getQueryString(value) ?? "all";
  if (filter === "all" || filter === "unread" || filter === "read" || filter === "star") {
    return filter;
  }
  return null;
}
