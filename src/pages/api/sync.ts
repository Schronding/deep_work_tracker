// src/pages/api/sync.ts
import type { APIRoute } from "astro";
import { sync } from "../../db/sync";
export const prerender = false;

export const GET: APIRoute = async () => Response.json(sync.snapshot());

/** Called by the browser on `online` / tab focus: forces a push+pull. */
export const POST: APIRoute = async () => {
  await sync.flush(true);
  return Response.json(sync.snapshot());
};