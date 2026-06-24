import type { Page } from "playwright";

export async function getCurrentPortalDate(page: Page): Promise<Date> {
  const dateText = await page.evaluate(() => {
    const element = document.querySelector("header .bi-clock-fill + span");
    return element?.textContent?.trim() ?? "";
  });

  const match = dateText.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  if (!match) {
    throw new Error(`Failed to parse current portal date: ${dateText}`);
  }

  const [, year, month, day] = match;
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
