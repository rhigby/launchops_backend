import { Pool } from "pg";
import { nanoid } from "nanoid";
import { config } from "./config.js";

// -----------------------------------------------------------------------------
// Postgres connection
// -----------------------------------------------------------------------------
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === "production" ? { rejectUnauthorized: false } : undefined,
});

export function nowIso() {
  return new Date().toISOString();
}

// -----------------------------------------------------------------------------
// Schema (idempotent + forwards-compatible)
// -----------------------------------------------------------------------------
export async function migrate() {
  // Keep the existing SQLite-era table names so the frontend doesn't change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_sub TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      picture_url TEXT,
      handle TEXT,
      last_seen TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    -- NOTE: older versions used column name "by" only.
    -- Current code expects: user_sub + by_label.
    CREATE TABLE IF NOT EXISTS incident_updates (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      user_sub TEXT,
      note TEXT NOT NULL,
      by_label TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      by_label TEXT NOT NULL,
      handle TEXT NOT NULL,
      body TEXT NOT NULL,
      page TEXT,
      mentions TEXT[] NOT NULL DEFAULT '{}',
      image_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      content_type TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    CREATE INDEX IF NOT EXISTS idx_updates_incident ON incident_updates(incident_id);
    CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);
    CREATE INDEX IF NOT EXISTS idx_team_messages_created ON team_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_sub);
  `);

  // Forward-compat: if DB was created with old columns, patch it without breaking.
  // (These statements are safe if columns already exist.)
  await pool.query(`ALTER TABLE incident_updates ADD COLUMN IF NOT EXISTS user_sub TEXT;`);
  await pool.query(`ALTER TABLE incident_updates ADD COLUMN IF NOT EXISTS by_label TEXT;`);

  // If an older schema has a "by" column, keep it (do not drop), but optionally backfill by_label.
  // This backfill is safe and idempotent.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='incident_updates' AND column_name='by'
      ) THEN
        UPDATE incident_updates
        SET by_label = COALESCE(by_label, "by")
        WHERE by_label IS NULL;
      END IF;
    END $$;
  `);
}

// -----------------------------------------------------------------------------
// Audit helper
// -----------------------------------------------------------------------------
export async function audit(userSub: string, action: string, entityType: string, entityId: string, meta: any) {
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

  // FIX: use by_label + user_sub (not legacy column "by")
  await pool.query(
    `INSERT INTO incident_updates (id, incident_id, user_sub, note, at, by_label)
     VALUES ($1, $2, $3, $4, NOW(), $5)`,
    [nanoid(), incidentId, userSub, "Added router basename + updated Allowed Web Origins; retesting.", userLabel]
  );

  await audit(userSub, "seed", "system", "seed", { created: true });
}
