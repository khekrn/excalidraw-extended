/**
 * One collaboration room.
 *
 * - Relays end-to-end encrypted messages between the room's WebSockets (the
 *   room key never reaches the server) — same semantics as excalidraw-room's
 *   socket.io server: init-room → join-room → first-in-room / new-user,
 *   room-user-change, broadcast, volatile broadcast and per-user "follow"
 *   rooms.
 * - Stores the encrypted scene (optimistic concurrency via a revision
 *   number) and the encrypted image files.
 *
 * Uses the WebSocket Hibernation API, so idle rooms cost nothing.
 *
 * Wire protocol (see excalidraw-app/collab/CollabSocket.ts):
 *   text frames — JSON control messages
 *     server → client: {type:"init-room", socketId} | {type:"first-in-room"}
 *       | {type:"new-user", socketId} | {type:"room-user-change", clients}
 *       | {type:"user-follow-room-change", followedBy}
 *     client → server: {type:"join-room"} | {type:"user-follow", payload}
 *     "ping" → "pong" (answered without waking the object)
 *   binary frames — [flags u8][ivLength u8][iv][ciphertext]
 *     client → server flags: bit0 volatile, bit1 = only to my followers
 *     server → client: same layout, flags = 0 ("client-broadcast")
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
  RE_SOCKET_ID,
  randomId,
  readBody,
} from "./http";

import type { Env } from "./index";

type Attachment = {
  id: string;
  joined: boolean;
  /** socket ids this socket follows (it's in their "follow@<id>" room) */
  following: string[];
};

// bit0 (1) marks volatile messages (cursors, idle status). Nothing is
// buffered server-side, so they're relayed exactly like regular ones.
const FLAG_FOLLOWERS = 2;

const SCENE_KEY = "scene";
const fileKey = (id: string) => `file:${id}`;

export class CollabRoom extends DurableObject<Env> {
  private store: BlobStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BlobStore(ctx.storage);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      // /rooms/:roomId/(ws | scene | files/:fileId)
      const [, , , kind, fileId] = url.pathname.split("/");
      switch (kind) {
        case "ws":
          return this.acceptSocket(request, url);
        case "scene":
          return await this.handleScene(request);
        case "files":
          if (!fileId || !RE_FILE_ID.test(fileId)) {
            throw new HttpError(400, "Invalid file id");
          }
          return await this.handleFile(request, fileId);
        default:
          throw new HttpError(404, "Not found");
      }
    } catch (error) {
      return errorResponse(error);
    }
  }

  // scene ---------------------------------------------------------------------

  private sceneResponse(status = 200) {
    const scene = this.store.get(SCENE_KEY);
    if (!scene) {
      return json({ error: "No scene stored for this room" }, 404);
    }
    return new Response(scene.data, {
      status,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "x-iv": String(scene.meta.iv),
        "x-scene-version": String(scene.meta.sceneVersion),
        "x-rev": String(scene.meta.rev),
      },
    });
  }

  private async handleScene(request: Request) {
    if (request.method === "GET") {
      return this.sceneResponse();
    }
    if (request.method !== "PUT") {
      throw new HttpError(405, "Method not allowed");
    }
    const iv = request.headers.get("x-iv") || "";
    const sceneVersion = Number(request.headers.get("x-scene-version"));
    const expectedRev = Number(request.headers.get("x-expected-rev") ?? "0");
    if (
      !/^[A-Za-z0-9+/=_-]{8,64}$/.test(iv) ||
      !Number.isFinite(sceneVersion)
    ) {
      throw new HttpError(400, "Missing or invalid x-iv / x-scene-version");
    }
    const body = await readBody(request, LIMITS.sceneBytes);

    // read-compare-write runs atomically: the object handles one event at a
    // time and SQLite calls are synchronous
    const currentRev = Number(this.store.head(SCENE_KEY)?.meta.rev ?? 0);
    if (currentRev !== expectedRev) {
      // somebody saved in between — send them the latest to reconcile with
      return this.sceneResponse(409);
    }
    const rev = currentRev + 1;
    this.store.put(SCENE_KEY, body, { iv, sceneVersion, rev });
    return json({ rev });
  }

  // files ---------------------------------------------------------------------

  private async handleFile(request: Request, id: string) {
    if (request.method === "GET") {
      const file = this.store.get(fileKey(id));
      if (!file) {
        return json({ error: "File not found" }, 404);
      }
      // ids are content hashes: a file never changes once stored
      return binary(file.data, {
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    }
    if (request.method !== "PUT") {
      throw new HttpError(405, "Method not allowed");
    }
    const body = await readBody(request, LIMITS.fileBytes);
    if (this.store.has(fileKey(id))) {
      return json({ ok: true, existed: true });
    }
    this.store.put(fileKey(id), body);
    return json({ ok: true }, 201);
  }

  // sockets -------------------------------------------------------------------

  private acceptSocket(request: Request, url: URL) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "Expected a WebSocket upgrade");
    }
    // clients pick their own id so it survives reconnects
    const requested = url.searchParams.get("sid") || "";
    const id = RE_SOCKET_ID.test(requested) ? requested : randomId();

    // a reconnecting client replaces its previous (dead) connection
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachment(ws)?.id === id) {
        this.onSocketGone(ws);
        this.drop(ws, 4000, "Replaced by a newer connection");
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { id, joined: false, following: [] };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: "init-room", socketId: id }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const self = this.attachment(ws);
    if (!self) {
      return;
    }

    if (typeof message !== "string") {
      this.relay(ws, self, message);
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg?.type) {
      case "join-room": {
        if (self.joined) {
          return;
        }
        self.joined = true;
        ws.serializeAttachment(self);
        const clients = this.joinedSockets();
        if (clients.length <= 1) {
          this.send(ws, { type: "first-in-room" });
        } else {
          for (const [other] of clients) {
            if (other !== ws) {
              this.send(other, { type: "new-user", socketId: self.id });
            }
          }
        }
        this.broadcastUserChange();
        return;
      }

      case "user-follow": {
        const targetId = msg.payload?.userToFollow?.socketId;
        const action = msg.payload?.action;
        if (
          typeof targetId !== "string" ||
          !RE_SOCKET_ID.test(targetId) ||
          targetId === self.id ||
          (action !== "FOLLOW" && action !== "UNFOLLOW")
        ) {
          return;
        }
        const following = new Set(self.following);
        if (action === "FOLLOW") {
          following.add(targetId);
        } else {
          following.delete(targetId);
        }
        // attachments are capped at 2KB; a client follows one user at a time
        self.following = [...following].slice(-20);
        ws.serializeAttachment(self);
        this.notifyFollowed(targetId);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.onSocketGone(ws);
    this.drop(ws, code === 1005 || code === 1006 ? 1000 : code, "Closing");
  }

  async webSocketError(ws: WebSocket) {
    this.onSocketGone(ws);
  }

  // helpers -------------------------------------------------------------------

  private onSocketGone(ws: WebSocket) {
    const self = this.attachment(ws);
    if (!self) {
      return;
    }
    // mark it so the lookups below skip it even if the runtime still lists it
    ws.serializeAttachment({ ...self, joined: false, following: [] });
    if (self.joined) {
      this.broadcastUserChange(ws);
    }
    for (const followedId of self.following) {
      this.notifyFollowed(followedId, ws);
    }
  }

  /** forwards an encrypted message to the room (or my followers) */
  private relay(from: WebSocket, self: Attachment, data: ArrayBuffer) {
    if (!self.joined || data.byteLength < 2) {
      return;
    }
    if (data.byteLength > LIMITS.messageBytes) {
      this.drop(from, 1009, "Message too big");
      return;
    }
    const input = new Uint8Array(data);
    const flags = input[0];
    const out = input.slice();
    out[0] = 0;

    for (const [other, info] of this.joinedSockets(from)) {
      if (flags & FLAG_FOLLOWERS && !info.following.includes(self.id)) {
        continue;
      }
      try {
        other.send(out);
      } catch {
        // volatile or not, a dead socket gets cleaned up on close
      }
    }
  }

  private broadcastUserChange(exclude?: WebSocket) {
    const clients = this.joinedSockets(exclude);
    const ids = [...new Set(clients.map(([, info]) => info.id))];
    for (const [ws] of clients) {
      this.send(ws, { type: "room-user-change", clients: ids });
    }
  }

  /** tells a user who's following them (to start/stop sharing viewport) */
  private notifyFollowed(followedId: string, exclude?: WebSocket) {
    const sockets = this.joinedSockets(exclude);
    const followedBy = [
      ...new Set(
        sockets
          .filter(([, info]) => info.following.includes(followedId))
          .map(([, info]) => info.id),
      ),
    ];
    for (const [ws, info] of sockets) {
      if (info.id === followedId) {
        this.send(ws, { type: "user-follow-room-change", followedBy });
      }
    }
  }

  private joinedSockets(exclude?: WebSocket): [WebSocket, Attachment][] {
    const result: [WebSocket, Attachment][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude || ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const info = this.attachment(ws);
      if (info?.joined) {
        result.push([ws, info]);
      }
    }
    return result;
  }

  private attachment(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment) ?? null;
    } catch {
      return null;
    }
  }

  private send(ws: WebSocket, message: unknown) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // closed in the meantime
    }
  }

  private drop(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
