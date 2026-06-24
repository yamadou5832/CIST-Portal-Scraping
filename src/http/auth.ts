import type express from "express";

import { AuthError, type AuthService } from "../auth/auth-service.js";

export interface RequestAuth {
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
}

export type RequestWithAuth = express.Request & { auth?: RequestAuth };

const PUBLIC_ROUTES = new Set([
  "POST /api/auth/register",
  "POST /api/auth/login",
  "POST /api/auth/refresh",
  "POST /api/auth/passkeys/login/options",
  "POST /api/auth/passkeys/login/verify",
]);

export function authMiddleware(authService: AuthService): express.RequestHandler {
  return (req: RequestWithAuth, res, next) => {
    if (req.path === "/health" || PUBLIC_ROUTES.has(`${req.method} ${req.path}`)) {
      next();
      return;
    }

    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }

    const authorization = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) {
      res.status(401).json({ error: "Authorization bearer token is required" });
      return;
    }

    void authService
      .verifyAccessToken(match[1])
      .then((payload) => {
        req.auth = {
          userId: payload.sub,
          username: payload.username,
          email: payload.email,
          isAdmin: payload.isAdmin,
        };
        next();
      })
      .catch(next);
  };
}

export function requireAuth(req: express.Request): RequestAuth {
  const auth = (req as RequestWithAuth).auth;
  if (!auth) {
    throw new AuthError("Authentication required", 401);
  }
  return auth;
}

export function requireAdmin(req: express.Request): RequestAuth {
  const auth = requireAuth(req);
  if (!auth.isAdmin) {
    throw new AuthError("Admin privileges are required", 403);
  }
  return auth;
}
