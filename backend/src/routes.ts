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
  pingPresenceSchema,
} from "./validators.js";
import type { AuthUser } from "./types.js";

// Helpers ---------------------------------------------------------------------

async function getProfile(sub: string) {
  const r = await pool.query(
    `SELECT user_sub, email, display_name, picture_url, handle
     FROM users
     WHERE user_sub = $1`,
    [sub]
  );
  return r.rows[0] as
    | { user_sub: string; email: string | null; display_name: string; picture_url: string | null; handle: string | null }
    | undefined;
}

function fallbackLabel(u: AuthUser) {
  return u.email || u.name || u.sub || "user";
}

// -----------------------------------------------------------------------------
// Health / Me
// -----------------------------------------------------------------------------

export function health(_req: Request, res: Response) {
  res.json({ ok: true, time: new Date().toISOString() });
}

export function me(req: Request, res: Response) {
  res.json({ user: req.user });
}

// -----------------------------------------------------------------------------
// Checklists
// -----------------------------------------------------------------------------

export async function listChecklists(req: Request, res: Response) {
  const u = req.user!;
  // If seed data depends on user label, try users table first.
  const profile = await getProfile(u.sub);
  await seedIfEmpty(u.sub, profile?.display_name || fallbackLabel(u));

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

  const profile = await getProfile(u.sub);
  const updatedBy = profile?.display_name || fallbackLabel(u);

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

  const profile = await getProfile(u.sub);
  const updatedBy = profile?.display_name || fallbackLabel(u);

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
  const profile = await getProfile(u.sub);
  await seedIfEmpty(u.sub, profile?.display_name || fallbackLabel(u));

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
          COALESCE(uu.display_name, iu.by_label, iu.user_sub) as "by",
          iu.at
       FROM incident_updates iu
       LEFT JOIN users uu ON uu.user_sub = iu.user_sub
       WHERE iu.incident_id = $1 AND iu.user_sub = $2
       ORDER BY iu.at DESC`,
      [i.id, u.sub]
    );

    mapped.push({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      createdAt: i.created_at,
      updates: updates.rows.map((r) => ({ id: r.id, note: r.note, by: r.by, at: r.at })),
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
  res.status(201).json({
    id,
    title: parsed.data.title,
    severity: parsed.data.severity,
    status: "open",
    createdAt,
    updates: [],
  });
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

  const profile = await getProfile(u.sub);
  const byLabel = profile?.display_name || fallbackLabel(u);

  await pool.query(
    `INSERT INTO incident_updates (id, incident_id, user_sub, note, by_label, by_sub, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, incidentId, u.sub, parsed.data.note, byLabel, u.sub, at]
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
// Team Messages + Presence
// -----------------------------------------------------------------------------

function extractMentions(body: string): string[] {
  const out: string[] = [];
  const re = /@([a-zA-Z0-9_\-\.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].toLowerCase());
  return Array.from(new Set(out)).slice(0, 20);
}

export async function listMessages(req: Request, res: Response) {
  // show friendly names even if by_label is stale
  const rows = await pool.query(
    `SELECT
        tm.id,
        tm.user_sub as "userSub",
        COALESCE(u.display_name, tm.by_label, tm.user_sub) as "by",
        COALESCE(u.handle, tm.handle) as "handle",
        tm.body,
        tm.created_at as "createdAt",
        tm.mentions
     FROM team_messages tm
     LEFT JOIN users u ON u.user_sub = tm.user_sub
     ORDER BY tm.created_at DESC
     LIMIT 200`
  );
  res.json(rows.rows);
}

export async function sendMessage(req: Request, res: Response) {
  const u = req.user!;
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const id = nanoid();
  const createdAt = nowIso();

  const profile = await getProfile(u.sub);
  const by = profile?.display_name || fallbackLabel(u);
  const handle = profile?.handle || null;
  const mentions = extractMentions(parsed.data.body);

  await pool.query(
    `INSERT INTO team_messages (id, user_sub, by_label, handle, body, mentions, created_at, page)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, u.sub, by, handle, parsed.data.body, mentions, createdAt, parsed.data.page || null]
  );

  await audit(u.sub, "message", "team", id, { mentions, page: parsed.data.page || null });
  res.status(201).json({ id, userSub: u.sub, by, handle, body: parsed.data.body, mentions, createdAt });
}

/**
 * Presence ping: do NOT derive a display name from the token here.
 * We take the display name from `users` table to avoid reverting to `sub`
 * when tokens are missing profile/email claims.
 */
export async function pingPresence(req: Request, res: Response) {
  const u = req.user!;
  const parsed = pingPresenceSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.flatten() });

  const now = nowIso();

  // Pull the latest known user profile.
  const profile = await getProfile(u.sub);
  const label = profile?.display_name || fallbackLabel(u);
  const handle = profile?.handle || null;

  await pool.query(
    `INSERT INTO presence (user_sub, handle, label, last_seen, page)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_sub) DO UPDATE SET
       handle = COALESCE(EXCLUDED.handle, presence.handle),
       label  = COALESCE(EXCLUDED.label, presence.label),
       last_seen = EXCLUDED.last_seen,
       page = EXCLUDED.page`,
    [u.sub, handle, label, now, parsed.data.page || null]
  );

  res.json({ ok: true });
}

export async function listOnline(_req: Request, res: Response) {
  const rows = await pool.query(
    `SELECT
        p.user_sub as "userSub",
        COALESCE(u.display_name, p.label, p.user_sub) as "displayName",
        COALESCE(u.handle, p.handle) as "handle",
        p.page,
        p.last_seen as "lastSeen"
     FROM presence p
     LEFT JOIN users u ON u.user_sub = p.user_sub
     WHERE p.last_seen > (NOW() - INTERVAL '90 seconds')
     ORDER BY p.last_seen DESC
     LIMIT 50`
  );
  res.json(rows.rows);
}
