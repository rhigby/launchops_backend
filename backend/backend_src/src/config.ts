import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  auth0Domain: required("AUTH0_DOMAIN"),
  auth0Audience: required("AUTH0_AUDIENCE"),
  // Render Postgres connection string
  // Prefer Render's INTERNAL DATABASE_URL for backend-to-db traffic.
  databaseUrl: required("DATABASE_URL"),
  rateLimitPoints: Number(process.env.RATE_LIMIT_POINTS || 60),
  rateLimitDurationSeconds: Number(process.env.RATE_LIMIT_DURATION_SECONDS || 60),
} as const;
