// src/db/client.ts — SERVER ONLY. Never import this from a client <script>.
import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPLICA = resolve(process.env.LOCAL_REPLICA_PATH ?? "./.data/deepwork.db");
mkdirSync(dirname(REPLICA), { recursive: true });

declare global { var __dwDb: Client | undefined; var __dwRemote: Client | undefined; }

/**
 * Embedded replica. Every read AND write hits the local file first.
 * offline:true  -> writes are accepted while the primary is unreachable and
 *                  pushed on the next successful sync().
 * syncInterval:0 -> we drive sync() ourselves (see sync.ts) so the UI badge
 *                  can reflect real state instead of a blind timer.
 */
export const db: Client =
  globalThis.__dwDb ??
  (globalThis.__dwDb = createClient({
    url: `file:${REPLICA}`,
    syncUrl: process.env.TURSO_SYNC_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
    syncInterval: 0,
    offline: true,
    readYourWrites: true,
  }));

/** HTTP-only client, used solely as a wall-clock authority. See lib/clock.ts. */
export const remote: Client =
  globalThis.__dwRemote ??
  (globalThis.__dwRemote = createClient({
    url: process.env.TURSO_SYNC_URL!.replace(/^file:/, ""),
    authToken: process.env.TURSO_AUTH_TOKEN!,
  }));

export const DEVICE_ID = process.env.DEVICE_ID ?? "unknown-device";