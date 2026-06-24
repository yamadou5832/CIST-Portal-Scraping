import type express from "express";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { AuthError, type AuthService } from "../auth/auth-service.js";
import type { PushService } from "../push/push-service.js";
import type { PushSubscriptionStore } from "../push/subscription-store.js";
import type { PortalScraperService } from "../scraper.js";
import { requireAdmin, requireAuth } from "./auth.js";
import { getQueryString, parseOfficeMemoFilter, parsePositiveInteger } from "./request-parsers.js";

type AsyncRouteHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => Promise<void>;

function asyncHandler(handler: AsyncRouteHandler): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export interface RegisterRoutesOptions {
  authService: AuthService;
  pushService?: PushService;
  pushStore?: PushSubscriptionStore;
}

interface ParsedPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function parsePushSubscriptionBody(body: unknown): ParsedPushSubscription | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const subscription = (body as { subscription?: unknown }).subscription;
  if (!subscription || typeof subscription !== "object") {
    return null;
  }

  const candidate = subscription as {
    endpoint?: unknown;
    expirationTime?: unknown;
    keys?: {
      p256dh?: unknown;
      auth?: unknown;
    };
  };

  if (typeof candidate.endpoint !== "string" || !isValidUrl(candidate.endpoint)) {
    return null;
  }

  const expirationTime = candidate.expirationTime;
  if (
    expirationTime !== undefined &&
    expirationTime !== null &&
    (typeof expirationTime !== "number" || !Number.isInteger(expirationTime) || expirationTime < 0)
  ) {
    return null;
  }

  if (
    !candidate.keys ||
    typeof candidate.keys !== "object" ||
    typeof candidate.keys.p256dh !== "string" ||
    !candidate.keys.p256dh.trim() ||
    typeof candidate.keys.auth !== "string" ||
    !candidate.keys.auth.trim()
  ) {
    return null;
  }

  return {
    endpoint: candidate.endpoint,
    expirationTime: expirationTime ?? null,
    keys: {
      p256dh: candidate.keys.p256dh,
      auth: candidate.keys.auth,
    },
  };
}

function parseDeletePushSubscriptionBody(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const endpoint = (body as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== "string" || !isValidUrl(endpoint)) {
    return null;
  }

  return endpoint;
}

function getOptionalBodyString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getRequiredBodyString(body: unknown, key: string): string {
  const value = getOptionalBodyString(body, key);
  if (!value) {
    throw new AuthError(`${key} is required`);
  }
  return value;
}

function getBodyObject(body: unknown, key: string): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new AuthError(`${key} is required`);
  }
  const value = (body as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError(`${key} is required`);
  }
  return value as Record<string, unknown>;
}

function getRequiredParam(req: express.Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new AuthError(`${key} is required`);
  }
  return value;
}

export function registerRoutes(app: express.Express, scraper: PortalScraperService, options: RegisterRoutesOptions): void {
  const authService = options.authService;

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/api/auth/register",
    asyncHandler(async (req, res) => {
      const cistAccount = getBodyObject(req.body, "cistAccount");
      const result = await authService.register({
        inviteCode: getRequiredBodyString(req.body, "inviteCode"),
        username: getRequiredBodyString(req.body, "username"),
        email: getRequiredBodyString(req.body, "email"),
        password: getRequiredBodyString(req.body, "password"),
        cistAccount: {
          userId: getRequiredBodyString(cistAccount, "userId"),
          password: getRequiredBodyString(cistAccount, "password"),
        },
      });
      res.status(201).json(result);
    }),
  );

  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      res.json(await authService.login(getRequiredBodyString(req.body, "identifier"), getRequiredBodyString(req.body, "password")));
    }),
  );

  app.post(
    "/api/auth/refresh",
    asyncHandler(async (req, res) => {
      res.json(await authService.refresh(getRequiredBodyString(req.body, "refreshToken")));
    }),
  );

  app.post(
    "/api/auth/logout",
    asyncHandler(async (req, res) => {
      requireAuth(req);
      authService.logout(getRequiredBodyString(req.body, "refreshToken"));
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/auth/me",
    asyncHandler(async (req, res) => {
      res.json({ user: authService.getPublicUser(requireAuth(req).userId) });
    }),
  );

  app.post(
    "/api/auth/passkeys/register/options",
    asyncHandler(async (req, res) => {
      res.json(await authService.generatePasskeyRegistrationOptions(requireAuth(req).userId));
    }),
  );

  app.post(
    "/api/auth/passkeys/register/verify",
    asyncHandler(async (req, res) => {
      res.json(await authService.verifyPasskeyRegistration(requireAuth(req).userId, req.body as RegistrationResponseJSON));
    }),
  );

  app.delete(
    "/api/auth/passkeys/:credentialId",
    asyncHandler(async (req, res) => {
      authService.deletePasskey(requireAuth(req).userId, getRequiredParam(req, "credentialId"));
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/passkeys/login/options",
    asyncHandler(async (req, res) => {
      res.json(await authService.generatePasskeyLoginOptions(getOptionalBodyString(req.body, "identifier")));
    }),
  );

  app.post(
    "/api/auth/passkeys/login/verify",
    asyncHandler(async (req, res) => {
      res.json(await authService.verifyPasskeyLogin(req.body as AuthenticationResponseJSON));
    }),
  );

  app.post(
    "/api/admin/invites",
    asyncHandler(async (req, res) => {
      const auth = requireAdmin(req);
      const expiresInDaysRaw = req.body && typeof req.body === "object" ? (req.body as { expiresInDays?: unknown }).expiresInDays : undefined;
      if (
        expiresInDaysRaw !== undefined &&
        (typeof expiresInDaysRaw !== "number" || !Number.isInteger(expiresInDaysRaw) || expiresInDaysRaw < 1)
      ) {
        res.status(400).json({ error: "expiresInDays must be a positive integer" });
        return;
      }
      res.status(201).json(authService.createInvite(auth.userId, expiresInDaysRaw as number | undefined));
    }),
  );

  app.get(
    "/api/admin/invites",
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      res.json({ invites: authService.listInvites() });
    }),
  );

  app.delete(
    "/api/admin/invites/:inviteId",
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      authService.revokeInvite(getRequiredParam(req, "inviteId"));
      res.json({ ok: true });
    }),
  );

  app.get("/api/push/vapid-public-key", (_req, res) => {
    if (!options.pushService) {
      res.status(500).json({ error: "Push notification service is not configured" });
      return;
    }

    res.json({ publicKey: options.pushService.getPublicKey() });
  });

  app.post(
    "/api/push/subscriptions",
    asyncHandler(async (req, res) => {
      if (!options.pushStore) {
        res.status(500).json({ error: "Push subscription store is not configured" });
        return;
      }

      const subscription = parsePushSubscriptionBody(req.body);
      if (!subscription) {
        res.status(400).json({ error: "Invalid push subscription" });
        return;
      }

      const result = options.pushStore.upsertSubscription(requireAuth(req).userId, subscription);
      res.status(result.created ? 201 : 200).json({
        ok: true,
        subscriptionId: result.subscription.id,
        message: result.created ? "通知購読を登録しました" : "通知購読を更新しました",
      });
    }),
  );

  app.delete(
    "/api/push/subscriptions",
    asyncHandler(async (req, res) => {
      if (!options.pushStore) {
        res.status(500).json({ error: "Push subscription store is not configured" });
        return;
      }

      const endpoint = parseDeletePushSubscriptionBody(req.body);
      if (!endpoint) {
        res.status(400).json({ error: "endpoint is required" });
        return;
      }

      options.pushStore.deleteSubscriptionByEndpoint(requireAuth(req).userId, endpoint);
      res.json({
        ok: true,
        message: "通知購読を解除しました",
      });
    }),
  );

  app.post(
    "/api/push/test-notification",
    asyncHandler(async (req, res) => {
      if (!options.pushService || !options.pushStore) {
        res.status(500).json({ error: "Push notification service is not configured" });
        return;
      }

      const auth = requireAuth(req);
      const subscriptions = options.pushStore.listSubscriptions(auth.userId);
      const payload = {
        type: "office_memo" as const,
        id: `test-${Date.now()}`,
        title: getOptionalBodyString(req.body, "title") ?? "テスト通知",
        body: getOptionalBodyString(req.body, "body") ?? "CIST Portal Push通知のテストです",
        url: getOptionalBodyString(req.body, "url") ?? "/#memos",
        tag: "office-memo-test",
      };

      await options.pushService.sendToUser(auth.userId, payload);
      res.json({
        ok: true,
        sent: subscriptions.length,
        payload,
        message: subscriptions.length > 0 ? "テスト通知を送信しました" : "登録済みの通知購読がありません",
      });
    }),
  );

  app.get(
    "/api/mypage",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchMyPageData(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/mypage-summaries",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchMyPageSummaries(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/mypage-new-information",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchMyPageNewInformationSummary(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/unsubmitted-report-summary",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchUnsubmittedReportSummary(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/unsubmitted-reports",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchUnsubmittedReports(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/reflection-replies",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchReflectionReplies(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/timetable",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchTimetable(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/received-office-memos",
    asyncHandler(async (req, res) => {
      const filter = parseOfficeMemoFilter(req.query.filter);
      if (!filter) {
        res.status(400).json({ error: "Invalid filter. Expected one of: all, unread, read, star" });
        return;
      }

      const pageRaw = getQueryString(req.query.page);
      const page = pageRaw === undefined ? 1 : parsePositiveInteger(pageRaw);
      if (page === null) {
        res.status(400).json({ error: "page must be a positive integer" });
        return;
      }

      res.json(
        await scraper.fetchReceivedOfficeMemos(authService.getPortalCredentials(requireAuth(req).userId), {
          filter,
          searchKeyword: getQueryString(req.query.searchKeyword) ?? "",
          categoryFilter: getQueryString(req.query.c_filter) ?? "c_all",
          page,
        }),
      );
    }),
  );

  app.get(
    "/api/pending-appointments-summary",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchPendingAppointmentsSummary(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/monthly-schedule",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchMonthlySchedule(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/undone-questionnaires",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchUndoneQuestionnaires(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/received-office-memo-details",
    asyncHandler(async (req, res) => {
      const officeMemoId = getQueryString(req.query.officeMemoId);
      if (!officeMemoId) {
        res.status(400).json({ error: "officeMemoId is required" });
        return;
      }

      res.json(await scraper.fetchReceivedOfficeMemoDetail(authService.getPortalCredentials(requireAuth(req).userId), officeMemoId));
    }),
  );

  app.get(
    "/api/courses-for-user",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchCoursesForUser(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );

  app.get(
    "/api/course-lecture-details",
    asyncHandler(async (req, res) => {
      const sessionRaw = getQueryString(req.query.session);
      const session = sessionRaw === undefined ? undefined : parsePositiveInteger(sessionRaw);
      if (session === null) {
        res.status(400).json({ error: "session must be a positive integer" });
        return;
      }

      res.json(
        await scraper.fetchCourseLectureDetails(authService.getPortalCredentials(requireAuth(req).userId), {
          courseId: getQueryString(req.query.courseId),
          session,
        }),
      );
    }),
  );

  app.post(
    "/api/course-lecture-attendance",
    asyncHandler(async (req, res) => {
      const lectureId = typeof req.body?.lectureId === "string" ? req.body.lectureId : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!lectureId.trim() || !password.trim()) {
        res.status(400).json({ error: "lectureId and password are required" });
        return;
      }

      const data = await scraper.registerCourseLectureAttendance(authService.getPortalCredentials(requireAuth(req).userId), {
        lectureId,
        password,
      });
      res.status(data.success ? 200 : 400).json(data);
    }),
  );

  app.get(
    "/api/distribution-pdf-urls",
    asyncHandler(async (req, res) => {
      res.json(await scraper.fetchDistributionPdfUrls(authService.getPortalCredentials(requireAuth(req).userId)));
    }),
  );
}
