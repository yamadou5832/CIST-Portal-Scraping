import cors from "cors";
import express from "express";

import { AuthError, type AuthService } from "../auth/auth-service.js";
import type { PushService } from "../push/push-service.js";
import type { PushSubscriptionStore } from "../push/subscription-store.js";
import type { PortalScraperService } from "../scraper.js";
import { authMiddleware } from "./auth.js";
import { registerRoutes } from "./routes.js";

export interface CreateAppOptions {
  authService: AuthService;
  corsOrigins: string[];
  pushService?: PushService;
  pushStore?: PushSubscriptionStore;
}

export function createApp(scraper: PortalScraperService, options: CreateAppOptions): express.Express {
  const app = express();

  app.use(
    cors({
      credentials: true,
      origin: (origin, callback) => {
        if (!origin || options.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(null, false);
      },
    }),
  );
  app.use(express.json());
  app.use(authMiddleware(options.authService));

  registerRoutes(app, scraper, options);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    res.status(error instanceof AuthError ? error.status : 500).json({ error: message });
  });

  return app;
}
