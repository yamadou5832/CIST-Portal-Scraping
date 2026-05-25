import express from "express";

import { loadConfig } from "./config.js";
import { PortalScraperService } from "./scraper.js";
import type { OfficeMemoFilter } from "./types.js";

const config = loadConfig();
const scraper = new PortalScraperService(config);

const app = express();
app.use(express.json());

function getQueryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function parseOfficeMemoFilter(value: unknown): OfficeMemoFilter | null {
  const filter = getQueryString(value) ?? "all";
  if (filter === "all" || filter === "unread" || filter === "read" || filter === "star") {
    return filter;
  }
  return null;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/mypage", async (_req, res, next) => {
  try {
    const data = await scraper.fetchMyPageData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/mypage-summaries", async (_req, res, next) => {
  try {
    const data = await scraper.fetchMyPageSummaries();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/mypage-new-information", async (_req, res, next) => {
  try {
    const data = await scraper.fetchMyPageNewInformationSummary();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/unsubmitted-report-summary", async (_req, res, next) => {
  try {
    const data = await scraper.fetchUnsubmittedReportSummary();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/unsubmitted-reports", async (_req, res, next) => {
  try {
    const data = await scraper.fetchUnsubmittedReports();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/reflection-replies", async (_req, res, next) => {
  try {
    const data = await scraper.fetchReflectionReplies();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/timetable", async (_req, res, next) => {
  try {
    const data = await scraper.fetchTimetable();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/received-office-memos", async (req, res, next) => {
  try {
    const filter = parseOfficeMemoFilter(req.query.filter);
    if (!filter) {
      res.status(400).json({ error: "Invalid filter. Expected one of: all, unread, read, star" });
      return;
    }

    const searchKeyword = getQueryString(req.query.searchKeyword) ?? "";
    const categoryFilter = getQueryString(req.query.c_filter) ?? "c_all";

    const pageRaw = getQueryString(req.query.page);
    let page: number | undefined = undefined;
    if (pageRaw !== undefined) {
      page = Number.parseInt(pageRaw, 10);
      if (!Number.isInteger(page) || page < 1) {
        res.status(400).json({ error: "page must be a positive integer" });
        return;
      }
    } else {
      page = 1;
    }

    const data = await scraper.fetchReceivedOfficeMemos({
      filter,
      searchKeyword,
      categoryFilter,
      page,
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/pending-appointments-summary", async (_req, res, next) => {
  try {
    const data = await scraper.fetchPendingAppointmentsSummary();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/monthly-schedule", async (_req, res, next) => {
  try {
    const data = await scraper.fetchMonthlySchedule();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/undone-questionnaires", async (_req, res, next) => {
  try {
    const data = await scraper.fetchUndoneQuestionnaires();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/received-office-memo-details", async (req, res, next) => {
  try {
    const officeMemoId = getQueryString(req.query.officeMemoId);
    if (!officeMemoId) {
      res.status(400).json({ error: "officeMemoId is required" });
      return;
    }
    const data = await scraper.fetchReceivedOfficeMemoDetail(officeMemoId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/courses-for-user", async (_req, res, next) => {
  try {
    const data = await scraper.fetchCoursesForUser();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/course-lecture-details", async (req, res, next) => {
  try {
    const courseId = getQueryString(req.query.courseId);
    const sessionRaw = getQueryString(req.query.session);
    const session = sessionRaw ? Number.parseInt(sessionRaw, 10) : undefined;
    if (sessionRaw && (!Number.isInteger(session) || (session ?? 0) < 1)) {
      res.status(400).json({ error: "session must be a positive integer" });
      return;
    }
    const data = await scraper.fetchCourseLectureDetails({
      courseId,
      session,
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/course-lecture-attendance", async (req, res, next) => {
  try {
    const lectureId = typeof req.body?.lectureId === "string" ? req.body.lectureId : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!lectureId.trim() || !password.trim()) {
      res.status(400).json({ error: "lectureId and password are required" });
      return;
    }

    const data = await scraper.registerCourseLectureAttendance({ lectureId, password });
    res.status(data.success ? 200 : 400).json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/distribution-pdf-urls", async (_req, res, next) => {
  try {
    const data = await scraper.fetchDistributionPdfUrls();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal Server Error";
  res.status(500).json({ error: message });
});

const server = app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    await scraper.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
