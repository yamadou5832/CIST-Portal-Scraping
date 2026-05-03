import { promises as fs } from "node:fs";
import path from "node:path";
import { Browser, chromium, type BrowserContext, type Page } from "playwright";

import type { AppConfig } from "./config.js";
import type {
  FetchReceivedOfficeMemosOptions,
  MyPageData,
  OfficeMemoFilter,
  ReceivedOfficeMemo,
  ReflectionReply,
  TimetableEntry,
  UnsubmittedReport,
} from "./types.js";

interface RawUnsubmittedReport {
  course_name: string;
  courseId: string;
  report_name: string;
  lectureId: string;
  start_at: string;
  end_at: string;
}

interface RawReflectionReply {
  date: string;
  course_name: string;
  courseId: string;
  report_name: string;
  lectureId: string;
}

interface RawTimetableEntry {
  day_index: number;
  period: number;
  classroom: string;
  course_name: string;
  courseId: string;
}

interface RawReceivedOfficeMemo {
  title: string;
  officeMemoId: string;
  category: string;
  date: string;
  isBookmarked: boolean;
  isReviewNeeded: boolean;
  isUnread: boolean;
  isUpdated: boolean;
  isImportant: boolean;
}

interface RawReceivedOfficeMemosPage {
  items: RawReceivedOfficeMemo[];
  isLastPage: boolean;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function parsePortalDateTime(text: string, fallbackYear?: number): Date {
  const cleaned = text.replace(/[（(][^)）]*[）)]/g, "").replace(/\s+/g, " ").trim();

  const fullMatch = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(cleaned);
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

  const shortMatch = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(cleaned);
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

function parsePortalMonthDay(text: string, referenceDate: Date): Date {
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

  throw new Error(`Failed to parse portal month/day: ${text}`);
}

function normalizeUrl(input: string): string {
  const url = new URL(input);
  const pathname = url.pathname.endsWith("/") && url.pathname !== "/" ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${pathname}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export class PortalScraperService {
  private browser: Browser | null = null;

  constructor(private readonly config: AppConfig) {}

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async fetchMyPageData(): Promise<MyPageData> {
    return this.withAuthenticatedPage(async (page) => {
      const [unsubmitted_reports, new_reflection_replies, timetable] = await Promise.all([
        this.extractUnsubmittedReports(page),
        this.extractReflectionReplies(page),
        this.extractTimetable(page),
      ]);
      return {
        unsubmitted_reports,
        new_reflection_replies,
        timetable,
      } as MyPageData;
    });
  }

  async fetchUnsubmittedReports(): Promise<UnsubmittedReport[]> {
    return this.withAuthenticatedPage((page) => this.extractUnsubmittedReports(page));
  }

  async fetchReflectionReplies(): Promise<ReflectionReply[]> {
    return this.withAuthenticatedPage((page) => this.extractReflectionReplies(page));
  }

  async fetchTimetable(): Promise<TimetableEntry[]> {
    return this.withAuthenticatedPage((page) => this.extractTimetable(page));
  }

  async fetchReceivedOfficeMemos(options: FetchReceivedOfficeMemosOptions = {}): Promise<ReceivedOfficeMemo[]> {
    const filter = options.filter ?? "all";
    const searchKeyword = options.searchKeyword ?? "";
    const categoryFilter = options.categoryFilter ?? "c_all";

    return this.withAuthenticatedPage(async (page) => {
      const referenceDate = await this.getCurrentPortalDate(page);
      const items: ReceivedOfficeMemo[] = [];
      const seenIds = new Set<string>();
      let currentPage = 1;

      while (true) {
        const receivedTitlesUrl = this.buildReceivedOfficeMemosUrl(currentPage, filter, searchKeyword, categoryFilter);
        await page.goto(receivedTitlesUrl, { waitUntil: "domcontentloaded" });

        const { items: rawItems, isLastPage } = await this.extractReceivedOfficeMemosPage(page);

        for (const rawItem of rawItems) {
          if (seenIds.has(rawItem.officeMemoId)) {
            continue;
          }

          let date: Date;
          try {
            date = parsePortalMonthDay(rawItem.date, referenceDate);
          } catch {
            continue;
          }

          seenIds.add(rawItem.officeMemoId);
          items.push({
            title: rawItem.title,
            officeMemoId: rawItem.officeMemoId,
            category: rawItem.category,
            date,
            isBookmarked: rawItem.isBookmarked,
            isReviewNeeded: rawItem.isReviewNeeded,
            isUnread: rawItem.isUnread,
            isUpdated: rawItem.isUpdated,
            isImportant: rawItem.isImportant,
          });
        }

        if (isLastPage) {
          break;
        }

        currentPage += 1;
      }

      return items;
    });
  }

  private buildReceivedOfficeMemosUrl(
    currentPage: number,
    filter: OfficeMemoFilter,
    searchKeyword: string,
    categoryFilter: string,
  ): string {
    const url = new URL(`${this.config.portalUrl}/portal/OfficeMemo/ViewReceivedTitles`);
    url.searchParams.set("currentPage", String(Math.max(1, currentPage)));
    url.searchParams.set("filter", filter);
    url.searchParams.set("searchKeyword", searchKeyword);
    url.searchParams.set("c_filter", categoryFilter);
    return url.toString();
  }

  private async withAuthenticatedPage<T>(handler: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser();
    const context = await this.newContext(browser);
    const page = await context.newPage();

    try {
      await this.ensureLoggedIn(page, context);
      await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });
      return await handler(page);
    } finally {
      await context.close();
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.config.headless });
    }
    return this.browser;
  }

  private async newContext(browser: Browser): Promise<BrowserContext> {
    const hasState = await this.pathExists(this.config.storageStatePath);
    if (hasState) {
      return browser.newContext({ storageState: this.config.storageStatePath });
    }
    return browser.newContext();
  }

  private async ensureLoggedIn(page: Page, context: BrowserContext): Promise<void> {
    await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });

    const target = normalizeUrl(this.targetUrl);
    const login = normalizeUrl(this.loginUrl);
    let current = normalizeUrl(page.url());

    if (current === target) {
      await this.persistStorageState(context);
      return;
    }

    if (current.startsWith(login)) {
      const usernameInput = page.locator("#username");
      const passwordInput = page.locator("#password");
      const loginButton = page.locator("#login");

      await usernameInput.waitFor({ state: "visible", timeout: 15000 });
      await usernameInput.fill(this.config.username);
      await passwordInput.fill(this.config.password);

      await Promise.all([
        page.waitForURL((url) => normalizeUrl(url.toString()) === target, { timeout: 15000 }).catch(() => undefined),
        loginButton.click(),
      ]);

      current = normalizeUrl(page.url());
      if (current !== target) {
        await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });
        current = normalizeUrl(page.url());
      }
    }

    if (current !== target) {
      throw new Error(`Failed to login. currentUrl=${page.url()}`);
    }

    await this.persistStorageState(context);
  }

  private async persistStorageState(context: BrowserContext): Promise<void> {
    await fs.mkdir(path.dirname(this.config.storageStatePath), { recursive: true });
    await context.storageState({ path: this.config.storageStatePath });
  }

  private async extractReceivedOfficeMemosPage(page: Page): Promise<RawReceivedOfficeMemosPage> {
    return page.evaluate<RawReceivedOfficeMemosPage>(() => {
      const cards = [...document.querySelectorAll("#commonViewReceivedTitles > div.card.mb-3.flex-row")];
      const items: RawReceivedOfficeMemo[] = [];

      for (const card of cards) {
        const titleLink = card.querySelector<HTMLAnchorElement>("h5.card-title a.no-underline");
        const title = titleLink?.textContent?.trim() ?? "";
        const href = titleLink?.getAttribute("href") ?? "";

        let officeMemoId = "";
        if (href) {
          try {
            officeMemoId = new URL(href, window.location.href).searchParams.get("officememoid") ?? "";
          } catch {
            officeMemoId = "";
          }
        }

        if (!officeMemoId) {
          officeMemoId = card.querySelector<HTMLInputElement>("input.bulk_operations")?.id?.trim() ?? "";
        }

        const date = card.querySelector<HTMLElement>("p.card-text span.ms-auto")?.textContent?.trim() ?? "";

        const categoryElement = card.querySelector<HTMLElement>("p.card-text .bi-tag")?.parentElement;
        const category = categoryElement?.querySelector<HTMLElement>("span")?.textContent?.trim() ?? "---";

        const badgeTexts = [...card.querySelectorAll<HTMLElement>(".position-absolute span.badge")]
          .map((element) => (element.textContent ?? "").replace(/\s+/g, ""))
          .filter((text) => text.length > 0);

        const isBookmarked = Boolean(card.querySelector("i.bi-star-fill"));
        const isReviewNeeded = badgeTexts.some((text) => text.includes("要確認"));
        const isUnread = badgeTexts.some((text) => text.includes("未読"));
        const isUpdated = badgeTexts.some((text) => text.includes("更新あり"));
        const isImportant = [...card.querySelectorAll("p.card-text span")].some((element) =>
          (element.textContent ?? "").replace(/\s+/g, "").includes("重要"),
        );

        if (!title || !officeMemoId || !date) {
          continue;
        }

        items.push({
          title,
          officeMemoId,
          category,
          date,
          isBookmarked,
          isReviewNeeded,
          isUnread,
          isUpdated,
          isImportant,
        });
      }

      const lastPageControl =
        document.querySelector<HTMLElement>("ul.pagination li:last-child .page-link") ??
        document.querySelector<HTMLElement>(".pagination .bi-chevron-double-right")?.closest(".page-link");
      const isLastPage = !lastPageControl || lastPageControl.classList.contains("disabled");

      return {
        items,
        isLastPage,
      };
    });
  }

  private async extractUnsubmittedReports(page: Page): Promise<UnsubmittedReport[]> {
    const rawItems = await page.evaluate<RawUnsubmittedReport[]>(() => {
      const sections = [...document.querySelectorAll("section")];
      const section = sections.find((item) => {
        const title = item.querySelector("h4")?.textContent ?? "";
        return title.includes("未提出レポート一覧");
      });
      if (!section) {
        return [];
      }

      const rows = [...section.querySelectorAll("table tbody tr")];
      return rows.map((row) => {
        const tds = [...row.querySelectorAll("td")];
        const reportLink = tds[1]?.querySelector("a") ?? null;
        const href = reportLink?.getAttribute("href") ?? "";

        let formName = "";
        if (href.startsWith("javascript:") && href.endsWith(".submit()")) {
          formName = href.slice("javascript:".length, -".submit()".length).trim();
        }

        const form = (formName ? document.forms.namedItem(formName) : null) ?? row.querySelector("form");
        const courseId =
          row.querySelector("input[name='courseId']")?.getAttribute("value") ??
          form?.querySelector("input[name='courseId']")?.getAttribute("value") ??
          "";
        const lectureId =
          row.querySelector("input[name='lectureId']")?.getAttribute("value") ??
          form?.querySelector("input[name='lectureId']")?.getAttribute("value") ??
          "";

        return {
          course_name: tds[0]?.textContent?.trim() ?? "",
          report_name: reportLink?.textContent?.trim() ?? "",
          start_at: tds[2]?.textContent?.trim() ?? "",
          end_at: tds[3]?.textContent?.trim() ?? "",
          courseId,
          lectureId,
        };
      });
    });

    return rawItems
      .filter((item) => item.course_name && item.report_name && item.start_at && item.end_at)
      .map((item) => {
        const startAt = parsePortalDateTime(item.start_at);
        const endAt = parsePortalDateTime(item.end_at, startAt.getFullYear());

        return {
          course_name: item.course_name,
          courseId: item.courseId,
          report_name: item.report_name,
          lectureId: item.lectureId,
          start_at: formatDateTime(startAt),
          end_at: formatDateTime(endAt),
        };
      });
  }

  private async extractReflectionReplies(page: Page): Promise<ReflectionReply[]> {
    const rawItems = await page.evaluate<RawReflectionReply[]>(() => {
      const sections = [...document.querySelectorAll("section")];
      const section = sections.find((item) => {
        const title = item.querySelector("h4")?.textContent ?? "";
        return title.includes("新着の振り返り返信");
      });
      if (!section) {
        return [];
      }

      const headers = [...section.querySelectorAll("h3.fs-5")];
      return headers.map((header) => {
        const headerText = header.textContent?.trim() ?? "";
        const splitAt = headerText.indexOf(" - ");
        const date = splitAt >= 0 ? headerText.slice(0, splitAt).trim() : "";
        const courseName = splitAt >= 0 ? headerText.slice(splitAt + 3).trim() : "";

        let form: HTMLFormElement | null = null;
        let node = header.nextElementSibling;
        while (node && !form) {
          form = node.querySelector("form");
          node = node.nextElementSibling;
        }

        const courseId = form?.querySelector("input[name='courseId']")?.getAttribute("value") ?? "";
        const lectureId = form?.querySelector("input[name='lectureId']")?.getAttribute("value") ?? "";
        const reportName = form?.querySelector("a span")?.textContent?.trim() ?? "";

        return {
          date,
          course_name: courseName,
          courseId,
          report_name: reportName,
          lectureId,
        };
      });
    });

    return rawItems
      .filter((item) => item.date && item.course_name && item.report_name)
      .map((item) => {
        const [year, month, day] = item.date.split("-").map((part) => Number.parseInt(part, 10));
        const date = new Date(year, month - 1, day, 0, 0, 0, 0);

        return {
          date: formatDateTime(date),
          course_name: item.course_name,
          courseId: item.courseId,
          report_name: item.report_name,
          lectureId: item.lectureId,
        };
      });
  }

  private async extractTimetable(page: Page): Promise<TimetableEntry[]> {
    const headerDate = await this.getCurrentPortalDate(page);
    const sunday = addDays(headerDate, -headerDate.getDay());

    const rawItems = await page.evaluate<RawTimetableEntry[]>(() => {
      const sections = [...document.querySelectorAll("section")];
      const section = sections.find((item) => {
        const title = item.querySelector("h4")?.textContent ?? "";
        return title.includes("今週の時間割");
      });
      if (!section) {
        return [];
      }

      const rows = [...section.querySelectorAll("table.timetable tbody tr")];
      const results: RawTimetableEntry[] = [];

      for (const row of rows) {
        const cells = [...row.querySelectorAll("td")];
        if (!cells.length) {
          continue;
        }

        const period = Number.parseInt((cells[0]?.textContent ?? "").trim(), 10);
        if (!Number.isInteger(period)) {
          continue;
        }

        for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
          const cell = cells[dayIndex + 1];
          if (!cell) {
            continue;
          }

          const cards = [...cell.querySelectorAll("div.card-text")];
          for (const card of cards) {
            const form = card.querySelector("form");
            const courseName = form?.querySelector("button")?.textContent?.trim() ?? "";
            const courseId = form?.querySelector("input[name='courseId']")?.getAttribute("value") ?? "";
            const roomRaw = card.querySelector("span")?.textContent?.trim() ?? "";

            if (!courseName || !courseId) {
              continue;
            }

            const classroom = roomRaw.replace(/^\[/, "").replace(/]$/, "");
            results.push({
              day_index: dayIndex,
              period,
              classroom,
              course_name: courseName,
              courseId,
            });
          }
        }
      }

      return results;
    });

    return rawItems
      .map((item) => {
        const date = addDays(sunday, item.day_index);
        return {
          classroom: item.classroom,
          course_name: item.course_name,
          courseId: item.courseId,
          datetime: formatDate(date),
          period: item.period,
        };
      })
      .sort((a, b) => {
        if (a.datetime !== b.datetime) {
          return a.datetime.localeCompare(b.datetime);
        }
        if (a.period !== b.period) {
          return a.period - b.period;
        }
        return a.course_name.localeCompare(b.course_name);
      });
  }

  private async getCurrentPortalDate(page: Page): Promise<Date> {
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

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private get targetUrl(): string {
    return `${this.config.portalUrl}/portal/MyPage`;
  }

  private get loginUrl(): string {
    return `${this.config.portalUrl}/portal`;
  }
}
