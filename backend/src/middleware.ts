import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { config } from "./config.js";
import { auth0JwtVerifier } from "./auth.js";
import { pool } from "./db.js";
import type { AuthUser } from "./types.js";

const limiter = new RateLimiterMemory({
  points: config.rateLimitPoints,
  duration: config.rateLimitDurationSeconds,
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

/**
 * Protects routes and normalizes the authenticated user into `users` table.
 * IMPORTANT: We do NOT overwrite an existing "nice" display_name with a provider sub
 * (like "google-oauth2|...") when tokens are missing profile/email claims.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    const user = (await verify(token)) as AuthUser;
    req.user = user;

    // Best-effort: upsert user profile for friendly names in UI.
    // This runs on every request; it's cheap and keeps last_seen fresh.
    await upsertUserFromClaims(user);

    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

async function upsertUserFromClaims(u: AuthUser) {
  const sub = u.sub || "";
  if (!sub) return;

  const displayName = displayNameFromUser(u); // may be null if token lacks claims
  const handle = displayName ? toHandle(displayName) : null;

  // Only accept displayName if it looks human (avoid overwriting with provider sub)
  const safeDisplay =
    displayName && displayName !== sub && !looksLikeProviderSub(displayName) ? displayName : null;

  // Same idea for handle: only derive from safe display name
  const safeHandle = safeDisplay ? handle : null;

  await pool.query(
    `INSERT INTO users (user_sub, email, display_name, picture_url, handle, last_seen, created_at, updated_at)
     VALUES ($1, $2, COALESCE(NULLIF($3,''), $1), $4, $5, now(), now(), now())
     ON CONFLICT (user_sub) DO UPDATE SET
       email = EXCLUDED.email,
       picture_url = COALESCE(EXCLUDED.picture_url, users.picture_url),
       handle = COALESCE(EXCLUDED.handle, users.handle),
       last_seen = now(),
       updated_at = now(),
       display_name = CASE
         WHEN $3 IS NULL OR $3 = '' THEN users.display_name
         WHEN $3 = users.user_sub OR $3 LIKE '%|%' THEN users.display_name
         ELSE EXCLUDED.display_name
       END`,
    [sub, (u.email as string | undefined) || null, safeDisplay, (u.picture as string | undefined) || null, safeHandle]
  );
}

function looksLikeProviderSub(s: string) {
  // Auth0 sub commonly looks like "google-oauth2|123..." or "auth0|abc..."
  return /.+\|.+/.test(s);
}

function toHandle(label: string) {
  const h = (label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return h.slice(0, 32);
}

/**
 * Return a name from token claims if present; otherwise null (important!)
 * so we don't overwrite an existing user profile with the `sub`.
 */
function displayNameFromUser(u: AuthUser): string | null {
  const name =
    (typeof u.name === "string" && u.name) ||
    (typeof u.nickname === "string" && u.nickname) ||
    (typeof u.preferred_username === "string" && u.preferred_username) ||
    (typeof u.email === "string" && u.email) ||
    "";

  return name.trim() ? name.trim() : null;
}
