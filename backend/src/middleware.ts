// src/middleware.ts
import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { config } from "./config.js";
import { auth0JwtVerifier } from "./auth.js";

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
  // Let preflight through quickly
  if (req.method === "OPTIONS") return res.sendStatus(204);

  try {
    await limiter.consume(req.ip || "unknown");
    next();
  } catch {
    res.status(429).json({ error: "rate_limited" });
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Browsers send OPTIONS preflight with no auth; don't treat that as a failure.
  if (req.method === "OPTIONS") return res.sendStatus(204);

  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  if (!token) {
    return res.status(401).json({ error: "missing_token" });
  }

  try {
    req.user = await verify(token);
    return next();
  } catch (err: any) {
    // Helpful debugging in non-prod
    if (config.nodeEnv !== "production") {
      console.error("Auth failed:", err?.message || err);
    }
    return res.status(401).json({ error: "invalid_token" });
  }
}
