import type { PortalBrowserSession } from "./browser-session.js";
import type { MonthlySchedule, PendingAppointmentSummary } from "../types.js";

export class ScheduleScraper {
  constructor(
    private readonly session: PortalBrowserSession,
    private readonly portalUrl: string,
  ) {}

  async fetchMonthlySchedule(): Promise<MonthlySchedule> {
    return this.session.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.portalUrl}/portal/Schedule/MonthlyScheduleViewer`, { waitUntil: "domcontentloaded" });
      await page
        .waitForFunction(
          String.raw`() => {
            const maybeCalendar =
              (typeof calendar !== "undefined" ? calendar : null) ??
              window.calendar ??
              window._calendar ??
              null;
            return maybeCalendar && typeof maybeCalendar.getEvents === "function";
          }`,
          null,
          { timeout: 3000 },
        )
        .catch(() => undefined);
      return page.evaluate<MonthlySchedule>(String.raw`(async () => {
        const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        const formatLocalDate = (value) => {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) {
            return "";
          }
          return (
            String(date.getFullYear()) +
            "-" +
            String(date.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(date.getDate()).padStart(2, "0")
          );
        };
        const getDatePart = (value) => {
          if (!value) {
            return "";
          }
          if (typeof value === "string") {
            return (value.match(/^\d{4}-\d{2}-\d{2}/) ?? [])[0] ?? "";
          }
          return formatLocalDate(value);
        };
        const getPeriodLabel = (startStr, endStr) => {
          if (!startStr) {
            return "";
          }

          const extractTime = (isoStr) => isoStr?.split("T")[1]?.substring(0, 5);
          const startTime = extractTime(startStr);
          const endTime = extractTime(endStr);
          if (!startTime || !endTime || (startTime === "00:00" && endTime >= "23:59")) {
            return "";
          }
          const periodTimes = [
            { label: 1, start: "09:00", end: "10:30" },
            { label: 2, start: "10:45", end: "12:15" },
            { label: 3, start: "13:15", end: "14:45" },
            { label: 4, start: "15:00", end: "16:30" },
            { label: 5, start: "16:45", end: "18:15" },
          ];

          let startPeriod = null;
          let endPeriod = null;
          for (const period of periodTimes) {
            if (startTime <= period.start && startPeriod === null) {
              startPeriod = period.label;
            }
            if (endTime >= period.end) {
              endPeriod = period.label;
            }
          }

          if (startPeriod === null || endPeriod === null) {
            const quickMatch = periodTimes.find((period) => period.start === startTime);
            return quickMatch ? "【" + quickMatch.label + "限】" : "";
          }

          return startPeriod === endPeriod
            ? "【" + startPeriod + "限】"
            : "【" + startPeriod + "-" + endPeriod + "限】";
        };
        const month = normalize(document.querySelector(".fc-toolbar-title")?.textContent);
        const getCalendar = () =>
          (typeof calendar !== "undefined" ? calendar : null) ??
          window.calendar ??
          window._calendar ??
          null;
        const buildEvent = (event) => {
          const start = event.startStr || event.start || "";
          const end = event.endStr || event.end || "";
          const date = getDatePart(start);
          const title = normalize(event.title ?? event.schedulename ?? "");
          const id = String(event.id ?? event.scheduleid ?? "");
          const scheduleId = String(event.scheduleid ?? event.extendedProps?.scheduleid ?? id);
          const classNames = Array.isArray(event.classNames) ? event.classNames.join(" ") : "";
          const cssClass = normalize(event.className ?? event.categoryValue ?? classNames);
          if (!date || !title) {
            return null;
          }
          return {
            date,
            title,
            id,
            scheduleId,
            start,
            end,
            periodLabel: getPeriodLabel(start, end),
            cssClass,
          };
        };
        const maybeCalendar = getCalendar();
        const eventsFromApi = [];
        const holidaysFromApi = [];
        if (maybeCalendar?.view?.activeStart && maybeCalendar?.view?.activeEnd) {
          const start = formatLocalDate(maybeCalendar.view.activeStart) + "T00:00:00";
          const endDate = new Date(maybeCalendar.view.activeEnd);
          endDate.setDate(endDate.getDate() - 1);
          const end = formatLocalDate(endDate) + "T23:59:59";
          const params = new URLSearchParams({ start, end });

          try {
            const url = contextPath + "/Schedule/MonthlyScheduleViewer/getEvents?" + params.toString();
            const response = await fetch(url, { headers: { Accept: "application/json" } });
            if (response.ok) {
              const data = await response.json();
              for (const event of Array.isArray(data) ? data : []) {
                const parsed = buildEvent(event);
                if (parsed) {
                  eventsFromApi.push(parsed);
                }
              }
            }
          } catch {
            // fall back to FullCalendar/DOM extraction below
          }

          try {
            const url = contextPath + "/Schedule/MonthlyScheduleViewer/getHoliday?" + params.toString();
            const response = await fetch(url, { headers: { Accept: "application/json" } });
            if (response.ok) {
              const data = await response.json();
              for (const holiday of Array.isArray(data) ? data : []) {
                const parsed = buildEvent({
                  ...holiday,
                  id: holiday.id ?? "",
                  scheduleid: holiday.scheduleid ?? "",
                  className: holiday.className ?? holiday.cssClass ?? "fc-hol",
                });
                if (parsed) {
                  holidaysFromApi.push({
                    ...parsed,
                    id: "",
                    scheduleId: "",
                    periodLabel: "",
                    cssClass: parsed.cssClass || "fc-hol",
                  });
                }
              }
            }
          } catch {
            // holidays are optional; keep regular schedule results if this fails
          }
        }
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
        if (maybeCalendar && typeof maybeCalendar.getEvents === "function") {
          try {
            for (const event of maybeCalendar.getEvents()) {
              const start = event.startStr || (event.start ? event.start.toISOString() : "");
              const end = event.endStr || (event.end ? event.end.toISOString() : "");
              const parsed = buildEvent({
                id: event.id,
                title: event.title,
                start,
                end,
                classNames: event.classNames,
                extendedProps: event.extendedProps,
              });
              if (parsed) {
                eventsFromWindow.push(parsed);
              }
            }
          } catch {
            // ignore
          }
        }

        const scheduleEvents = eventsFromApi.length > 0 ? eventsFromApi : eventsFromWindow.length > 0 ? eventsFromWindow : eventsFromDom;
        const merged = [...scheduleEvents, ...holidaysFromApi];
        const deduped = [];
        const seen = new Set();
        for (const event of merged) {
          const key =
            (event.scheduleId || event.id || "") +
            "|" +
            event.date +
            "|" +
            event.title +
            "|" +
            (event.start || "") +
            "|" +
            event.cssClass;
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

  async fetchPendingAppointmentsSummary(): Promise<PendingAppointmentSummary> {
    return this.session.withAuthenticatedPage(async (page) => {
      await page.goto(`${this.portalUrl}/portal/Schedule/AppointmentViewer`, { waitUntil: "domcontentloaded" });
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
}
