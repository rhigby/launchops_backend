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

function toHandle(label: string) {
  const h = (label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return h.slice(0, 32);
}

function displayNameFromUser(u: Partial<AuthUser>): string {
  const full =
    (u.name && String(u.name)) ||
    (u.nickname && String(u.nickname)) ||
    (u.preferred_username && String(u.preferred_username)) ||
    (u.email && String(u.email)) ||
    "";

  return full.trim() || (u.sub ? String(u.sub) : "user");
}

async function fetchUserInfo(accessToken: string): Promise<Partial<AuthUser> | null> {
  try {
    const res = await fetch(`${issuer}userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;

    // Map userinfo fields into AuthUser-ish shape
    return {
      sub: data.sub,
      email: data.email,
      name: data.name,
      nickname: data.nickname,
      preferred_username: data.preferred_username,
      picture: data.picture,
    };
  } catch {
    return null;
  }
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
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    // 1) Verify JWT
    const verified = (await verify(token)) as AuthUser;

    // 2) If missing human fields, fetch /userinfo
    let enriched: Partial<AuthUser> = verified;
    const hasHumanName =
      !!verified.name ||
      !!verified.nickname ||
      !!verified.preferred_username ||
      !!verified.email;

    if (!hasHumanName) {
      const info = await fetchUserInfo(token);
      if (info && info.sub) enriched = { ...verified, ...info };
    }

    req.user = enriched as AuthUser;

    // 3) Upsert into users table
    const displayName = displayNameFromUser(enriched);
    const userSub = verified.sub;
    const handle = toHandle(displayName) || toHandle(userSub);

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
        enriched.sub,
        enriched.email ?? null,
        displayName,
        (enriched as any).picture ?? null,
        handle,
      ]
    );

    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}
