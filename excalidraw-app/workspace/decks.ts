/**
 * Decks in the workspace: read the source pages, combine them with
 * `buildDeck`, and save the result as a new page — or rebuild the open deck.
 */
import {
  CaptureUpdateAction,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { buildDeck, getDeckMeta } from "../slides/deck";

import { workspaceApi } from "./api";
import { parseScene, workspace } from "./workspace";

import type { DeckSource } from "../slides/deck";

/** reads each source page; one that can't be read is kept as missing */
const loadSources = (sources: readonly { name: string; path: string }[]) =>
  Promise.all(
    sources.map(async (source) => {
      try {
        const scene = parseScene(
          (await workspaceApi.readFile(source.path)).text,
        );
        return {
          ...source,
          elements: scene.elements,
          files: scene.files,
          background: scene.appState.viewBackgroundColor,
        };
      } catch {
        return { ...source, elements: null, files: null, background: null };
      }
    }),
  );

const describeSkipped = (deck: { missing: string[]; empty: string[] }) =>
  [
    deck.missing.length ? `missing: ${deck.missing.join(", ")}` : "",
    deck.empty.length ? `no slides: ${deck.empty.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

/** builds a deck from `sources` (in order) and opens it as a new page */
export const createDeckPage = async (opts: {
  name: string;
  parent: string;
  sources: { name: string; path: string }[];
  sections: boolean;
}) => {
  const loaded = await loadSources(opts.sources);
  const deck = buildDeck(loaded as DeckSource[], { sections: opts.sections });
  if (!deck.slideCount) {
    throw new Error(
      `The picked pages have no slides (frames) to combine${
        describeSkipped(deck) ? ` (${describeSkipped(deck)})` : ""
      }.`,
    );
  }
  const text = serializeAsJSON(
    deck.elements,
    {
      viewBackgroundColor:
        loaded.find((source) => source.background)?.background || "#ffffff",
    },
    deck.files,
    "local",
  );
  const path = await workspace.createPage(opts.parent, opts.name, text);
  return { path, deck, skipped: describeSkipped(deck) };
};

/**
 * Rebuilds the open deck from the current source pages, in its recorded
 * order. Edits made inside the deck are replaced; ⌘Z brings them back.
 */
export const refreshDeck = async (api: ExcalidrawImperativeAPI) => {
  const meta = getDeckMeta(api.getSceneElements());
  if (!meta) {
    throw new Error("This page isn't a deck.");
  }
  const page = workspace.getCurrentPath();
  const loaded = await loadSources(meta.sources);
  if (workspace.getCurrentPath() !== page) {
    throw new Error("The page changed before the deck was rebuilt.");
  }
  const deck = buildDeck(loaded as DeckSource[], { sections: meta.sections });
  api.updateScene({
    elements: restoreElements(deck.elements, null, { repairBindings: true }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  const files = Object.values(deck.files) as BinaryFileData[];
  if (files.length) {
    api.addFiles(files);
  }
  return { deck, skipped: describeSkipped(deck) };
};
