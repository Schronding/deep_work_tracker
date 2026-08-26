// src/pages/api/session.ts
import type { APIRoute } from "astro";
import * as S from "../../db/sessions";
import { now } from "../../lib/clock";
import { sync } from "../../db/sync";
export const prerender = false;

const payload = async () => Response.json({
  now: now(),                 // client uses this to compute its own skew
  session: await S.current(),
  sync: sync.snapshot(),
});

export const GET: APIRoute = payload;

export const POST: APIRoute = async ({ request }) => {
  const { action, id, projectId, difficulty, notes } = await request.json();
  try {
    switch (action) {
      case "start":  await S.start(projectId); break;
      case "pause":  await S.pause(id); break;
      case "resume": await S.resume(id); break;
      case "stop": {
        const row = await S.stop(id);
        return Response.json({ now: now(), session: null, ended: row, sync: sync.snapshot() });
      }
      case "annotate": await S.annotate(id, difficulty ?? null, notes ?? null); break;
      default: return new Response("Unknown action", { status: 400 });
    }
  } catch (e) {
    // 409: another device won the race. Client reconciles with the returned state.
    return Response.json({ error: String(e), ...(await (await payload()).json()) }, { status: 409 });
  }
  return payload();
};