import express from "express";

import { loadConfig } from "./config.js";
import { PortalScraperService } from "./scraper.js";

const config = loadConfig();
const scraper = new PortalScraperService(config);

const app = express();
app.use(express.json());

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
