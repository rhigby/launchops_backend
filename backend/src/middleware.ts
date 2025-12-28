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
const verify = auth0JwtVerifier({
  issuer,
  audience: config.auth0Audience,
});

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
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    const user = (await verify(token)) as AuthUser;
    req.user = user;

    // IMPORTANT: only update the "users" table with meaningful profile data
    await upsertUserProfile(user);

    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

async function upsertUserProfile(u: AuthUser) {
  const sub = u.sub;
  if (!sub) return;

  // What we *wish* we had (may be missing in access tokens)
  const incomingDisplay = displayNameFromUser(u);
  const incomingEmail = typeof u.email === "string" && u.email.trim() ? u.email.trim() : null;
  const incomingPic = typeof u.picture === "string" && u.picture.trim() ? u.picture.trim() : null;

  // If all we have is "sub", do NOT overwrite an existing nice name in DB.
  const incomingMeaningful = !!incomingDisplay && incomingDisplay !== sub;

  const existing = await pool.query(
    `SELECT display_name, email, picture_url, handle
     FROM users
     WHERE user_sub = $1`,
    [sub]
  );

  const existingRow = existing.rows[0] as
    | { display_name: string; email: string | null; picture_url: string | null; handle: string | null }
    | undefined;

  const finalDisplay =
    incomingMeaningful ? incomingDisplay : (existingRow?.display_name || sub);

  const finalEmail = incomingEmail ?? existingRow?.email ?? null;
  const finalPic = incomingPic ?? existingRow?.picture_url ?? null;

  const finalHandle = toHandle(finalDisplay) || existingRow?.handle || toHandle(sub) || sub.slice(0, 32);

  await pool.query(
    `INSERT INTO users (user_sub, email, display_name, picture_url, handle, last_seen, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (user_sub) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       picture_url = COALESCE(EXCLUDED.picture_url, users.picture_url),
       display_name = EXCLUDED.display_name,
       handle = EXCLUDED.handle,
       last_seen = now(),
       updated_at = now()`,
    [sub, finalEmail, finalDisplay, finalPic, finalHandle]
  );
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
  return (
    (typeof u.name === "string" && u.name) ||
    (typeof u.nickname === "string" && u.nickname) ||
    (typeof u.preferred_username === "string" && u.preferred_username) ||
    (typeof u.email === "string" && u.email) ||
    u.sub
  );
}
