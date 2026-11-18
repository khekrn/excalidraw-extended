/**
 * Importing files as workspace pages (Word, Markdown, text, Excalidraw) and
 * dropping documents onto the canvas.
 */
import { viewportCoordsToSceneCoords } from "@excalidraw/common";
import { CaptureUpdateAction, serializeAsJSON } from "@excalidraw/excalidraw";
import {
  blobToArrayBuffer,
  loadFromBlob,
} from "@excalidraw/excalidraw/data/blob";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { workspace } from "../workspace/workspace";

import { parsePlainText } from "./docModel";
import { parseDocx } from "./docx";
import { loadDocImage } from "./images";
import { layoutDocument } from "./layout";
import { parseMarkdown } from "./markdown";

import type { DocBlock } from "./docModel";

const DOCUMENT_EXTENSIONS = ["docx", "md", "markdown", "mdown", "mkd", "txt"];
const SCENE_EXTENSIONS = ["excalidraw", "json", "png", "svg"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];

/** `accept` for file pickers offering everything that can become a page */
export const PAGE_IMPORT_ACCEPT = [
  ...DOCUMENT_EXTENSIONS,
  ...SCENE_EXTENSIONS,
  // images only matter as assets of a Markdown file picked alongside
  ...IMAGE_EXTENSIONS,
]
  .map((ext) => `.${ext}`)
  .join(",");

export const DOCUMENT_ACCEPT = [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS]
  .map((ext) => `.${ext}`)
  .join(",");

const extensionOf = (name: string) =>
  name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";

/** Word, Markdown or plain-text documents (incl. legacy .doc, to explain) */
export const isDocumentFile = (file: File) =>
  [...DOCUMENT_EXTENSIONS, "doc"].includes(extensionOf(file.name)) ||
  file.type === "text/markdown";

const isImageFile = (file: File) =>
  IMAGE_EXTENSIONS.includes(extensionOf(file.name)) ||
  file.type.startsWith("image/");

const pageNameFor = (file: File) =>
  file.name.replace(/\.[^.]+$/, "").trim() || "Imported";

export const parseDocumentFile = async (file: File): Promise<DocBlock[]> => {
  const ext = extensionOf(file.name);
  if (ext === "doc") {
    throw new Error(
      `"${file.name}" is in the old Word format (.doc). Open it in Word, Pages or Google Docs and save it as .docx, then import that.`,
    );
  }
  const bytes = new Uint8Array(await blobToArrayBuffer(file));
  if (ext === "docx") {
    return parseDocx(bytes);
  }
  const text = new TextDecoder().decode(bytes);
  return ext === "txt" ? parsePlainText(text) : parseMarkdown(text);
};

const assetMap = (files: File[]) =>
  new Map(
    files.filter(isImageFile).map((file) => [file.name.toLowerCase(), file]),
  );

/** lays a document file out as canvas elements at the given scene position */
export const documentToElements = async (
  file: File,
  opts: { x?: number; y?: number; assets?: ReadonlyMap<string, File> } = {},
) => {
  const blocks = await parseDocumentFile(file);
  if (!blocks.length) {
    throw new Error(`"${file.name}" is empty`);
  }
  return layoutDocument(blocks, {
    x: opts.x,
    y: opts.y,
    loadImage: (image) => loadDocImage(image, opts.assets),
  });
};

/** the .excalidraw content of a new page made from a document */
export const documentToPageContent = async (
  file: File,
  assets?: ReadonlyMap<string, File>,
) => {
  const { elements, files } = await documentToElements(file, { assets });
  return serializeAsJSON(
    elements,
    { viewBackgroundColor: "#ffffff" },
    files,
    "local",
  );
};

const describeError = (file: File, error: any) =>
  `${file.name}: ${error?.message || "couldn't be imported"}`;

/**
 * Creates one page per file in `parent` and opens the first one. Images
 * picked/dropped along with Markdown files are used for its image links.
 */
export const importFilesAsPages = async (
  api: ExcalidrawImperativeAPI | null,
  files: File[],
  parent = "",
) => {
  const documents = files.filter(isDocumentFile);
  const assets = documents.length ? assetMap(files) : new Map<string, File>();
  const sources = files.filter(
    (file) =>
      isDocumentFile(file) ||
      (!assets.has(file.name.toLowerCase()) &&
        SCENE_EXTENSIONS.includes(extensionOf(file.name))),
  );
  if (!sources.length) {
    api?.setToast({
      message:
        "Nothing to import — pick Word (.docx), Markdown (.md), text or .excalidraw files.",
      closable: true,
    });
    return [];
  }

  const created: string[] = [];
  const failed: string[] = [];
  for (const file of sources) {
    if (sources.length > 1 || isDocumentFile(file)) {
      api?.setToast({ message: `Importing ${file.name}…`, duration: 60_000 });
    }
    try {
      let content: string;
      if (isDocumentFile(file)) {
        content = await documentToPageContent(file, assets);
      } else {
        const data = await loadFromBlob(file, null, null);
        content = serializeAsJSON(
          data.elements,
          data.appState,
          data.files,
          "local",
        );
      }
      const path = await workspace.createPage(
        parent,
        pageNameFor(file),
        content,
        { open: false },
      );
      if (path) {
        created.push(path);
      }
    } catch (error: any) {
      console.error(error);
      failed.push(describeError(file, error));
    }
  }

  if (created.length) {
    await workspace.openPage(created[0]);
  }
  if (failed.length) {
    api?.setToast({ message: failed.join("\n"), closable: true });
  } else if (created.length > 1) {
    api?.setToast({
      message: `Imported ${created.length} pages`,
      duration: 3000,
      closable: true,
    });
  } else {
    api?.setToast(null);
  }
  return created;
};

/**
 * Lays documents dropped on the canvas out at the drop point (stacked when
 * several), selected so they can be moved right away. Undoable.
 */
export const insertDocumentsIntoCanvas = async (
  api: ExcalidrawImperativeAPI,
  files: File[],
  point: { clientX: number; clientY: number },
) => {
  const documents = files.filter(isDocumentFile);
  const assets = assetMap(files);
  const appState = api.getAppState();
  let { x, y } = viewportCoordsToSceneCoords(point, appState);

  const added: ExcalidrawElement[] = [];
  const addedFiles: BinaryFileData[] = [];
  const failed: string[] = [];
  for (const file of documents) {
    api.setToast({ message: `Importing ${file.name}…`, duration: 60_000 });
    try {
      const result = await documentToElements(file, { x, y, assets });
      added.push(...result.elements);
      addedFiles.push(...Object.values(result.files));
      x += result.width + 120;
    } catch (error: any) {
      console.error(error);
      failed.push(describeError(file, error));
    }
  }

  if (added.length) {
    if (addedFiles.length) {
      api.addFiles(addedFiles);
    }
    const groupIds = new Set(added.flatMap((element) => element.groupIds));
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...added],
      appState: {
        selectedElementIds: Object.fromEntries(
          added.map((element) => [element.id, true as const]),
        ),
        selectedGroupIds: Object.fromEntries(
          [...groupIds].map((id) => [id, true]),
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  if (failed.length) {
    api.setToast({ message: failed.join("\n"), closable: true });
  } else {
    api.setToast(null);
  }
};

/** opens the system file picker */
export const pickFiles = (accept: string, multiple = true) =>
  new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    const done = (files: File[]) => {
      resolve(files);
      input.remove();
    };
    input.addEventListener("change", () => done(Array.from(input.files || [])));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    input.click();
  });

/** dragged data contains files (not a page/element drag) */
export const dragHasFiles = (dataTransfer: DataTransfer | null) =>
  !!dataTransfer && Array.from(dataTransfer.types).includes("Files");
