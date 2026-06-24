import type { PortalBrowserSession } from "./browser-session.js";
import { getCurrentPortalDate } from "./current-date.js";
import type {
  CourseLectureAttendanceResult,
  CourseLectureDetail,
  CourseSummary,
  LectureSessionDetail,
} from "../types.js";

export class CourseScraper {
  constructor(
    private readonly session: PortalBrowserSession,
    private readonly portalUrl: string,
  ) {}

  async fetchCoursesForUser(): Promise<CourseSummary[]> {
    return this.session.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.portalUrl}/portal/Course/CoursesForUser`, { waitUntil: "domcontentloaded" });
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
    return this.session.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.portalUrl}/portal/Course/CoursesForUser`, { waitUntil: "domcontentloaded" });
      const referenceDate = await getCurrentPortalDate(page);
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
          `${this.portalUrl}/portal/Lecture/ViewScheduleOfLectures`,
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
          const normalizeMultiline = (value) =>
            (value ?? "")
              .replace(/\r/g, "")
              .split("\n")
              .map((line) => line.replace(/\s+/g, " ").trim())
              .filter(Boolean)
              .join("\n");
          const emptyAttendanceRegistration = (lectureId = "") => ({
            available: false,
            lectureId,
            passwordInputId: "",
            passwordInputName: "",
            submitAction: "",
            submitButtonText: "",
            submitDisabled: false,
          });
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

          const sessionsFromLectureItems = [...document.querySelectorAll(".lecture-item[data-lecture-id], .lecture-item[id]")]
            .map((container) => {
              const headerText = normalize(container.querySelector(":scope > .card-header")?.textContent);
              const headerMatch =
                headerText.match(/^(\d+\s*回目の講義)(?:\s+通常授業)?\s+(\d{1,2}\/\d{1,2}(?:[（(][^)）]+[)）])?)\s+(\d+講時)\s+(.+)$/) ??
                [];
              const lectureId = normalize(container.getAttribute("data-lecture-id") ?? container.id);
              const title = normalize(headerMatch[1] ?? headerText.match(/^\d+\s*回目の講義/)?.[0] ?? headerText);
              const scheduleDate = normalize(headerMatch[2] ?? "");
              const period = normalize(headerMatch[3] ?? "");
              const classroom = normalize(headerMatch[4] ?? "");

              const sectionCards = [...container.querySelectorAll(".card")].filter((card) => card !== container);
              const findSection = (label) =>
                sectionCards.find((card) => normalize(card.querySelector(":scope > .card-header")?.textContent).includes(label));
              const contentSection = findSection("授業内容");
              const attachmentSection = findSection("添付資料");
              const attendanceSection = findSection("出席");
              const description = normalizeMultiline(
                contentSection?.querySelector(":scope > .card-body")?.innerText ??
                contentSection?.querySelector(":scope > .card-body")?.textContent ??
                "",
              );
              const attendanceStatus = normalize(
                attendanceSection?.querySelector("[id^='attendanceResult_']")?.textContent ??
                (normalize(attendanceSection?.textContent).match(/あなたの出席登録状況：\s*([^\s]+)/) ?? [])[1] ??
                "",
              );
              const passwordInput = attendanceSection?.querySelector("input[type='password'], input[id^='password_']");
              const submitButton = [...(attendanceSection?.querySelectorAll("button") ?? [])].find((button) =>
                (button.getAttribute("onclick") ?? "").includes("attendanceClick"),
              );
              const submitAction = submitButton?.getAttribute("onclick") ?? "";
              const attendanceRegistration = passwordInput || submitButton
                ? {
                    available: true,
                    lectureId,
                    passwordInputId: passwordInput?.getAttribute("id") ?? "",
                    passwordInputName: passwordInput?.getAttribute("name") ?? "",
                    submitAction,
                    submitButtonText: normalize(submitButton?.textContent),
                    submitDisabled: submitButton?.hasAttribute("disabled") ?? false,
                  }
                : emptyAttendanceRegistration(lectureId);
              const attachments = [...(attachmentSection?.querySelectorAll("a[href*='download'], a.filename[href]") ?? [])]
                .map((element) => ({
                  name: normalize(element.textContent),
                  url: element.getAttribute("href") ?? "",
                }))
                .filter((attachment) => attachment.name && attachment.url);

              return {
                lectureId,
                title,
                schedule_date: scheduleDate,
                period,
                classroom,
                description,
                attendance_status: attendanceStatus,
                attendance_registration: attendanceRegistration,
                attachments,
              };
            })
            .filter((session) => session.title);

          const sessionTitleElements = [...document.querySelectorAll("h3, h4, h5, .card-header, .accordion-button, strong, b")]
            .filter((element) => /^\d+\s*回目の講義$/.test(normalize(element.textContent)));
          const sessionsFromHeadings = sessionTitleElements
            .map((titleElement) => {
              const title = normalize(titleElement.textContent);
              const container =
                titleElement.closest(".card, .accordion-item, .lecture-item, .mb-3, section, li, tr") ??
                titleElement.parentElement ??
                titleElement;
              const lectureId =
                normalize(container.getAttribute("data-lecture-id") ?? container.id) ||
                normalize(container.querySelector("a[href*='lectureId=']")?.getAttribute("href")?.match(/[?&]lectureId=([^&]+)/)?.[1]);
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
                lectureId,
                title,
                schedule_date: scheduleDate,
                period,
                classroom,
                description,
                attendance_status: attendanceStatus,
                attendance_registration: emptyAttendanceRegistration(lectureId),
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
              lectureId: attachmentGroups[bodyIndex]?.[0]?.url.match(/[?&]lectureId=([^&]+)/)?.[1] ?? "",
              title: normalize(title),
              schedule_date: normalize(scheduleDate),
              period: normalize(period),
              classroom: normalize(classroom),
              description: normalize(descriptionRaw),
              attendance_status: normalize(attendanceStatus),
              attendance_registration: emptyAttendanceRegistration(
                attachmentGroups[bodyIndex]?.[0]?.url.match(/[?&]lectureId=([^&]+)/)?.[1] ?? "",
              ),
              attachments: (attachmentGroups[bodyIndex] ?? []).filter((attachment) => attachment.name && attachment.url),
            });
            bodyIndex += 1;
          }

          const sessions =
            sessionsFromLectureItems.length > 0
              ? sessionsFromLectureItems
              : sessionsFromHeadings.length > 0
                ? sessionsFromHeadings
                : sessionsFromBody;
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
            url: new URL(attachment.url, this.portalUrl).toString(),
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

  async registerCourseLectureAttendance(options: { lectureId: string; password: string }): Promise<CourseLectureAttendanceResult> {
    const lectureId = options.lectureId.trim();
    const password = options.password.trim();
    if (!lectureId) {
      throw new Error("lectureId is required");
    }
    if (!password) {
      throw new Error("password is required");
    }

    return this.session.withAuthenticatedPage(async (page) => {
      const csrf = await page.evaluate<{ header: string; token: string }>(String.raw`(() => ({
        header: document.querySelector("meta[name='_csrf_header']")?.getAttribute("content") ?? "",
        token: document.querySelector("meta[name='_csrf']")?.getAttribute("content") ?? "",
      }))()`);
      if (!csrf.header || !csrf.token) {
        throw new Error("Failed to resolve CSRF token");
      }

      const response = await page.context().request.post(
        `${this.portalUrl}/portal/Lecture/ViewScheduleOfLectures/saveAttendance`,
        {
          form: {
            lectureId,
            password,
          },
          headers: {
            [csrf.header]: csrf.token,
            Accept: "application/json",
          },
        },
      );

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        raw = await response.text();
      }

      if (!response.ok()) {
        throw new Error(`Attendance registration failed: ${response.status()}`);
      }

      const records = Array.isArray(raw) ? raw : [];
      const errorMessage = records.map((record) => record?.restControllerErrorMessage ?? "").join("");
      const infoMessage = records.map((record) => record?.restControllerInfoMessage ?? "").join("");
      return {
        success: !errorMessage,
        message: errorMessage || infoMessage,
        raw,
      };
    });
  }
}
