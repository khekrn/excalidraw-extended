/**
 * Room scene + image file storage on the Cloudflare collaboration worker
 * (see /collab-worker). Everything is encrypted here before upload with the
 * room/link key, which never leaves the browser.
 *
 * (The module keeps its historical name and exports — it used to talk to
 * Firebase — so callers don't need to change.)
 */
import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import {
  base64ToBytes,
  bytesToBase64,
  getCollabWorkerUrl,
  getFilesUrl,
} from "./collabWorker";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { CollabSocket } from "../collab/CollabSocket";

// -----------------------------------------------------------------------------
// room scene
// -----------------------------------------------------------------------------

type StoredScene = {
  sceneVersion: number;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
  /** storage revision, for optimistic concurrency */
  rev: number;
};

const MAX_SAVE_ATTEMPTS = 5;

const roomSceneUrl = (roomId: string) =>
  `${getCollabWorkerUrl()}/rooms/${encodeURIComponent(roomId)}/scene`;

const parseStoredScene = async (response: Response): Promise<StoredScene> => ({
  sceneVersion: Number(response.headers.get("x-scene-version") || 0),
  iv: base64ToBytes(
    response.headers.get("x-iv") || "",
  ) as Uint8Array<ArrayBuffer>,
  rev: Number(response.headers.get("x-rev") || 0),
  ciphertext: await response.arrayBuffer(),
});

const fetchStoredScene = async (roomId: string) => {
  const response = await fetch(roomSceneUrl(roomId), { cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Couldn't load the room (${response.status})`);
  }
  return parseStoredScene(response);
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
) => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { ciphertext: encryptedBuffer, iv, json };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(data.iv, data.ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class SceneVersionCache {
  private static cache = new WeakMap<CollabSocket, number>();
  static get = (socket: CollabSocket) => {
    return SceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: CollabSocket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return SceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

/**
 * Saves the room scene, reconciled with whatever is stored (another
 * collaborator may have saved in between — then we merge and retry).
 */
export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  let stored = await fetchStoredScene(roomId);

  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    let toStore = elements;
    if (stored) {
      const prevStoredElements = getSyncableElements(
        restoreElements(await decryptElements(stored, roomKey), null),
      );
      toStore = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }

    const { ciphertext, iv, json } = await encryptElements(roomKey, toStore);
    const response = await fetch(roomSceneUrl(roomId), {
      method: "PUT",
      body: ciphertext,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-iv": bytesToBase64(iv),
        "x-scene-version": String(getSceneVersion(toStore)),
        "x-expected-rev": String(stored?.rev ?? 0),
      },
    });

    if (response.status === 409) {
      // lost the race — reconcile with the newer version and try again
      stored = await parseStoredScene(response);
      continue;
    }
    if (response.status === 413) {
      const { error } = await response.json().catch(() => ({}));
      throw new Error(error || "Scene is longer than the allowed bytes");
    }
    if (!response.ok) {
      throw new Error(`Couldn't save the room (${response.status})`);
    }

    // what we stored, as stored (the in-memory elements may have mutated)
    const storedElements = getSyncableElements(
      restoreElements(JSON.parse(json), null),
    );
    SceneVersionCache.set(socket, storedElements);
    return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
  }

  throw new Error("Couldn't save the room: too many simultaneous updates");
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: CollabSocket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const stored = await fetchStoredScene(roomId);
  if (!stored) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(stored, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    SceneVersionCache.set(socket, elements);
  }

  return elements;
};

// -----------------------------------------------------------------------------
// image files
// -----------------------------------------------------------------------------

/**
 * Uploads encrypted files under a storage prefix (`/files/rooms/<roomId>` or
 * `/files/shareLinks/<id>`). Shareable links require the `token` returned
 * when the link was created.
 */
export const saveFilesToFirebase = async ({
  prefix,
  files,
  token,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
  token?: string;
}) => {
  // a missing/misconfigured server must fail the whole save rather than be
  // reported per file as `erroredFiles` (which share links ignore, and
  // collab never retries)
  const baseUrl = getFilesUrl(prefix);

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(`${baseUrl}/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: buffer as Uint8Array<ArrayBuffer>,
          headers: {
            "Content-Type": "application/octet-stream",
            ...(token ? { "x-share-token": token } : {}),
          },
        });
        if (response.ok) {
          savedFiles.push(id);
        } else {
          erroredFiles.push(id);
        }
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  let baseUrl: string;
  try {
    baseUrl = getFilesUrl(prefix);
  } catch (error) {
    console.error(error);
    for (const id of filesIds) {
      erroredFiles.set(id, true);
    }
    return { loadedFiles, erroredFiles };
  }

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(`${baseUrl}/${encodeURIComponent(id)}`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
