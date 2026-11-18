/**
 * Location of the Cloudflare collaboration worker (see /collab-worker), which
 * relays live-collaboration messages and stores rooms, shareable links and
 * their image files — all end-to-end encrypted by the app.
 */

const WORKER_URL = (import.meta.env.VITE_APP_COLLAB_WORKER_URL || "")
  .trim()
  .replace(/\/+$/, "");

export const isCollabWorkerConfigured = () => !!WORKER_URL;

export const getCollabWorkerUrl = () => {
  if (!WORKER_URL) {
    throw new Error(
      "The collaboration server isn't configured (set VITE_APP_COLLAB_WORKER_URL).",
    );
  }
  return WORKER_URL;
};

export const getRoomWebSocketUrl = (roomId: string) =>
  `${getCollabWorkerUrl().replace(/^http/, "ws")}/rooms/${encodeURIComponent(
    roomId,
  )}/ws`;

/**
 * Maps the storage prefixes the app has always used
 * (`/files/rooms/<roomId>`, `/files/shareLinks/<id>`) to worker paths.
 */
export const getFilesUrl = (prefix: string) => {
  const match = prefix
    .replace(/^\/+/, "")
    .match(/^files\/(rooms|shareLinks)\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) {
    throw new Error(`Unknown file storage prefix: ${prefix}`);
  }
  const [, kind, id] = match;
  return `${getCollabWorkerUrl()}/${
    kind === "rooms" ? "rooms" : "shares"
  }/${id}/files`;
};

export const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};
