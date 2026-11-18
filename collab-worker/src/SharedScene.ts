/**
 * One shareable (read-only) link: an encrypted, compressed scene snapshot
 * plus its encrypted image files. The decryption key lives only in the
 * link's URL hash.
 *
 * Files can only be added with the write token returned when the link was
 * created, within an hour, and are never overwritten.
 */
import { DurableObject } from "cloudflare:workers";

import { BlobStore } from "./blobStore";
import {
  binary,
  errorResponse,
  HttpError,
  json,
  LIMITS,
  RE_FILE_ID,
  readBody,
  sha256Hex,
} from "./http";

import type { Env } from "./index";

const PAYLOAD_KEY = "payload";
const fileKey = (id: string) => `file:${id}`;
const FILE_UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export class SharedScene extends DurableObject<Env> {
  private store: BlobStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BlobStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      // /shares/:id  |  /shares/:id/files/:fileId
      const [, , , kind, fileId] = url.pathname.split("/");

      if (!kind) {
        return await this.handlePayload(request);
      }
      if (kind === "files" && fileId && RE_FILE_ID.test(fileId)) {
        return await this.handleFile(request, fileId);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handlePayload(request: Request) {
    if (request.method === "GET") {
      const payload = this.store.get(PAYLOAD_KEY);
      if (!payload) {
        return json({ error: "Link not found" }, 404);
      }
      return binary(payload.data, {
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    }
    if (request.method !== "POST") {
      throw new HttpError(405, "Method not allowed");
    }
    // created by the worker with a fresh id + token
    const token = request.headers.get("x-share-token") || "";
    if (!token) {
      throw new HttpError(400, "Missing token");
    }
    if (this.store.has(PAYLOAD_KEY)) {
      throw new HttpError(409, "Id already taken");
    }
    const body = await readBody(request, LIMITS.shareBytes, {
      error_class: "RequestTooLargeError",
    });
    this.store.put(PAYLOAD_KEY, body, {
      tokenHash: await sha256Hex(token),
      createdAt: Date.now(),
    });
    return json({ ok: true }, 201);
  }

  private async handleFile(request: Request, id: string) {
    if (request.method === "GET") {
      const file = this.store.get(fileKey(id));
      if (!file) {
        return json({ error: "File not found" }, 404);
      }
      return binary(file.data, {
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    }
    if (request.method !== "PUT") {
      throw new HttpError(405, "Method not allowed");
    }
    const payload = this.store.head(PAYLOAD_KEY);
    const token = request.headers.get("x-share-token") || "";
    if (
      !payload ||
      !token ||
      (await sha256Hex(token)) !== payload.meta.tokenHash
    ) {
      throw new HttpError(403, "Invalid share token");
    }
    if (Date.now() - Number(payload.meta.createdAt) > FILE_UPLOAD_WINDOW_MS) {
      throw new HttpError(403, "This link no longer accepts files");
    }
    const body = await readBody(request, LIMITS.fileBytes);
    if (this.store.has(fileKey(id))) {
      return json({ ok: true, existed: true });
    }
    this.store.put(fileKey(id), body);
    return json({ ok: true }, 201);
  }
}
