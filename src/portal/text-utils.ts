export function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeMultiline(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join("\n");
}
