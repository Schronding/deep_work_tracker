// src/db/sessions.ts — every mutation is a compare-and-swap on `status`.
// If another device already changed the state, rowsAffected === 0 and we
// return the authoritative row instead of corrupting accumulated_ms.
import { db, DEVICE_ID } from "./client";
import { sync } from "./sync";
import { calibrate, now } from "../lib/clock";

export interface SessionRow {
  id: string; project_id: string; project_name: string; project_color: string;
  status: "active" | "paused" | "completed";
  start_time: number; resumed_at: number | null; accumulated_ms: number;
  end_time: number | null; difficulty: string | null; notes: string | null;
  synced_at: number | null;
}

const SELECT_OPEN = `
  SELECT s.*, p.name AS project_name, p.color AS project_color
  FROM sessions s JOIN projects p ON p.id = s.project_id
  WHERE s.status <> 'completed' LIMIT 1`;

/** HANDOFF ENTRY POINT: pull before read, otherwise the replica may be stale. */
export async function current(): Promise<SessionRow | null> {
  await sync.freshRead();
  const rs = await db.execute(SELECT_OPEN);
  return (rs.rows[0] as unknown as SessionRow) ?? null;
}

export async function start(projectId: string): Promise<SessionRow> {
  await calibrate();
  const t = now();
  const id = crypto.randomUUID();
  const tx = await db.transaction("write");
  try {
    const open = await tx.execute("SELECT id FROM sessions WHERE status <> 'completed' LIMIT 1");
    if (open.rows.length) throw new Error("SESSION_ALREADY_OPEN");
    await tx.execute({
      sql: `INSERT INTO sessions
              (id, project_id, status, start_time, resumed_at, accumulated_ms, device_id, updated_at, synced_at)
            VALUES (?, ?, 'active', ?, ?, 0, ?, ?, NULL)`,
      args: [id, projectId, t, t, DEVICE_ID, t],
    });
    await tx.commit();
  } finally { if (!tx.closed) await tx.rollback(); }
  sync.afterWrite();
  return (await current())!;
}

/** active -> paused. Closes the live segment INTO accumulated_ms atomically in SQL. */
export async function pause(id: string): Promise<SessionRow | null> {
  const t = now();
  await db.execute({
    sql: `UPDATE sessions
             SET status = 'paused',
                 accumulated_ms = accumulated_ms + MAX(0, ? - resumed_at),
                 resumed_at = NULL,
                 device_id = ?, updated_at = ?, synced_at = NULL
           WHERE id = ? AND status = 'active'`,
    args: [t, DEVICE_ID, t, id],
  });
  sync.afterWrite();
  return current();
}

/** paused -> active. Opens a NEW segment; accumulated_ms is untouched. */
export async function resume(id: string): Promise<SessionRow | null> {
  const t = now();
  await db.execute({
    sql: `UPDATE sessions
             SET status = 'active', resumed_at = ?, device_id = ?, updated_at = ?, synced_at = NULL
           WHERE id = ? AND status = 'paused'`,
    args: [t, DEVICE_ID, t, id],
  });
  sync.afterWrite();
  return current();
}

/**
 * -> completed, in ONE statement, regardless of whether it was running or paused.
 * Runs BEFORE the capture modal opens: the session is durable even if the tab dies.
 */
export async function stop(id: string): Promise<SessionRow | null> {
  const t = now();
  await db.execute({
    sql: `UPDATE sessions
             SET accumulated_ms = accumulated_ms
                   + CASE WHEN status = 'active' THEN MAX(0, ? - resumed_at) ELSE 0 END,
                 status = 'completed', resumed_at = NULL, end_time = ?,
                 device_id = ?, updated_at = ?, synced_at = NULL
           WHERE id = ? AND status <> 'completed'`,
    args: [t, t, DEVICE_ID, t, id],
  });
  sync.afterWrite();
  const rs = await db.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [id] });
  return (rs.rows[0] as unknown as SessionRow) ?? null;
}

/** Metadata-only patch from the capture modal. Never touches timing columns. */
export async function annotate(id: string, difficulty: string | null, notes: string | null) {
  const t = now();
  await db.execute({
    sql: `UPDATE sessions SET difficulty = ?, notes = ?, updated_at = ?, synced_at = NULL WHERE id = ?`,
    args: [difficulty, notes?.trim() || null, t, id],
  });
  sync.afterWrite();
}