import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { audit, nowIso, pool, seedIfEmpty } from "./db.js";
import {
  addIncidentUpdateSchema,
  addStepSchema,
  createChecklistSchema,
  createIncidentSchema,
  patchIncidentStatusSchema,
} from "./validators.js";

const userLabel = (req: Request) =>
  req.user?.email || req.user?.name || req.user?.sub || "user";

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
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "validation", details: parsed.error.flatten() });
  }

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

  const exists = await pool.query(
    `SELECT 1 FROM checklists WHERE user_sub = $1 AND id = $2`,
    [u.sub, checklistId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const parsed = addStepSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "validation", details: parsed.error.flatten() });
  }

  const stepId = nanoid();
  const updatedAt = nowIso();
  const updatedBy = userLabel(req);

  await pool.query(
    `INSERT INTO checklist_steps (id, checklist_id, label, done, updated_at, updated_by)
     VALUES ($1, $2, $3, FALSE, $4, $5)`,
    [stepId, checklistId, parsed.data.label, updatedAt, updatedBy]
  );

  await audit(u.sub, "add_step", "checklist", checklistId, {
    stepId,
    label: parsed.data.label,
  });
  res
    .status(201)
    .json({ id: stepId, label: parsed.data.label, done: false, updatedAt, updatedBy });
}

export async function toggleStep(req: Request, res: Response) {
  const u = req.user!;
  const checklistId = req.params.id;
  const stepId = req.params.stepId;

  const exists = await pool.query(
    `SELECT 1 FROM checklists WHERE user_sub = $1 AND id = $2`,
    [u.sub, checklistId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const s = await pool.query(
    `SELECT id, done FROM checklist_steps WHERE checklist_id = $1 AND id = $2`,
    [checklistId, stepId]
  );
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

export async function deleteChecklist(req: Request, res: Response) {
  const u = req.user!;
  const checklistId = req.params.id;

  const exists = await pool.query(
    `SELECT 1 FROM checklists WHERE user_sub = $1 AND id = $2`,
    [u.sub, checklistId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await pool.query(`DELETE FROM checklists WHERE user_sub = $1 AND id = $2`, [u.sub, checklistId]);

  await audit(u.sub, "delete", "checklist", checklistId, {});
  res.json({ ok: true });
}

export async function deleteChecklistStep(req: Request, res: Response) {
  const u = req.user!;
  const checklistId = req.params.id;
  const stepId = req.params.stepId;

  const exists = await pool.query(
    `SELECT 1 FROM checklists WHERE user_sub = $1 AND id = $2`,
    [u.sub, checklistId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const del = await pool.query(
    `DELETE FROM checklist_steps WHERE checklist_id = $1 AND id = $2`,
    [checklistId, stepId]
  );
  if (del.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(u.sub, "delete_step", "checklist", checklistId, { stepId });
  res.json({ ok: true });
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
      `SELECT id, note, by_label as "by", at
       FROM incident_updates
       WHERE incident_id = $1
       ORDER BY at DESC`,
      [i.id]
    );

    mapped.push({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      createdAt: i.created_at,
      updates: updates.rows.map((u) => ({ id: u.id, note: u.note, by: u.by, at: u.at })),
    });
  }

  res.json(mapped);
}

export async function createIncident(req: Request, res: Response) {
  const u = req.user!;
  const parsed = createIncidentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "validation", details: parsed.error.flatten() });
  }

  const id = nanoid();
  const createdAt = nowIso();

  await pool.query(
    `INSERT INTO incidents (id, user_sub, title, severity, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, u.sub, parsed.data.title, parsed.data.severity, "open", createdAt]
  );

  await audit(u.sub, "create", "incident", id, {
    title: parsed.data.title,
    severity: parsed.data.severity,
  });
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

  const exists = await pool.query(
    `SELECT 1 FROM incidents WHERE user_sub = $1 AND id = $2`,
    [u.sub, incidentId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const parsed = addIncidentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "validation", details: parsed.error.flatten() });
  }

  const id = nanoid();
  const at = nowIso();
  const by = userLabel(req);

  await pool.query(
    `INSERT INTO incident_updates (id, incident_id, user_sub, note, by_label, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, incidentId, u.sub, parsed.data.note, by, at]
  );

  await audit(u.sub, "add_update", "incident", incidentId, { updateId: id });
  res.status(201).json({ id, note: parsed.data.note, by, at });
}

export async function patchIncidentStatus(req: Request, res: Response) {
  const u = req.user!;
  const incidentId = req.params.id;

  const exists = await pool.query(
    `SELECT 1 FROM incidents WHERE user_sub = $1 AND id = $2`,
    [u.sub, incidentId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const parsed = patchIncidentStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "validation", details: parsed.error.flatten() });
  }

  await pool.query(
    `UPDATE incidents SET status = $1 WHERE id = $2 AND user_sub = $3`,
    [parsed.data.status, incidentId, u.sub]
  );
  await audit(u.sub, "status", "incident", incidentId, { status: parsed.data.status });

  res.json({ ok: true, id: incidentId, status: parsed.data.status });
}

export async function deleteIncident(req: Request, res: Response) {
  const u = req.user!;
  const incidentId = req.params.id;

  const exists = await pool.query(
    `SELECT 1 FROM incidents WHERE user_sub = $1 AND id = $2`,
    [u.sub, incidentId]
  );
  if (exists.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await pool.query(`DELETE FROM incidents WHERE user_sub = $1 AND id = $2`, [u.sub, incidentId]);

  await audit(u.sub, "delete", "incident", incidentId, {});
  res.json({ ok: true });
}

// -----------------------------------------------------------------------------
// Messages (simple per-user DMs stored in Postgres)
// -----------------------------------------------------------------------------

export async function listMessageThreads(req: Request, res: Response) {
  const u = req.user!;
  const rows = await pool.query(
    `WITH m AS (
      SELECT
        id,
        sender_sub,
        receiver_sub,
        body,
        created_at,
        CASE WHEN sender_sub = $1 THEN receiver_sub ELSE sender_sub END AS other_sub
      FROM messages
      WHERE sender_sub = $1 OR receiver_sub = $1
    )
    SELECT DISTINCT ON (other_sub)
      other_sub,
      body,
      created_at,
      sender_sub
    FROM m
    ORDER BY other_sub, created_at DESC`,
    [u.sub]
  );

  res.json(
    rows.rows.map((r) => ({
      otherSub: r.other_sub,
      lastBody: r.body,
      lastAt: r.created_at,
      lastFrom: r.sender_sub,
    }))
  );
}

export async function getConversation(req: Request, res: Response) {
  const u = req.user!;
  const other = req.params.other;

  const rows = await pool.query(
    `SELECT id, sender_sub, receiver_sub, body, created_at
     FROM messages
     WHERE (sender_sub = $1 AND receiver_sub = $2)
        OR (sender_sub = $2 AND receiver_sub = $1)
     ORDER BY created_at ASC
     LIMIT 200`,
    [u.sub, other]
  );

  res.json(
    rows.rows.map((r) => ({
      id: r.id,
      from: r.sender_sub,
      to: r.receiver_sub,
      body: r.body,
      at: r.created_at,
    }))
  );
}

export async function sendMessage(req: Request, res: Response) {
  const u = req.user!;
  const to = String((req.body?.to ?? req.body?.receiverSub ?? "")).trim();
  const body = String((req.body?.body ?? req.body?.message ?? "")).trim();

  if (!to) return res.status(400).json({ error: "validation", details: { to: ["Required"] } });
  if (!body) return res.status(400).json({ error: "validation", details: { body: ["Required"] } });
  if (to === u.sub) return res.status(400).json({ error: "validation", details: { to: ["Cannot message yourself"] } });

  const id = nanoid();
  const createdAt = nowIso();

  await pool.query(
    `INSERT INTO messages (id, sender_sub, receiver_sub, body, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, u.sub, to, body, createdAt]
  );

  await audit(u.sub, "send", "message", id, { to });
  res.status(201).json({ id, from: u.sub, to, body, at: createdAt });
}
