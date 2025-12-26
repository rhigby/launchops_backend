import { Pool } from "pg";
import { nanoid } from "nanoid";
import { config } from "./config.js";

// -----------------------------------------------------------------------------
// Postgres connection
// -----------------------------------------------------------------------------
// NOTE:
// - When using Render's INTERNAL DATABASE_URL, SSL is usually not required.
// - When using an EXTERNAL URL, SSL is typically required.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === "production" ? { rejectUnauthorized: false } : undefined,
});

export function nowIso() {
  return new Date().toISOString();
}

// -----------------------------------------------------------------------------
// Schema (idempotent)
// -----------------------------------------------------------------------------
export async function migrate() {
  // Keep the existing SQLite-era schema names so the frontend doesn't change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklists (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS checklist_steps (
      id TEXT PRIMARY KEY,
      checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      title TEXT NOT NULL,
      severity INT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS incident_updates (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      by TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checklists_user ON checklists(user_sub);
    CREATE INDEX IF NOT EXISTS idx_incidents_user ON incidents(user_sub);
    CREATE INDEX IF NOT EXISTS idx_steps_checklist ON checklist_steps(checklist_id);
    CREATE INDEX IF NOT EXISTS idx_updates_incident ON incident_updates(incident_id);
  `);
}

// -----------------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------------
export async function audit(
  userSub: string,
  action: string,
  entityType: string,
  entityId: string,
  meta: unknown
) {
  await pool.query(
    `INSERT INTO audit_log (id, user_sub, action, entity_type, entity_id, at, meta_json)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
    [nanoid(), userSub, action, entityType, entityId, JSON.stringify(meta ?? {})]
  );
}

// -----------------------------------------------------------------------------
// Seed (only when a user has no checklists yet)
// -----------------------------------------------------------------------------
export async function seedIfEmpty(userSub: string, userLabel: string) {
  const r = await pool.query(`SELECT COUNT(1)::int AS c FROM checklists WHERE user_sub = $1`, [userSub]);
  if ((r.rows?.[0]?.c ?? 0) > 0) return;

  const checklistId = nanoid();
  await pool.query(
    `INSERT INTO checklists (id, user_sub, title, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [checklistId, userSub, "Buffalo Go-Live – Core UI Validation"]
  );

  const steps = [
    "Confirm Auth0 login + role claims",
    "Validate responsive layout on laptop + iPad",
    "Verify WCAG focus states on key flows",
    "Simulate offline / network-loss behavior",
    "Capture screenshots for release notes",
  ];

  for (const label of steps) {
    await pool.query(
      `INSERT INTO checklist_steps (id, checklist_id, label, done, updated_at, updated_by)
       VALUES ($1, $2, $3, FALSE, NOW(), $4)`,
      [nanoid(), checklistId, label, userLabel]
    );
  }

  const incidentId = nanoid();
  await pool.query(
    `INSERT INTO incidents (id, user_sub, title, severity, status, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [incidentId, userSub, "OAuth redirect loop observed on client network", 2, "investigating"]
  );

  await pool.query(
    `INSERT INTO incident_updates (id, incident_id, note, by, at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [nanoid(), incidentId, "Added router basename + updated Allowed Web Origins; retesting.", userLabel]
  );

  await audit(userSub, "seed", "system", "seed", { created: true });
}
