export const LIMITS = {
  /** encrypted room scene */
  sceneBytes: 25 * 1024 * 1024,
  /** one encrypted image file (the app caps uploads at 4MiB before encoding) */
  fileBytes: 12 * 1024 * 1024,
  /** encrypted shareable-link payload */
  shareBytes: 25 * 1024 * 1024,
  /** one WebSocket message (full-scene broadcasts of big drawings) */
  messageBytes: 16 * 1024 * 1024,
};

export const RE_ROOM_ID = /^[A-Za-z0-9_-]{10,64}$/;
export const RE_SHARE_ID = /^[A-Za-z0-9_-]{10,64}$/;
export const RE_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const RE_SOCKET_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

export const errorResponse = (error: unknown) => {
  if (error instanceof HttpError) {
    return json({ error: error.message, ...error.extra }, error.status);
  }
  console.error(error);
  return json({ error: "Internal error" }, 500);
};

/** reads the body, rejecting anything over `maxBytes` (413) */
export const readBody = async (
  request: Request,
  maxBytes: number,
  extra?: Record<string, unknown>,
): Promise<ArrayBuffer> => {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) {
    throw new HttpError(413, `Payload is longer than ${maxBytes} bytes`, extra);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new HttpError(413, `Payload is longer than ${maxBytes} bytes`, extra);
  }
  return body;
};

export const binary = (data: Uint8Array, headers: HeadersInit = {}) =>
  new Response(data, {
    headers: { "Content-Type": "application/octet-stream", ...headers },
  });

export const randomId = (length = 20) => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 62 doesn't divide 256 evenly — the tiny bias is irrelevant for ids
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};

export const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};
