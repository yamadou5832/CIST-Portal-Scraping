import type { Page } from "playwright";

import type { PortalBrowserSession } from "./browser-session.js";
import { getCurrentPortalDate } from "./current-date.js";
import { addDays, formatDate, formatDateTime, parsePortalDateTime } from "./date-utils.js";
import type {
  MyPageData,
  MyPageNewInformationSummary,
  ReflectionReply,
  TimetableEntry,
  UnsubmittedReport,
  UnsubmittedReportSummary,
} from "../types.js";

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

export class MyPageScraper {
  constructor(private readonly session: PortalBrowserSession) {}

  async fetchMyPageData(): Promise<MyPageData> {
    return this.session.withAuthenticatedPage(async (page) => {
      const [new_information, unsubmitted_report_summary, unsubmitted_reports, new_reflection_replies, timetable] =
        await Promise.all([
          this.extractMyPageNewInformationSummary(page),
          this.extractUnsubmittedReportSummary(page),
          this.extractUnsubmittedReports(page),
          this.extractReflectionReplies(page),
          this.extractTimetable(page),
        ]);
      return {
        new_information,
        unsubmitted_report_summary,
        unsubmitted_reports,
        new_reflection_replies,
        timetable,
      } as MyPageData;
    });
  }

  async fetchMyPageNewInformationSummary(): Promise<MyPageNewInformationSummary> {
    return this.session.withAuthenticatedPage((page) => this.extractMyPageNewInformationSummary(page));
  }

  async fetchUnsubmittedReportSummary(): Promise<UnsubmittedReportSummary> {
    return this.session.withAuthenticatedPage((page) => this.extractUnsubmittedReportSummary(page));
  }

  async fetchMyPageSummaries(): Promise<Pick<MyPageData, "new_information" | "unsubmitted_report_summary">> {
    return this.session.withAuthenticatedPage(async (page) => {
      const [new_information, unsubmitted_report_summary] = await Promise.all([
        this.extractMyPageNewInformationSummary(page),
        this.extractUnsubmittedReportSummary(page),
      ]);
      return {
        new_information,
        unsubmitted_report_summary,
      };
    });
  }

  async fetchUnsubmittedReports(): Promise<UnsubmittedReport[]> {
    return this.session.withAuthenticatedPage((page) => this.extractUnsubmittedReports(page));
  }

  async fetchReflectionReplies(): Promise<ReflectionReply[]> {
    return this.session.withAuthenticatedPage((page) => this.extractReflectionReplies(page));
  }

  async fetchTimetable(): Promise<TimetableEntry[]> {
    return this.session.withAuthenticatedPage((page) => this.extractTimetable(page));
  }

  private async extractMyPageNewInformationSummary(page: Page): Promise<MyPageNewInformationSummary> {
    return page.evaluate<MyPageNewInformationSummary>(String.raw`(() => {
      const fallback = {
        required_office_memo_count: 0,
        unread_office_memo_count: 0,
        unaccepted_schedule_count: 0,
        unanswered_questionnaire_count: 0,
      };
      const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
      const parseNumber = (value) => {
        const match = normalize(value).match(/\d+/);
        return match ? Number.parseInt(match[0], 10) : 0;
      };

      const sections = [...document.querySelectorAll("section")];
      const section = sections.find((item) => {
        const title = item.querySelector("h4")?.textContent ?? "";
        return title.includes("新着情報");
      });
      if (!section) {
        return fallback;
      }

      const summary = { ...fallback };
      summary.required_office_memo_count = parseNumber(section.querySelector("h5.text-danger span")?.textContent);

      const cards = [...section.querySelectorAll(".card")];
      for (const card of cards) {
        const title = normalize(card.querySelector(".card-title")?.textContent);
        const count = parseNumber(card.querySelector(".card-text span")?.textContent);

        if (title.includes("連絡")) {
          summary.unread_office_memo_count = count;
        } else if (title.includes("予定")) {
          summary.unaccepted_schedule_count = count;
        } else if (title.includes("アンケート")) {
          summary.unanswered_questionnaire_count = count;
        }
      }

      return summary;
    })()`);
  }

  private async extractUnsubmittedReportSummary(page: Page): Promise<UnsubmittedReportSummary> {
    return page.evaluate<UnsubmittedReportSummary>(String.raw`(() => {
      const fallback = {
        due_within_week_count: 0,
        total_count: 0,
      };
      const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
      const parseNumberAfter = (text, pattern) => {
        const match = text.match(pattern);
        return match ? Number.parseInt(match[1], 10) : 0;
      };

      const sections = [...document.querySelectorAll("section")];
      const section = sections.find((item) => {
        const title = item.querySelector("h4")?.textContent ?? "";
        return title.includes("未提出レポート一覧");
      });
      if (!section) {
        return fallback;
      }

      const text = normalize(section.textContent);
      return {
        due_within_week_count: parseNumberAfter(text, /提出期限が1週間以内のレポート：\s*(\d+)\s*件/),
        total_count: parseNumberAfter(text, /未提出レポート\s*(\d+)\s*件/),
      };
    })()`);
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
    const headerDate = await getCurrentPortalDate(page);
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
}
