import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { config } from "./config.js";
import { auth0JwtVerifier } from "./auth.js";
import type { AuthUser } from "./types";
import { pool } from "./db.js";

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
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    // Treat verifier result as AuthUser (your canonical type)
    req.user = (await verify(token)) as AuthUser;

    // Normalize user profile into users table on every authed request
    await upsertUserFromAuth(req.user);

    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

async function upsertUserFromAuth(u: AuthUser) {
  const displayName = displayNameFromUser(u);
  const handle = toHandle(displayName);

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
    [
      u.sub,
      u.email || null,
      displayName,
      u.picture || null,
      handle || null,
    ]
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
    (typeof u.name === "string" && u.name.trim()) ||
    (typeof u.nickname === "string" && u.nickname.trim()) ||
    (typeof u.preferred_username === "string" && u.preferred_username.trim()) ||
    (typeof u.email === "string" && u.email.trim()) ||
    (typeof u.sub === "string" && u.sub.trim()) ||
    "user"
  );
}
