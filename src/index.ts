import { Hono } from "hono";

import { PortalScraperService } from "./scraper";
import type { AppEnv, OfficeMemoFilter } from "./types";

const app = new Hono<{ Bindings: AppEnv }>();

function parseOfficeMemoFilter(value: string | undefined): OfficeMemoFilter | null {
  const filter = value ?? "all";
  if (filter === "all" || filter === "unread" || filter === "read" || filter === "star") {
    return filter;
  }
  return null;
}

app.get("/health", (c) => c.json({ ok: true }));

app.get("/api/mypage", async (c) => {
  const scraper = new PortalScraperService(c.env);
  try {
    return c.json(await scraper.fetchMyPageData());
  } finally {
    await scraper.close();
  }
});

app.get("/api/unsubmitted-reports", async (c) => {
  const scraper = new PortalScraperService(c.env);
  try {
    return c.json(await scraper.fetchUnsubmittedReports());
  } finally {
    await scraper.close();
  }
});

app.get("/api/reflection-replies", async (c) => {
  const scraper = new PortalScraperService(c.env);
  try {
    return c.json(await scraper.fetchReflectionReplies());
  } finally {
    await scraper.close();
  }
});

app.get("/api/timetable", async (c) => {
  const scraper = new PortalScraperService(c.env);
  try {
    return c.json(await scraper.fetchTimetable());
  } finally {
    await scraper.close();
  }
});

app.get("/api/received-office-memos", async (c) => {
  const filter = parseOfficeMemoFilter(c.req.query("filter"));
  if (!filter) {
    return c.json({ error: "Invalid filter. Expected one of: all, unread, read, star" }, 400);
  }

  const scraper = new PortalScraperService(c.env);
  try {
    return c.json(
      await scraper.fetchReceivedOfficeMemos({
        filter,
        searchKeyword: c.req.query("searchKeyword") ?? "",
        categoryFilter: c.req.query("c_filter") ?? "c_all",
      }),
    );
  } finally {
    await scraper.close();
  }
});

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : "Internal Server Error";
  return c.json({ error: message }, 500);
});

export default app;
