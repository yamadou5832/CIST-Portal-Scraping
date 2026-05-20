import { promises as fs } from "node:fs";
import path from "node:path";
import { Browser, chromium, type BrowserContext, type Page } from "playwright";

import type { AppConfig } from "./config.js";
import {
  type CourseLectureDetail,
  type CourseSummary,
  type DistributionPdfGroup,
  type DistributionPdfItem,
  type FetchReceivedOfficeMemosOptions,
  type LectureSessionDetail,
  type MyPageData,
  type MyPageNewInformationSummary,
  type MonthlySchedule,
  type MonthlyScheduleEvent,
  type OfficeMemoAttachment,
  type OfficeMemoFilter,
  type PendingAppointmentSummary,
  type ReceivedOfficeMemoDetail,
  type ReceivedOfficeMemo,
  type ReflectionReply,
  type TimetableEntry,
  type UndoneQuestionnaire,
  type UnsubmittedReport,
  type UnsubmittedReportSummary,
  type PaginatedReceivedOfficeMemos,
  OFFICE_MEMO_PORTAL_PAGE_SIZE,
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
    return this.withAuthenticatedPage((page) => this.extractMyPageNewInformationSummary(page));
  }

  async fetchUnsubmittedReportSummary(): Promise<UnsubmittedReportSummary> {
    return this.withAuthenticatedPage((page) => this.extractUnsubmittedReportSummary(page));
  }

  async fetchMyPageSummaries(): Promise<Pick<MyPageData, "new_information" | "unsubmitted_report_summary">> {
    return this.withAuthenticatedPage(async (page) => {
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
    return this.withAuthenticatedPage((page) => this.extractUnsubmittedReports(page));
  }

  async fetchReflectionReplies(): Promise<ReflectionReply[]> {
    return this.withAuthenticatedPage((page) => this.extractReflectionReplies(page));
  }

  async fetchTimetable(): Promise<TimetableEntry[]> {
    return this.withAuthenticatedPage((page) => this.extractTimetable(page));
  }

  async fetchReceivedOfficeMemos(options: FetchReceivedOfficeMemosOptions = {}): Promise<PaginatedReceivedOfficeMemos> {
    const filter = options.filter ?? "all";
    const searchKeyword = options.searchKeyword ?? "";
    const categoryFilter = options.categoryFilter ?? "c_all";
    const pageOption = options.page;

    return this.withAuthenticatedPage(async (page) => {
      const referenceDate = await this.getCurrentPortalDate(page);
      const items: ReceivedOfficeMemo[] = [];
      const seenIds = new Set<string>();

      if (pageOption !== undefined) {
        const currentPage = Math.max(1, pageOption);
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

        return {
          items,
          pagination: {
            page: currentPage,
            limit: OFFICE_MEMO_PORTAL_PAGE_SIZE,
            hasNextPage: !isLastPage,
            hasPreviousPage: currentPage > 1,
          },
        };
      } else {
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

        return {
          items,
          pagination: {
            page: 1,
            limit: items.length,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        };
      }
    });
  }

  async fetchReceivedOfficeMemoDetails(options: FetchReceivedOfficeMemosOptions = {}): Promise<ReceivedOfficeMemoDetail[]> {
    const { items } = await this.fetchReceivedOfficeMemos(options);
    return this.withAuthenticatedPage(async (page) => {
      const details: ReceivedOfficeMemoDetail[] = [];
      for (const item of items) {
        const detailUrl = new URL(`${this.config.portalUrl}/portal/OfficeMemo/ViewMemo`);
        detailUrl.searchParams.set("officememoid", item.officeMemoId);
        await page.goto(detailUrl.toString(), { waitUntil: "domcontentloaded" });

        const parsed = await page.evaluate<{
          author: string;
          body: string;
          postedText: string;
          expiresText: string;
          attachments: OfficeMemoAttachment[];
        }>(String.raw`(() => {
          const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
          const attachments = [...document.querySelectorAll("a.filename, a[href*='/OfficeMemo/OfficeMemo/download']")]
            .map((element) => ({
              name: normalize(element.textContent),
              url: element.getAttribute("href") ?? "",
            }))
            .filter((attachment) => attachment.name && attachment.url);

          const bodyContainer =
            document.querySelector(".main-contents") ??
            document.querySelector("main") ??
            document.body;
          const bodyTextRaw = normalize(bodyContainer?.textContent);
          const bodyText = normalize(bodyTextRaw.replace(/戻る|前へ|次へ|ブックマーク|要確認|未読|更新あり/g, " "));

          const postedRegex = /(\d{4}\/\d{2}\/\d{2}(?:[（(][^)）]+[)）])?\s*\d{2}:\d{2})\s*に掲示/;
          const expiresRegex = /(\d{4}\/\d{2}\/\d{2}(?:[（(][^)）]+[)）])?\s*\d{2}:\d{2})\s*まで掲示/;
          const postedText = (bodyText.match(postedRegex) ?? [])[1] ?? "";
          const expiresText = (bodyText.match(expiresRegex) ?? [])[1] ?? "";

          let author = normalize(
            document.querySelector(".main-head .name, .main-head .badge + span, .bi-person, .bi-person-fill")
              ?.parentElement?.textContent,
          );
          if (!author) {
            const metaLine = normalize(
              [...document.querySelectorAll(".main-head, .card-header, .memo-header, p, div")]
                .map((element) => element.textContent ?? "")
                .find((text) => text.includes("に掲示") && text.includes("まで掲示")) ?? "",
            );
            const authorCandidate = metaLine
              .replace(postedRegex, "")
              .replace(expiresRegex, "")
              .replace(/に掲示|まで掲示|[-|｜]/g, " ");
            author = normalize(authorCandidate);
          }
          const bodyAuthor =
            (bodyText.match(/重要\s+(.+?)\s+[^\s]+\s+に登録する/) ?? [])[1] ??
            (bodyText.match(/重要\s+(.+?)\s+[^\s]+\s+ブックマーク/) ?? [])[1] ??
            "";
          if (bodyAuthor) {
            author = normalize(bodyAuthor);
          }
          author = author.replace(/戻る|前へ|次へ|連絡掲示|受信|送信|掲示履歴|掲示を新規作成|連絡掲示の閲覧/g, "").trim();

          return {
            author,
            body: bodyText,
            postedText,
            expiresText,
            attachments,
          };
        })()`);

        let postedAt: string | null = null;
        let expiresAt: string | null = null;
        if (parsed.postedText) {
          try {
            postedAt = formatDateTime(parsePortalDateTime(parsed.postedText));
          } catch {
            postedAt = null;
          }
        }
        if (parsed.expiresText) {
          try {
            expiresAt = formatDateTime(parsePortalDateTime(parsed.expiresText));
          } catch {
            expiresAt = null;
          }
        }

        details.push({
          ...item,
          author: parsed.author,
          body: parsed.body,
          posted_at: postedAt,
          expires_at: expiresAt,
          attachments: parsed.attachments.map((attachment) => ({
            ...attachment,
            url: new URL(attachment.url, this.config.portalUrl).toString(),
          })),
        });
      }
      return details;
    });
  }

  async fetchReceivedOfficeMemoDetail(officeMemoId: string): Promise<ReceivedOfficeMemoDetail> {
    const { items } = await this.fetchReceivedOfficeMemos({ filter: "all" });
    const target = items.find((item) => item.officeMemoId === officeMemoId);
    if (!target) {
      throw new Error(`officeMemoId not found: ${officeMemoId}`);
    }
    const details = await this.fetchReceivedOfficeMemoDetails({ filter: "all" });
    const detail = details.find((item) => item.officeMemoId === officeMemoId);
    if (!detail) {
      throw new Error(`Failed to fetch detail for officeMemoId: ${officeMemoId}`);
    }
    return detail;
  }

  async fetchMonthlySchedule(): Promise<MonthlySchedule> {
    return this.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.config.portalUrl}/portal/Schedule/MonthlyScheduleViewer`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      return page.evaluate<MonthlySchedule>(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const month = normalize(document.querySelector(".fc-toolbar-title")?.textContent);
        const eventsFromDom = [...document.querySelectorAll(".fc-daygrid-event, .fc-event, .fc-list-event")]
          .map((element) => {
            const dayCell =
              element.closest("[data-date]") ??
              element.closest("tr[data-date]") ??
              element.closest(".fc-daygrid-day");
            const date =
              dayCell?.getAttribute("data-date") ??
              element.getAttribute("data-start") ??
              "";
            const title = normalize(
              element.querySelector(".fc-event-title, .fc-list-event-title, .fc-event-main")?.textContent ??
              element.textContent,
            );
            const cssClass = element.getAttribute("class") ?? "";
            return { date, title, cssClass };
          })
          .filter((event) => event.date && event.title);

        const eventsFromWindow = [];
        const maybeCalendar = window.calendar ?? window._calendar ?? null;
        if (maybeCalendar && typeof maybeCalendar.getEvents === "function") {
          try {
            for (const event of maybeCalendar.getEvents()) {
              const start = event.start ? new Date(event.start) : null;
              const date = start
                ? String(start.getFullYear()) +
                  "-" +
                  String(start.getMonth() + 1).padStart(2, "0") +
                  "-" +
                  String(start.getDate()).padStart(2, "0")
                : "";
              const title = normalize(event.title ?? "");
              if (date && title) {
                eventsFromWindow.push({
                  date,
                  title,
                  cssClass: normalize((event.classNames ?? []).join(" ")),
                });
              }
            }
          } catch {
            // ignore
          }
        }

        const merged = [...eventsFromDom, ...eventsFromWindow];
        const deduped = [];
        const seen = new Set();
        for (const event of merged) {
          const key = event.date + "|" + event.title + "|" + event.cssClass;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          deduped.push(event);
        }

        return { month, events: deduped };
      })()`);
    });
  }

  async fetchCoursesForUser(): Promise<CourseSummary[]> {
    return this.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.config.portalUrl}/portal/Course/CoursesForUser`, { waitUntil: "domcontentloaded" });
      return page.evaluate<CourseSummary[]>(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const rows = [...document.querySelectorAll("table tbody tr")];
        return rows
          .map((row) => {
            const tds = [...row.querySelectorAll("td")];
            const form = row.querySelector("form[action='/portal/Lecture/ViewScheduleOfLectures']");
            const courseId = form?.querySelector("input[name='courseId']")?.getAttribute("value") ?? "";
            const courseName =
              normalize(form?.querySelector("button")?.textContent) ||
              normalize(tds[5]?.textContent);
            return {
              courseId,
              code: normalize(tds[0]?.textContent),
              department: normalize(tds[1]?.textContent),
              grade: normalize(tds[2]?.textContent),
              semester: normalize(tds[3]?.textContent),
              category: normalize(tds[4]?.textContent),
              course_name: courseName,
            };
          })
          .filter((course) => course.courseId && course.course_name);
      })()`);
    });
  }

  async fetchCourseLectureDetails(options: { courseId?: string; session?: number } = {}): Promise<CourseLectureDetail[]> {
    return this.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.config.portalUrl}/portal/Course/CoursesForUser`, { waitUntil: "domcontentloaded" });
      const referenceDate = await this.getCurrentPortalDate(page);
      const forms = await page.evaluate<Array<{ courseId: string; csrf: string }>>(String.raw`(() => {
        const entries = [...document.querySelectorAll("form[action='/portal/Lecture/ViewScheduleOfLectures']")]
          .map((form) => ({
            courseId: form.querySelector("input[name='courseId']")?.getAttribute("value") ?? "",
            csrf: form.querySelector("input[name='_csrf']")?.getAttribute("value") ?? "",
          }))
          .filter((entry) => entry.courseId && entry.csrf);
        const seen = new Set();
        return entries.filter((entry) => {
          if (seen.has(entry.courseId)) return false;
          seen.add(entry.courseId);
          return true;
        });
      })()`);

      const targetForms = options.courseId ? forms.filter((form) => form.courseId === options.courseId) : forms;
      const details: CourseLectureDetail[] = [];
      for (const form of targetForms) {
        const response = await page.context().request.post(
          `${this.config.portalUrl}/portal/Lecture/ViewScheduleOfLectures`,
          {
            form: {
              _csrf: form.csrf,
              courseId: form.courseId,
            },
          },
        );
        const html = await response.text();
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        const parsed = await page.evaluate<{
          course_name: string;
          teacher: string;
          notes: string;
          sessions: LectureSessionDetail[];
        }>(String.raw`(() => {
          const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
          const main = document.querySelector("main") ?? document.body;
          const courseName = normalize(main.querySelector("h2.main-title")?.textContent);
          const mainHeadText = normalize(main.querySelector(".main-head")?.textContent);
          const teacher =
            (mainHeadText.match(/担当[:：]\s*(.+?)\s+コード/) ?? [])[1] ??
            (mainHeadText.match(/担当[:：]\s*(.+)$/) ?? [])[1] ??
            "";
          const notes = normalize(
            [...document.querySelectorAll("section h3")]
              .find((element) => normalize(element.textContent).includes("授業の諸注意"))
              ?.parentElement?.textContent,
          );

          const sessionTitleElements = [...document.querySelectorAll("h3, h4, h5, .card-header, .accordion-button, strong, b")]
            .filter((element) => /^\d+\s*回目の講義$/.test(normalize(element.textContent)));
          const sessionsFromHeadings = sessionTitleElements
            .map((titleElement) => {
              const title = normalize(titleElement.textContent);
              const container =
                titleElement.closest(".card, .accordion-item, .lecture-item, .mb-3, section, li, tr") ??
                titleElement.parentElement ??
                titleElement;
              const body = normalize(container.textContent);
              const scheduleDate = (body.match(/(\d{1,2}\/\d{1,2}(?:[（(][^)）]+[)）])?)/) ?? [])[1] ?? "";
              const period = (body.match(/([0-9]+講時)/) ?? [])[1] ?? "";
              const classroom =
                (body.match(/教室[:：]\s*([^\s]+)/) ?? [])[1] ??
                (body.match(/([A-Z][0-9A-Z() ,]+)\s+授業内容/) ?? [])[1] ??
                "";
              const description = normalize(body.replace(/^.*?授業内容/, "").replace(/出席.*$/, "").trim());
              const attendanceStatus = (body.match(/あなたの出席登録状況：\s*([^\s]+)/) ?? [])[1] ?? "";
              const attachments = [...container.querySelectorAll("a[href*='download'], a.filename[href]")]
                .map((element) => ({
                  name: normalize(element.textContent),
                  url: element.getAttribute("href") ?? "",
                }))
                .filter((attachment) => attachment.name && attachment.url);

              return {
                title,
                schedule_date: scheduleDate,
                period,
                classroom,
                description,
                attendance_status: attendanceStatus,
                attachments,
              };
            })
            .filter((session) => session.title);

          const attachmentGroups = [];
          const attachmentGroupIndex = new Map();
          for (const link of [...document.querySelectorAll("a[href*='lectureId=']")]) {
            const href = link.getAttribute("href") ?? "";
            const lectureId = (href.match(/[?&]lectureId=([^&]+)/) ?? [])[1] ?? "";
            if (!lectureId) {
              continue;
            }
            if (!attachmentGroupIndex.has(lectureId)) {
              attachmentGroupIndex.set(lectureId, attachmentGroups.length);
              attachmentGroups.push([]);
            }
            const idx = attachmentGroupIndex.get(lectureId);
            attachmentGroups[idx].push({
              name: normalize(link.textContent),
              url: href,
            });
          }

          const bodyText = normalize(main.textContent);
          const sessionPattern =
            /(\d+回目の講義)\s+通常授業\s+(\d{1,2}\/\d{1,2}[（(][^)）]+[)）])\s+(\d+講時)\s+([A-Z][0-9A-Z]+)\s+授業内容\s*(.*?)\s+出席\s+あなたの出席登録状況：\s*([^\s]+)/g;
          const sessionsFromBody = [];
          let bodyMatch;
          let bodyIndex = 0;
          while ((bodyMatch = sessionPattern.exec(bodyText)) !== null) {
            const [, title, scheduleDate, period, classroom, descriptionRaw, attendanceStatus] = bodyMatch;
            sessionsFromBody.push({
              title: normalize(title),
              schedule_date: normalize(scheduleDate),
              period: normalize(period),
              classroom: normalize(classroom),
              description: normalize(descriptionRaw),
              attendance_status: normalize(attendanceStatus),
              attachments: (attachmentGroups[bodyIndex] ?? []).filter((attachment) => attachment.name && attachment.url),
            });
            bodyIndex += 1;
          }

          const sessions = sessionsFromHeadings.length > 0 ? sessionsFromHeadings : sessionsFromBody;
          const deduped = [];
          const seen = new Set();
          for (const session of sessions) {
            const key = normalize([session.title, session.schedule_date, session.period, session.classroom].join("|"));
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            deduped.push(session);
          }

          return {
            course_name: courseName,
            teacher,
            notes,
            sessions: deduped,
          };
        })()`);

        const allSessions = parsed.sessions.map((session) => ({
          ...session,
          attachments: session.attachments.map((attachment) => ({
            ...attachment,
            url: new URL(attachment.url, this.config.portalUrl).toString(),
          })),
        }));

        let selectedSessions = allSessions;
        if (typeof options.session === "number" && Number.isInteger(options.session) && options.session > 0) {
          selectedSessions = allSessions.filter((session) => {
            const n = Number.parseInt((session.title.match(/^(\d+)/) ?? [])[1] ?? "", 10);
            return Number.isInteger(n) && n === options.session;
          });
        } else {
          const sessionsWithDate = allSessions
            .map((session) => {
              const text = session.schedule_date.replace(/[（(].*?[)）]/g, "");
              const m = text.match(/^(\d{1,2})\/(\d{1,2})$/);
              if (!m) {
                return null;
              }
              const month = Number.parseInt(m[1], 10);
              const day = Number.parseInt(m[2], 10);
              const candidate = new Date(referenceDate.getFullYear(), month - 1, day);
              if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
                return null;
              }
              return { session, date: candidate };
            })
            .filter((entry): entry is { session: (typeof allSessions)[number]; date: Date } => entry !== null)
            .sort((a, b) => a.date.getTime() - b.date.getTime());

          const next = sessionsWithDate.find((entry) => entry.date.getTime() >= referenceDate.getTime());
          if (next) {
            selectedSessions = [next.session];
          } else {
            const byStatus = allSessions.find((session) => session.attendance_status === "---");
            selectedSessions = byStatus ? [byStatus] : allSessions.slice(0, 1);
          }
        }

        details.push({
          courseId: form.courseId,
          course_name: parsed.course_name,
          teacher: parsed.teacher,
          notes: parsed.notes,
          sessions: selectedSessions,
        });
      }

      return details;
    });
  }

  async fetchDistributionPdfUrls(): Promise<DistributionPdfGroup[]> {
    return this.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.config.portalUrl}/portal/Distribution/DistributionDownloaderPage`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("a.filename").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
      return page.evaluate<DistributionPdfGroup[]>(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const pdfItems = [...document.querySelectorAll("a.filename[href]")]
          .map((element) => ({
            title: normalize(element.textContent),
            url: element.getAttribute("href") ?? "",
            element,
          }))
          .filter((item) => {
            if (!item.title || !item.url) {
              return false;
            }
            try {
              const parsed = new URL(item.url, window.location.href);
              const filepath = parsed.searchParams.get("filepath") ?? "";
              if (filepath.toLowerCase().endsWith(".pdf")) {
                return true;
              }
              return parsed.pathname.toLowerCase().endsWith(".pdf");
            } catch {
              return false;
            }
          });

        const groups = new Map();
        for (const item of pdfItems) {
          let genre = "";
          let node = item.element.parentElement;
          while (node && !genre) {
            const heading = node.querySelector("h1, h2, h3, h4, h5, .card-header, .accordion-button");
            genre = normalize(heading?.textContent);
            node = node.parentElement;
          }
          if (!genre) {
            let prev = item.element.previousElementSibling;
            while (prev && !genre) {
              if (["H1", "H2", "H3", "H4", "H5"].includes(prev.tagName)) {
                genre = normalize(prev.textContent);
                break;
              }
              prev = prev.previousElementSibling;
            }
          }
          const key = genre || "その他";
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key).push({
            title: item.title,
            url: item.url,
          });
        }

        return [...groups.entries()].map(([genre, items]) => ({
          genre,
          items,
        }));
      })()`).then((items) =>
        items.map((group) => ({
          genre: group.genre,
          items: group.items.map((item) => ({
            ...item,
            url: new URL(item.url, this.config.portalUrl).toString(),
          })),
        })),
      );
    });
  }

  async fetchPendingAppointmentsSummary(): Promise<PendingAppointmentSummary> {
    return this.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.config.portalUrl}/portal/Schedule/AppointmentViewer`, { waitUntil: "domcontentloaded" });
      return page.evaluate<PendingAppointmentSummary>(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const section = [...document.querySelectorAll("section")].find((item) =>
          normalize(item.querySelector("h2")?.textContent).includes("あなたへの予約の承諾・拒否"),
        );
        if (!section) {
          return {
            pending_count: 0,
            has_pending_items: false,
          };
        }

        const sectionText = normalize(section.textContent);
        const noData = sectionText.includes("表示するデータがありません");
        if (noData) {
          return {
            pending_count: 0,
            has_pending_items: false,
          };
        }

        const itemCount = section.querySelectorAll("tbody tr").length;
        return {
          pending_count: itemCount,
          has_pending_items: itemCount > 0,
        };
      })()`);
    });
  }

  async fetchUndoneQuestionnaires(): Promise<UndoneQuestionnaire[]> {
    return this.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.config.portalUrl}/portal/Questionnaire/QuestionnairesForYouList?answerStatusFilter=undone`, {
        waitUntil: "domcontentloaded",
      });

      const rawItems = await page.evaluate<
        Array<{
          questionnaireId: string;
          title: string;
          deadlineText: string;
          isClosed: boolean;
          isAnonymous: boolean;
          isRepeatable: boolean;
          category: string;
        }>
      >(String.raw`(() => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const cards = [...document.querySelectorAll(".main-contents .card.mb-3")];
        const items = [];

        for (const card of cards) {
          const form = card.querySelector("form");
          const questionnaireId = normalize(form?.querySelector("input[name='questionnaireId']")?.getAttribute("value"));
          const title =
            normalize(card.querySelector(".card-title h5")?.textContent) ||
            normalize(card.querySelector(".card-title")?.textContent);
          if (!questionnaireId || !title) {
            continue;
          }

          const text = normalize(card.textContent);
          const deadlineText = (text.match(/期限：\s*([0-9]{4}\/[0-9]{2}\/[0-9]{2}[^0-9]*[0-9]{2}:[0-9]{2})/) ?? [])[1] ?? "";
          const isClosed = card.querySelector(".card-body")?.classList.contains("bg-secondary-subtle") ?? false;
          const isAnonymous = text.includes("匿名回答");
          const isRepeatable = text.includes("回答のやり直し可");

          let category = "";
          if (text.includes("授業評価")) {
            category = "授業評価";
          } else if (text.includes("自己分析")) {
            category = "自己分析";
          } else if (text.includes("その他")) {
            category = "その他";
          }

          items.push({
            questionnaireId,
            title,
            deadlineText,
            isClosed,
            isAnonymous,
            isRepeatable,
            category,
          });
        }

        return items;
      })()`);

      return rawItems.map((item) => {
        let deadlineAt: string | null = null;
        if (item.deadlineText) {
          try {
            deadlineAt = formatDateTime(parsePortalDateTime(item.deadlineText));
          } catch {
            deadlineAt = null;
          }
        }

        return {
          questionnaireId: item.questionnaireId,
          title: item.title,
          deadline_at: deadlineAt,
          is_closed: item.isClosed,
          is_anonymous: item.isAnonymous,
          is_repeatable: item.isRepeatable,
          category: item.category,
        };
      });
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
