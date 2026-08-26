-- src/db/schema.sql — libSQL/SQLite. Idempotent.
-- Apply ONCE against the primary: turso db shell deepwork < src/db/schema.sql
-- Replicas receive it via sync(). All timestamps are Unix epoch MILLISECONDS (INTEGER).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#8a8a8a',
  hotkey     TEXT UNIQUE,                 -- '1'..'9' for keyboard selection
  archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL CHECK (status IN ('active','paused','completed')),

  -- INVARIANT, the core of cross-device resume:
  --   start_time      : immutable, first play. Used for day/week bucketing.
  --   resumed_at      : anchor of the CURRENTLY RUNNING segment. NULL unless active.
  --   accumulated_ms  : sum of every CLOSED segment. Never includes live time.
  --   elapsed         = accumulated_ms + (status='active' ? now - resumed_at : 0)
  start_time     INTEGER NOT NULL,
  resumed_at     INTEGER,
  accumulated_ms INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_ms >= 0),
  end_time       INTEGER,

  difficulty     TEXT CHECK (difficulty IN ('easy','medium','hard')),
  notes          TEXT,
  device_id      TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  synced_at      INTEGER,                 -- NULL = pending push to primary

  -- NULL for completed rows; NULLs are distinct in SQLite unique indexes,
  -- so this yields "at most ONE open session across all devices", enforced by the engine.
  open_slot      INTEGER GENERATED ALWAYS AS (CASE WHEN status <> 'completed' THEN 1 END) VIRTUAL,

  CHECK ((status = 'active')    = (resumed_at IS NOT NULL)),
  CHECK ((status = 'completed') = (end_time   IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_open      ON sessions(open_slot);
CREATE        INDEX IF NOT EXISTS ix_sessions_project   ON sessions(project_id, start_time DESC);
CREATE        INDEX IF NOT EXISTS ix_sessions_unsynced  ON sessions(updated_at) WHERE synced_at IS NULL;
CREATE        INDEX IF NOT EXISTS ix_sessions_completed ON sessions(end_time DESC) WHERE status = 'completed';

-- Server-side elapsed, so analytics never re-implements the formula.
CREATE VIEW IF NOT EXISTS v_sessions AS
SELECT s.*,
       s.accumulated_ms
         + CASE WHEN s.status = 'active'
                THEN MAX(0, CAST(unixepoch('subsec') * 1000 AS INTEGER) - s.resumed_at)
                ELSE 0 END AS elapsed_ms
FROM sessions s;

INSERT OR IGNORE INTO projects (id,name,color,hotkey,created_at,updated_at) VALUES
  ('prj_ancient_photon','Ancient Photon','#e0b341','1',unixepoch()*1000,unixepoch()*1000),
  ('prj_pagde',         'PAGDE',         '#4f9dde','2',unixepoch()*1000,unixepoch()*1000),
  ('prj_el_bloque',     'El Bloque',     '#d0605e','3',unixepoch()*1000,unixepoch()*1000),
  ('prj_universidad',   'Universidad',   '#6fbf8b','4',unixepoch()*1000,unixepoch()*1000);