export function normalizeUrl(input: string): string {
  const url = new URL(input);
  const pathname = url.pathname.endsWith("/") && url.pathname !== "/" ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${pathname}`;
}
