/**
 * WebSocket client for the collaboration worker's room (see
 * /collab-worker/src/CollabRoom.ts for the protocol). Exposes the small
 * socket.io-like surface Collab/Portal use: `id`, `on`/`once`/`off`, `emit`,
 * `close` — and reconnects with backoff.
 *
 * Events: "init-room", "first-in-room", "new-user", "room-user-change",
 * "client-broadcast", "user-follow-room-change", plus local "connect",
 * "reconnect", "disconnect" and "connect_error".
 */
import { WS_EVENTS } from "../app_constants";

type Listener = (...args: any[]) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const PING_INTERVAL_MS = 25_000;

const FLAG_VOLATILE = 1;
const FLAG_FOLLOWERS = 2;

const randomSocketId = () => {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
};

export class CollabSocket {
  /** chosen by the client so it stays the same across reconnects */
  id: string;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private initialized = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private url: string) {
    this.id = randomSocketId();
    // let callers attach listeners before the first event
    setTimeout(() => this.connect(), 0);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // events ----------------------------------------------------------------------

  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    // so `off(event, listener)` also removes the wrapper
    (wrapped as any).original = listener;
    return this.on(event, wrapped);
  }

  off(event: string, listener?: Listener) {
    const set = this.listeners.get(event);
    if (!set) {
      return this;
    }
    if (!listener) {
      this.listeners.delete(event);
      return this;
    }
    for (const registered of set) {
      if (
        registered === listener ||
        (registered as any).original === listener
      ) {
        set.delete(registered);
      }
    }
    return this;
  }

  private dispatch(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) || [])]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  }

  // outgoing --------------------------------------------------------------------

  emit(event: string, ...args: any[]) {
    switch (event) {
      case "join-room":
        return this.sendJSON({ type: "join-room" });
      case WS_EVENTS.SERVER:
      case WS_EVENTS.SERVER_VOLATILE: {
        const [roomId, encryptedBuffer, iv] = args as [
          string,
          ArrayBuffer,
          Uint8Array,
        ];
        let flags = event === WS_EVENTS.SERVER_VOLATILE ? FLAG_VOLATILE : 0;
        if (typeof roomId === "string" && roomId.startsWith("follow@")) {
          flags |= FLAG_FOLLOWERS;
        }
        const data = new Uint8Array(encryptedBuffer);
        const frame = new Uint8Array(2 + iv.byteLength + data.byteLength);
        frame[0] = flags;
        frame[1] = iv.byteLength;
        frame.set(iv, 2);
        frame.set(data, 2 + iv.byteLength);
        return this.send(frame);
      }
      case WS_EVENTS.USER_FOLLOW_CHANGE:
        return this.sendJSON({ type: "user-follow", payload: args[0] });
      default:
        console.warn(`[collab] unknown event emitted: ${event}`);
    }
  }

  private sendJSON(message: unknown) {
    this.send(JSON.stringify(message));
  }

  private send(data: string | Uint8Array) {
    // like socket.io's volatile emits, messages are dropped while offline;
    // the full scene is re-broadcast on reconnect
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // connection ----------------------------------------------------------------

  private connect() {
    if (this.closed) {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url}?sid=${encodeURIComponent(this.id)}`);
    } catch (error) {
      this.dispatch("connect_error", error);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => this.onMessage(event.data);

    ws.onclose = () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.ws === ws) {
        this.ws = null;
      }
      if (this.closed) {
        return;
      }
      if (this.initialized) {
        this.dispatch("disconnect");
      } else {
        this.dispatch(
          "connect_error",
          new Error("Couldn't connect to the collaboration server"),
        );
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt++,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay * (0.75 + Math.random() * 0.5));
  }

  private onMessage(data: unknown) {
    if (typeof data === "string") {
      if (data === "pong") {
        return;
      }
      let message: any;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      switch (message?.type) {
        case "init-room": {
          if (typeof message.socketId === "string") {
            this.id = message.socketId;
          }
          const isReconnect = this.initialized;
          this.initialized = true;
          this.dispatch("connect");
          this.dispatch("init-room");
          if (isReconnect) {
            this.dispatch("reconnect");
          }
          return;
        }
        case "first-in-room":
          return this.dispatch("first-in-room");
        case "new-user":
          return this.dispatch("new-user", message.socketId);
        case "room-user-change":
          return this.dispatch("room-user-change", message.clients || []);
        case "user-follow-room-change":
          return this.dispatch(
            WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
            message.followedBy || [],
          );
      }
      return;
    }

    if (data instanceof ArrayBuffer && data.byteLength > 2) {
      const bytes = new Uint8Array(data);
      const ivLength = bytes[1];
      if (data.byteLength < 2 + ivLength) {
        return;
      }
      const iv = bytes.slice(2, 2 + ivLength);
      const encrypted = data.slice(2 + ivLength);
      this.dispatch("client-broadcast", encrypted, iv);
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close(1000, "Bye");
    }
    this.listeners.clear();
  }
}
