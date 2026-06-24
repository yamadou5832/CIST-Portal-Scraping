import { AuthService } from "./auth/auth-service.js";
import { AuthStore } from "./auth/auth-store.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { ImportantOfficeMemoNotifier } from "./push/important-office-memo-notifier.js";
import { PushService } from "./push/push-service.js";
import { PushSubscriptionStore } from "./push/subscription-store.js";
import { PortalScraperService } from "./scraper.js";

const config = loadConfig();
const authStore = new AuthStore(config.auth.sqlitePath);
const authService = new AuthService(config.auth, authStore);
const scraper = new PortalScraperService(config);
const pushStore = new PushSubscriptionStore(config.push.sqlitePath);
const pushService = new PushService(config.push, pushStore);
const notifier = new ImportantOfficeMemoNotifier(
  scraper,
  authService,
  pushService,
  pushStore,
  config.push.pollIntervalMs,
  config.push.notificationUrl,
);
const app = createApp(scraper, { authService, corsOrigins: config.corsOrigins, pushService, pushStore });

const server = app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  notifier.start();
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  notifier.stop();
  server.close(async () => {
    await scraper.close();
    authStore.close();
    pushStore.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
