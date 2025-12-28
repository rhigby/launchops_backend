// src/routes.ts
import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { audit, nowIso, pool, seedIfEmpty } from "./db.js";
import {
  addIncidentUpdateSchema,
  addStepSchema,
  createChecklistSchema,
  createIncidentSchema,
  patchIncidentStatusSchema,
  sendMessageSchema,
} from "./validators.js";

const userLabel = (req: Request) => req.user?.email || req.user?.name || req.user?.sub || "user";

/**
 * Converts a human label into a stable @handle-friendly string
 */
function toHandle(label: string): string {
  const s = (label || "").trim().toLowerCase();
  if (s.includes("@")) return s.split("@")[0].replace(/[^a-z0-9_.-]/g, "");
  return s.replace(/\s+/g, "").replace(/[^a-z0-9_.-]/g, "").slice(0, 32);
}

/**
 * Extract @mentions from a message body
 */
function extractMentions(body: string): string[] {
  const out: string[] = [];
  const re = /@([a-zA-Z0-9_.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].toLowerCase());
  return Array.from(new Set(out)).slice(0, 20);
}

/**
 * Build a nice display name from Auth0/OIDC claims
 * (This fixes “Cannot find name displayNameFromUser” by defining it here.)
 */
function displayNameFromUser(u: any): string {
  return (
    (typeof u?.name === "string" && u.name) ||
    (typeof u?.nickname === "string" && u.nickname) ||
    (typeof u?.preferred_username === "string" && u.preferred_username) ||
    (typeof u?.email === "string" && u.email) ||
    (typeof u?.given_name === "string" && u.given_name) ||
    (typeof u?.family_name === "string" && u.family_name) ||
    (typeof u?.sub === "string" && u.sub) ||
    "user"
  );
}

export function health(_req: Request, res: Response) {
  res.json({ ok: true, time: new Date().toISOString() });
}

/**
 * me()
 * IMPORTANT: This is where we upsert into `users` and update last_seen.
 * We DO NOT use /presence/ping anymore.
 */
export async function me(req: Request, res: Response) {
  const u = req.user!;
  const displayName = displayNameFromUser(u);
  const handle = toHandle(displayName) || toHandle(u.sub || "user");

  // Upsert user profile + last_seen
  await pool.query(
    `
    INSERT INTO users (user_sub, email, display_name, picture_url, handle, last_seen, updated_at)
    VALUES ($1, $2, $3, $4, $5, now(), now())
    ON CONFLICT (user_sub) DO UPDATE SET
      email = COALESCE(EXCLUDED.email, users.email),
      picture_url = COALESCE(EXCLUDED.picture_url, users.picture_url),
      handle = COALESCE(EXCLUDED.handle, users.handle),
      last_seen = now(),
      updated_at = now(),
      -- only overwrite display_name if it is blank OR still the default sub
      display_name = CASE
        WHEN users.display_name IS NULL
          OR users.display_name = ''
          OR users.display_name = users.user_sub
        THEN EXCLUDED.display_name
        ELSE users.display_name
      END
    `,
    [u.sub, u.email ?? null, displayName, u.picture ?? null, handle]
  );

  res.json({ user: u });
}

// -----------------------------------------------------------------------------
// Checklists
// -----------------------------------------------------------------------------

export async function listChecklists(req: Request, res: Response) {
  const u = req.user!;
  await seedIfEmpty(u.sub, userLabel(req));

  const rows = await pool.query(
    `SELECT id, title, created_at
     FROM checklists
     WHERE user_sub = $1
     ORDER BY created_at DESC`,
    [u.sub]
  );

  const checklists: any[] = [];
  for (const r of rows.rows) {
    const steps = await pool.query(
      `SELECT id, label, done, updated_at, updated_by
       FROM checklist_steps
       WHERE checklist_id = $1
       ORDER BY updated_at ASC, id ASC`,
      [r.id]
    );

    checklists.push({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      steps: steps.rows.map((s) => ({
        id: s.id,
        label: s.label,
        done: !!s.done,
        updatedAt: s.updated_at,
        updatedBy: s.updated_by,
      })),
    });
  }

  res.json(checklists);
}

export async function createChecklist(req: Request, res: Response) {
  const u = req.user!;
  const parsed = createChecklistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const id = nanoid();
  const createdAt = nowIso();

  await pool.query(
    `INSERT INTO checklists (id, user_sub, title, created_at)
     VALUES ($1, $2, $3, $4)`,
    [id, u.sub, parsed.data.title, createdAt]
  );

  await audit(u.sub, "create", "checklist", id, { title: parsed.data.title });
  res.status(201).json({ id, title: parsed.data.title, createdAt, steps: [] });
}

export async function getChecklist(req: Request, res: Response) {
  const u = req.user!;
  const id = req.params.id;

  const c = await pool.query(
    `SELECT id, title, created_at
     FROM checklists
     WHERE user_sub = $1 AND id = $2`,
    [u.sub, id]
  );
  if (c.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const steps = await pool.query(
    `SELECT id, label, done, updated_at, updated_by
     FROM checklist_steps
     WHERE checklist_id = $1
     ORDER BY updated_at ASC, id ASC`,
    [id]
  );

  const row = c.rows[0];
  res.json({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    steps: steps.rows.map((s) => ({
      id: s.id,
      label: s.label,
      done: !!s.done,
      updatedAt: s.updated_at,
      updatedBy: s.updated_by,
    })),
  });
}

export async function addStep(req: Request, res: Response) {
  const u = req.user!;
  const checklistId = req.params.id;

  const exists = await pool.query(`SELECT 1 FROM checklists WHERE user_sub = $1 AND id = $2`, [u.sub, checklistId]);
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const parsed = addStepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const stepId = nanoid();
  const updatedAt = nowIso();
  const updatedBy = userLabel(req);

  await pool.query(
    `INSERT INTO checklist_steps (id, checklist_id, label, done, updated_at, updated_by)
     VALUES ($1, $2, $3, FALSE, $4, $5)`,
    [stepId, checklistId, parsed.data.label, updatedAt, updatedBy]
  );

  await audit(u.sub, "add_step", "checklist", checklistId, { stepId, label: parsed.data.label });
  res.status(201).json({ id: stepId, label: parsed.data.label, done: false, updatedAt, updatedBy });
}

export async function toggleStep(req: Request, res: Response) {
  const u = req.user!;
  const checklistId = req.params.id;
  const stepId = req.params.stepId;

  const exists = await pool.query(`SELECT 1 FROM checklists WHERE user_sub = $1 AND id = $2`, [u.sub, checklistId]);
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const s = await pool.query(`SELECT id, done FROM checklist_steps WHERE checklist_id = $1 AND id = $2`, [
    checklistId,
    stepId,
  ]);
  if (s.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const nextDone = !s.rows[0].done;
  const updatedAt = nowIso();
  const updatedBy = userLabel(req);

  await pool.query(
    `UPDATE checklist_steps
     SET done = $1, updated_at = $2, updated_by = $3
     WHERE id = $4 AND checklist_id = $5`,
    [nextDone, updatedAt, updatedBy, stepId, checklistId]
  );

  await audit(u.sub, "toggle_step", "checklist", checklistId, { stepId, done: nextDone });
  res.json({ ok: true, stepId, done: nextDone, updatedAt, updatedBy });
}

// -----------------------------------------------------------------------------
// Incidents
// -----------------------------------------------------------------------------

export async function listIncidents(req: Request, res: Response) {
  const u = req.user!;
  await seedIfEmpty(u.sub, userLabel(req));

  const incidents = await pool.query(
    `SELECT id, title, severity, status, created_at
     FROM incidents
     WHERE user_sub = $1
     ORDER BY created_at DESC`,
    [u.sub]
  );

  const mapped: any[] = [];
  for (const i of incidents.rows) {
    const updates = await pool.query(
      `SELECT
          iu.id,
          iu.note,
          COALESCE(uu.display_name, iu.by_label) AS "by",
          iu.at
       FROM incident_updates iu
       LEFT JOIN users uu ON uu.user_sub = iu.user_sub
       WHERE iu.incident_id = $1
       ORDER BY iu.at DESC`,
      [i.id]
    );

    mapped.push({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      createdAt: i.created_at,
      updates: updates.rows.map((row) => ({ id: row.id, note: row.note, by: row.by, at: row.at })),
    });
  }

  res.json(mapped);
}

export async function createIncident(req: Request, res: Response) {
  const u = req.user!;
  const parsed = createIncidentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const id = nanoid();
  const createdAt = nowIso();

  await pool.query(
    `INSERT INTO incidents (id, user_sub, title, severity, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, u.sub, parsed.data.title, parsed.data.severity, "open", createdAt]
  );

  await audit(u.sub, "create", "incident", id, { title: parsed.data.title, severity: parsed.data.severity });
  res.status(201).json({ id, title: parsed.data.title, severity: parsed.data.severity, status: "open", createdAt, updates: [] });
}

export async function addIncidentUpdate(req: Request, res: Response) {
  const u = req.user!;
  const incidentId = req.params.id;

  const exists = await pool.query(`SELECT 1 FROM incidents WHERE user_sub = $1 AND id = $2`, [u.sub, incidentId]);
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const parsed = addIncidentUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const id = nanoid();
  const at = nowIso();
  const byLabel = userLabel(req);

  await pool.query(
    `INSERT INTO incident_updates (id, incident_id, user_sub, note, at, by_label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, incidentId, u.sub, parsed.data.note, at, byLabel]
  );

  await audit(u.sub, "add_update", "incident", incidentId, { updateId: id });
  res.status(201).json({ id, note: parsed.data.note, by: byLabel, at });
}

export async function patchIncidentStatus(req: Request, res: Response) {
  const u = req.user!;
  const incidentId = req.params.id;

  const exists = await pool.query(`SELECT 1 FROM incidents WHERE user_sub = $1 AND id = $2`, [u.sub, incidentId]);
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const parsed = patchIncidentStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  await pool.query(`UPDATE incidents SET status = $1 WHERE id = $2 AND user_sub = $3`, [
    parsed.data.status,
    incidentId,
    u.sub,
  ]);
  await audit(u.sub, "status", "incident", incidentId, { status: parsed.data.status });

  res.json({ ok: true, id: incidentId, status: parsed.data.status });
}

// -----------------------------------------------------------------------------
// Team feed + Online users (derived from users.last_seen, no ping endpoint needed)
// -----------------------------------------------------------------------------

export async function listMessages(req: Request, res: Response) {
  const limitRaw = Number(req.query.limit ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30;

  const before = typeof req.query.before === "string" ? req.query.before : null;
  const beforeId = typeof req.query.beforeId === "string" ? req.query.beforeId : null;

  const params: any[] = [];
  let where = "";

  if (before && beforeId) {
    params.push(before, beforeId);
    where = `WHERE (tm.created_at, tm.id) < ($1::timestamptz, $2::text)`;
  }

  // fetch one extra row so we can report hasMore
  params.push(limit + 1);

  const sql = `
    SELECT
      tm.id,
      tm.user_sub as "userSub",
      COALESCE(u.display_name, tm.by_label) as "by",
      tm.handle,
      tm.body,
      tm.created_at as "createdAt",
      tm.mentions,
      tm.page
    FROM team_messages tm
    LEFT JOIN users u ON u.user_sub = tm.user_sub
    ${where}
    ORDER BY tm.created_at DESC, tm.id DESC
    LIMIT $${params.length}
  `;

  const rows = await pool.query(sql, params);

  const items = rows.rows.slice(0, limit);
  const hasMore = rows.rows.length > limit;

  const last = items[items.length - 1];
  const next = last ? { before: last.createdAt, beforeId: last.id } : null;

  res.json({ items, hasMore, next });
}

export async function sendMessage(req: Request, res: Response) {
  const u = req.user!;
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const id = nanoid();
  const createdAt = nowIso();

  const by = userLabel(req);
  const handle = toHandle(by) || toHandle(u.sub || "user");
  const mentions = extractMentions(parsed.data.body);

  await pool.query(
    `INSERT INTO team_messages (id, user_sub, by_label, handle, body, mentions, created_at, page)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, u.sub, by, handle, parsed.data.body, mentions, createdAt, parsed.data.page || null]
  );

  await audit(u.sub, "message", "team", id, { mentions, page: parsed.data.page || null });
  res.status(201).json({ id, userSub: u.sub, by, handle, body: parsed.data.body, mentions, createdAt });
}

export async function listOnline(_req: Request, res: Response) {
  const rows = await pool.query(
    `SELECT
        user_sub as "userSub",
        display_name as "displayName",
        email,
        handle,
        last_seen as "lastSeen"
     FROM users
     WHERE last_seen > (NOW() - INTERVAL '90 seconds')
     ORDER BY last_seen DESC
     LIMIT 50`
  );
  res.json(rows.rows);
}
