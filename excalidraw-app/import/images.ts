/**
 * Turns document images (embedded bytes, data: URLs, web URLs or files dropped
 * alongside a Markdown file) into canvas-ready data URLs, downscaling big
 * photos so pages stay small enough to sync quickly.
 */
import { IMAGE_MIME_TYPES } from "@excalidraw/common";
import {
  generateIdFromFile,
  getDataURL,
} from "@excalidraw/excalidraw/data/blob";

import type { DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import type { DocImage } from "./docModel";

export type LoadedImage = {
  id: FileId;
  dataURL: DataURL;
  mimeType: string;
  width: number;
  height: number;
};

const MAX_DIMENSION = 1600;
const MAX_BYTES = 1.5 * 1024 * 1024;
const FETCH_TIMEOUT = 10_000;

const SUPPORTED = new Set<string>(Object.values(IMAGE_MIME_TYPES));

const isJsdom = () =>
  typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

const guessMime = (name: string) =>
  MIME_BY_EXTENSION[
    name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || ""
  ];

const naturalSize = (url: string) =>
  new Promise<{ width: number; height: number; img: HTMLImageElement } | null>(
    (resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), FETCH_TIMEOUT);
      img.onload = () => {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth, height: img.naturalHeight, img });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    },
  );

const downscale = async (
  img: HTMLImageElement,
  width: number,
  height: number,
  mimeType: string,
) => {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = mimeType === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, 0.85),
  );
  return blob ? { blob, width: canvas.width, height: canvas.height } : null;
};

const prepare = async (
  blob: Blob,
  mimeType: string,
  hint: { width?: number; height?: number },
): Promise<LoadedImage | null> => {
  if (!SUPPORTED.has(mimeType)) {
    return null;
  }
  let finalBlob = new File([blob], "image", { type: mimeType });
  let width = hint.width || 0;
  let height = hint.height || 0;

  if (typeof Image !== "undefined" && !isJsdom()) {
    const url = URL.createObjectURL(finalBlob);
    try {
      const size = await naturalSize(url);
      if (!size) {
        return null; // the browser can't decode it
      }
      if (size.width && size.height) {
        width = size.width;
        height = size.height;
        const isRaster =
          mimeType !== "image/svg+xml" && mimeType !== "image/gif";
        if (
          isRaster &&
          (Math.max(width, height) > MAX_DIMENSION || blob.size > MAX_BYTES)
        ) {
          const smaller = await downscale(size.img, width, height, mimeType);
          if (smaller && smaller.blob.size < blob.size) {
            finalBlob = new File([smaller.blob], "image", {
              type: smaller.blob.type,
            });
            mimeType = smaller.blob.type;
          }
        }
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!width || !height) {
    width = width || 480;
    height = height || Math.round((width * 2) / 3);
  }

  return {
    id: await generateIdFromFile(finalBlob),
    dataURL: await getDataURL(finalBlob),
    mimeType,
    width,
    height,
  };
};

const fetchBlob = async (url: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.blob() : null;
  } catch {
    return null; // offline, CORS…
  } finally {
    clearTimeout(timer);
  }
};

/**
 * @param assets files picked/dropped together with the document, matched by
 *               name for relative image paths in Markdown
 */
export const loadDocImage = async (
  image: DocImage,
  assets: ReadonlyMap<string, File> = new Map(),
): Promise<LoadedImage | null> => {
  const hint = { width: image.width, height: image.height };
  try {
    if (image.data) {
      return await prepare(
        new Blob([image.data.bytes as BlobPart], { type: image.data.mimeType }),
        image.data.mimeType,
        hint,
      );
    }
    const src = image.src?.trim();
    if (!src) {
      return null;
    }
    if (/^(data:|https?:)/i.test(src)) {
      if (isJsdom() && !src.startsWith("data:")) {
        return null;
      }
      const blob = await fetchBlob(src);
      if (!blob) {
        return null;
      }
      const mimeType = SUPPORTED.has(blob.type) ? blob.type : guessMime(src);
      return mimeType ? await prepare(blob, mimeType, hint) : null;
    }
    let name = src.split(/[?#]/)[0].split("/").pop() || "";
    try {
      name = decodeURIComponent(name);
    } catch {}
    const file = assets.get(name.toLowerCase());
    if (!file) {
      return null;
    }
    const mimeType = SUPPORTED.has(file.type) ? file.type : guessMime(name);
    return mimeType ? await prepare(file, mimeType, hint) : null;
  } catch (error) {
    console.warn("Couldn't load document image", image.src, error);
    return null;
  }
};
