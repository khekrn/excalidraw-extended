/**
 * Excalidraw collaboration worker.
 *
 *   GET  /rooms/:roomId/ws                 WebSocket (live collaboration)
 *   GET  /rooms/:roomId/scene              encrypted room scene
 *   PUT  /rooms/:roomId/scene              save it (x-iv, x-scene-version,
 *                                          x-expected-rev; 409 = conflict)
 *   GET  /rooms/:roomId/files/:fileId      encrypted image file
 *   PUT  /rooms/:roomId/files/:fileId
 *   POST /shares                           create a shareable link → {id, token}
 *   GET  /shares/:id                       its encrypted payload
 *   GET  /shares/:id/files/:fileId
 *   PUT  /shares/:id/files/:fileId         (x-share-token)
 *
 * Everything is end-to-end encrypted by the app; keys never reach the worker.
 */
import {
  errorResponse,
  HttpError,
  json,
  LIMITS,
  RE_FILE_ID,
  RE_ROOM_ID,
  RE_SHARE_ID,
  randomId,
  readBody,
} from "./http";

export { CollabRoom } from "./CollabRoom";
export { SharedScene } from "./SharedScene";

export interface Env {
  ROOMS: DurableObjectNamespace;
  SHARES: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
}

const isAllowedOrigin = (origin: string, env: Env) => {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return (
    allowed.includes("*") ||
    allowed.includes(origin) ||
    // "http://localhost:*" allows any port (local dev servers)
    allowed.some(
      (entry) =>
        entry.endsWith(":*") &&
        new RegExp(`^${escapeRegExp(entry.slice(0, -2))}:\\d+$`).test(origin),
    )
  );
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-iv, x-scene-version, x-expected-rev, x-share-token",
  "Access-Control-Expose-Headers": "x-iv, x-scene-version, x-rev",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

const withCors = (response: Response, origin: string | null) => {
  if (!origin || response.status === 101) {
    return response;
  }
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    next.headers.set(key, value);
  }
  return next;
};

const route = async (request: Request, env: Env, url: URL) => {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return new Response("excalidraw collab worker: ok\n", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (parts[0] === "rooms") {
    const [, roomId, kind, fileId, ...rest] = parts;
    if (!roomId || !RE_ROOM_ID.test(roomId)) {
      throw new HttpError(400, "Invalid room id");
    }
    const valid =
      rest.length === 0 &&
      ((kind === "ws" && !fileId) ||
        (kind === "scene" && !fileId) ||
        (kind === "files" && !!fileId && RE_FILE_ID.test(fileId)));
    if (!valid) {
      throw new HttpError(404, "Not found");
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return stub.fetch(request);
  }

  if (parts[0] === "shares") {
    if (parts.length === 1) {
      if (request.method !== "POST") {
        throw new HttpError(405, "Method not allowed");
      }
      const body = await readBody(request, LIMITS.shareBytes, {
        error_class: "RequestTooLargeError",
      });
      const id = randomId(22);
      const token = randomId(32);
      const stub = env.SHARES.get(env.SHARES.idFromName(id));
      const created = await stub.fetch(
        new Request(`https://share.internal/shares/${id}`, {
          method: "POST",
          headers: { "x-share-token": token },
          body,
        }),
      );
      if (!created.ok) {
        return created;
      }
      return json({ id, token }, 201);
    }
    const [, id, kind, fileId, ...rest] = parts;
    if (!RE_SHARE_ID.test(id)) {
      throw new HttpError(400, "Invalid link id");
    }
    const valid =
      rest.length === 0 &&
      (!kind || (kind === "files" && !!fileId && RE_FILE_ID.test(fileId)));
    if (!valid) {
      throw new HttpError(404, "Not found");
    }
    const stub = env.SHARES.get(env.SHARES.idFromName(id));
    return stub.fetch(request);
  }

  throw new HttpError(404, "Not found");
};

const handler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");

    // browsers always send Origin on CORS and WebSocket requests; requests
    // without one (curl, scripts) aren't subject to the browser's
    // same-origin rules anyway
    if (origin && !isAllowedOrigin(origin, env)) {
      return json({ error: `Origin ${origin} is not allowed` }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: origin ? corsHeaders(origin) : {},
      });
    }

    let response: Response;
    try {
      response = await route(request, env, new URL(request.url));
    } catch (error) {
      response = errorResponse(error);
    }
    return withCors(response, origin);
  },
};

export default handler;
