// src/lib/clock.ts — wall-clock authority shared by every device.
import { remote } from "../db/client";

let offset = 0;
let calibratedAt = 0;
const TTL = 60 * 60 * 1000;

export async function calibrate(): Promise<void> {
  if (Date.now() - calibratedAt < TTL) return;
  try {
    const t0 = Date.now();
    const rs = await remote.execute("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS t");
    const t1 = Date.now();
    // NTP-style: assume symmetric latency, discount half the round-trip.
    offset = Number(rs.rows[0].t) - (t0 + (t1 - t0) / 2);
    calibratedAt = Date.now();
  } catch { /* offline: keep the last known offset, degrade to OS clock */ }
}

/** Single source of truth for every timestamp written to the DB. */
export const now = (): number => Math.round(Date.now() + offset);