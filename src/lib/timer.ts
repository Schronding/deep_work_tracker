// src/lib/timer.ts — pure, isomorphic, zero imports. The formula lives HERE only.
export type SessionStatus = "active" | "paused" | "completed";

export interface TimerSnapshot {
  status: SessionStatus;
  resumed_at: number | null;
  accumulated_ms: number;
}

export function elapsedMs(s: TimerSnapshot | null, now: number): number {
  if (!s) return 0;
  if (s.status !== "active" || s.resumed_at == null) return s.accumulated_ms;
  // MAX(0,...) absorbs residual clock skew: the timer never runs backwards.
  return s.accumulated_ms + Math.max(0, now - s.resumed_at);
}

export function formatHMS(ms: number): string {
  const t = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
}