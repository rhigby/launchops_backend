import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { config } from "./config.js";
import { auth0JwtVerifier } from "./auth.js";
import type { AuthUser } from "./types.js";
import { pool } from "./db.js";

const limiter = new RateLimiterMemory({
  points: config.rateLimitPoints,
  duration: config.rateLimitDurationSeconds
});

const issuer = `https://${config.auth0Domain}/`;
const verify = auth0JwtVerifier({ issuer, audience: config.auth0Audience });

export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    await limiter.consume(req.ip || "unknown");
    next();
  } catch {
    res.status(429).json({ error: "rate_limited" });
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    req.user = (await verify(token)) as AuthUser;

    // Keep user profile normalized WITHOUT overwriting a good display_name with a raw sub.
    // (A lot of access tokens only contain {sub}, so displayNameFromUser() would fall back to sub.)
    await upsertUserFromAuth(req.user);

    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

function toHandle(label: string) {
  const h = (label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return h.slice(0, 32);
}

function displayNameFromUser(u: AuthUser): string {
  // Prefer human-friendly fields; fall back to email; last resort is sub.
  return (
    (typeof u.name === "string" && u.name) ||
    (typeof u.nickname === "string" && u.nickname) ||
    (typeof u.preferred_username === "string" && u.preferred_username) ||
    (typeof u.email === "string" && u.email) ||
    u.sub
  );
}

async function upsertUserFromAuth(u: AuthUser) {
  const displayName = displayNameFromUser(u);
  const handle = toHandle(displayName) || toHandle(u.sub);

  // If the token doesn't include profile fields, displayName === sub.
  // Do NOT overwrite an existing non-sub display_name with the sub.
  const displayNameIsSub = displayName === u.sub;

  await pool.query(
    `INSERT INTO users (user_sub, email, display_name, picture_url, handle, last_seen, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (user_sub) DO UPDATE SET
       email = EXCLUDED.email,
       picture_url = COALESCE(EXCLUDED.picture_url, users.picture_url),
       handle = COALESCE(EXCLUDED.handle, users.handle),
       last_seen = now(),
       updated_at = now(),
       display_name = CASE
         WHEN $6 THEN users.display_name
         WHEN users.display_name = users.user_sub THEN EXCLUDED.display_name
         ELSE users.display_name
       END`,
    [
      u.sub,
      typeof u.email === "string" ? u.email : null,
      displayName,
      typeof u.picture === "string" ? u.picture : null,
      handle || null,
      displayNameIsSub
    ]
  );
}
