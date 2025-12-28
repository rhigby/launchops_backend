import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { config } from "./config.js";
import { auth0JwtVerifier } from "./auth.js";
import { pool } from "./db.js";
import type { AuthUser } from "./types.js";

/* ------------------------------------------------------------------ */
/* Express typing                                                      */
/* ------------------------------------------------------------------ */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */
const limiter = new RateLimiterMemory({
  points: config.rateLimitPoints,
  duration: config.rateLimitDurationSeconds,
});

/* ------------------------------------------------------------------ */
/* Auth0 verifier                                                      */
/* ------------------------------------------------------------------ */
const issuer = `https://${config.auth0Domain}/`;
const verify = auth0JwtVerifier({
  issuer,
  audience: config.auth0Audience,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function displayNameFromUser(u: AuthUser): string {
  return (
    u.name ||
    u.nickname ||
    u.preferred_username ||
    u.email ||
    u.sub
  );
}

function toHandle(label: string) {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */
export async function rateLimit(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    await limiter.consume(req.ip || "unknown");
    next();
  } catch {
    res.status(429).json({ error: "rate_limited" });
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (!token) {
    return res.status(401).json({ error: "missing_token" });
  }

  try {
    const user = await verify(token);
    req.user = user;

    // 🔑 THIS IS THE FIX
    const displayName = displayNameFromUser(user);
    const handle = toHandle(displayName);

    await pool.query(
  `
  INSERT INTO users (user_sub, email, display_name, picture_url, handle, last_seen, updated_at)
  VALUES ($1, $2, $3, $4, $5, now(), now())
  ON CONFLICT (user_sub) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    picture_url = EXCLUDED.picture_url,
    handle = EXCLUDED.handle,
    last_seen = now(),
    updated_at = now()
  `,
  [
    req.user.sub,
    req.user.email ?? null,
    displayNameFromUser(req.user),
    req.user.picture ?? null,
    toHandle(displayNameFromUser(req.user)),
  ]
);

    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ error: "invalid_token" });
  }
}
