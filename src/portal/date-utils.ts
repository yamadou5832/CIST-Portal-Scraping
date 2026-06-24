function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function parsePortalDateTime(text: string, fallbackYear?: number): Date {
  const cleaned = text.replace(/[（(][^)）]*[）)]/g, "").replace(/\s+/g, " ").trim();

  const fullMatch = /^(\d{4})\/(\d{2})\/(\d{2})\s*(\d{2}):(\d{2})$/.exec(cleaned);
  if (fullMatch) {
    const [, year, month, day, hour, minute] = fullMatch;
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      0,
      0,
    );
  }

  const shortMatch = /^(\d{2})\/(\d{2})\s*(\d{2}):(\d{2})$/.exec(cleaned);
  if (shortMatch) {
    const year = fallbackYear ?? new Date().getFullYear();
    const [, month, day, hour, minute] = shortMatch;
    return new Date(
      year,
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      0,
      0,
    );
  }

  throw new Error(`Failed to parse portal datetime: ${text}`);
}

export function parsePortalMonthDay(text: string, referenceDate: Date): Date {
  const cleaned = text.replace(/\s+/g, "").trim();

  const fullMatch = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(cleaned);
  if (fullMatch) {
    const [, year, month, day] = fullMatch;
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      0,
      0,
      0,
      0,
    );
  }

  const shortMatch = /^(\d{2})\/(\d{2})$/.exec(cleaned);
  if (shortMatch) {
    const [, month, day] = shortMatch;
    const currentYear = referenceDate.getFullYear();
    const candidate = new Date(currentYear, Number.parseInt(month, 10) - 1, Number.parseInt(day, 10), 0, 0, 0, 0);

    const referenceMidnight = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate(),
      0,
      0,
      0,
      0,
    );
    const diffMs = candidate.getTime() - referenceMidnight.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (diffDays > 31) {
      candidate.setFullYear(candidate.getFullYear() - 1);
    }

    return candidate;
  }

  const timeMatch = /^(\d{2}):(\d{2})$/.exec(cleaned);
  if (timeMatch) {
    return new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate(),
      0,
      0,
      0,
      0,
    );
  }

  throw new Error(`Failed to parse portal month/day: ${text}`);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}
