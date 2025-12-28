// middleware.ts
import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { config } from "./config.js";
import { auth0JwtVerifier } from "./auth.js";
import { pool } from "./db.js";
import type { AuthUser } from "./auth.js";

const limiter = new RateLimiterMemory({
  points: config.rateLimitPoints,
  duration: config.rateLimitDurationSeconds,
});

const issuer = `https://${config.auth0Domain}/`;
const verify = auth0JwtVerifier({ issuer, audience: config.auth0Audience });

function toHandle(label: string) {
  return (label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function displayNameFromUser(u: AuthUser): string {
  return (
    u.name ||
    u.nickname ||
    u.preferred_username ||
    u.email ||
    u.sub
  );
}

// Optional: allow frontend to provide name/email when token lacks them
function headerOr<T extends string>(v: unknown, fallback: T | null) {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

async function upsertUserFromRequest(req: Request) {
  const u = req.user!;
  const displayName = headerOr(req.header("x-user-name"), null) || displayNameFromUser(u);
  const email = headerOr(req.header("x-user-email"), null) || (u.email ?? null);
  const picture = headerOr(req.header("x-user-picture"), null) || ((u as any).picture ?? null);
  const handle = toHandle(displayName) || toHandle(u.sub);

  await pool.query(
    `INSERT INTO users (user_sub, email, display_name, picture_url, handle, last_seen, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (user_sub) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       picture_url = EXCLUDED.picture_url,
       handle = EXCLUDED.handle,
       last_seen = now(),
       updated_at = now()`,
    [u.sub, email, displayName, picture, handle]
  );
}

export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    await limiter.consume(req.ip || "unknown");
    next();
  } catch {
    res.status(429).json({ error: "rate_limited" });
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice("Bearer ".length) : "";
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    req.user = (await verify(token)) as AuthUser;

    // 🔥 key change: update users table on every authed request
    await upsertUserFromRequest(req);

    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}
