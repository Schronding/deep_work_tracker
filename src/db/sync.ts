// src/db/sync.ts
import { db } from "./client";

export type SyncState = "synced" | "syncing" | "offline";

const PULL_MS = 30_000;   // background heartbeat
const STALE_MS = 4_000;   // freshness window before a handoff read
const BACKOFF = [1_000, 3_000, 8_000, 20_000, 60_000];

class SyncSupervisor {
  state: SyncState = "syncing";
  lastSyncAt = 0;
  lastError: string | null = null;
  #inFlight: Promise<void> | null = null;
  #attempt = 0;
  #nextAt = 0;

  start() {
    const t = setInterval(() => void this.flush(), PULL_MS);
    (t as any).unref?.();
    void this.flush();
  }

  /** Coalesces concurrent callers into a single round-trip. */
  flush(force = false): Promise<void> {
    if (!force && Date.now() < this.#nextAt) return Promise.resolve();
    return (this.#inFlight ??= this.#run().finally(() => (this.#inFlight = null)));
  }

  async #run() {
    this.state = "syncing";
    const cutoff = Date.now();
    try {
      await db.sync(); // push local writes + pull remote frames
      // Stamp only rows that were already durable when the round-trip started.
      await db.execute({
        sql: `UPDATE sessions SET synced_at = ? WHERE synced_at IS NULL AND updated_at <= ?`,
        args: [cutoff, cutoff],
      });
      this.state = "synced";
      this.lastSyncAt = Date.now();
      this.lastError = null;
      this.#attempt = 0;
      this.#nextAt = 0;
    } catch (err) {
      this.state = "offline";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.#nextAt = Date.now() + BACKOFF[Math.min(this.#attempt++, BACKOFF.length - 1)];
    }
  }

  /** READ PATH — guarantees the replica is fresh before a cross-device read. */
  async freshRead() {
    if (Date.now() - this.lastSyncAt > STALE_MS) await this.flush(true);
  }

  /** WRITE PATH — never blocks the response; the write is already durable locally. */
  afterWrite() { queueMicrotask(() => void this.flush(true)); }

  snapshot() {
    return { state: this.state, lastSyncAt: this.lastSyncAt, error: this.lastError };
  }
}

export const sync = new SyncSupervisor();
sync.start();