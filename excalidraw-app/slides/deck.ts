/**
 * Decks: several pages combined into one page of slides, in a chosen order.
 *
 * `buildDeck` copies every slide (frame) of each source page, with everything
 * inside it, into one scene: one row per source, every id new, every reference
 * remapped, and `customData.slideIndex` running 0..N-1 across the deck. The
 * deck remembers its sources on a small locked note above the slides
 * (`customData.deck`), so it can be rebuilt ("refreshed") later. Element
 * `customData` is the scene-level data that survives the workspace's autosave
 * (`serializeAsJSON` keeps only elements, a few appState keys and files),
 * restore, undo and collaboration.
 *
 * No editor imports: the app and scripts share it.
 */
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  ExcalidrawTextElement,
  FileId,
} from "@excalidraw/element/types";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Radians } from "@excalidraw/math";

import { getSlides, slideName } from "./order";

import type { Slide } from "./order";

export const DECK_VERSION = 1;

export type DeckSourceRef = {
  /** label shown on the deck's slides, e.g. "SDK" */
  name: string;
  /** the source page, as a workspace path; defaults to `name` */
  path?: string;
};

export type DeckMeta = {
  version: typeof DECK_VERSION;
  sources: { name: string; path: string }[];
  /** a plain section slide before each source */
  sections: boolean;
};

export type DeckSource = DeckSourceRef & {
  /** `null` when the page couldn't be read: recorded, but no slides */
  elements: readonly ExcalidrawElement[] | null;
  files?: BinaryFiles | null;
};

export type Deck = {
  elements: ExcalidrawElement[];
  files: BinaryFiles;
  meta: DeckMeta;
  slideCount: number;
  /** sources that couldn't be read */
  missing: string[];
  /** sources without slides */
  empty: string[];
};

export type BuildDeckOptions = {
  sections?: boolean;
  /** id generator (tests pass a deterministic one) */
  newId?: () => string;
  /** `updated` timestamp for the elements the deck adds */
  now?: number;
};

const ROW_GAP = 400;
const SECTION_GAP = 400;
const NOTE_GAP = 200;
const DEFAULT_SLIDE = { width: 1280, height: 720 };
/** advance width of a monospace glyph, in em (JetBrains Mono, Cascadia) */
const CHAR_WIDTH = 0.6;

const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";

export const randomDeckId = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(21));
  let id = "";
  for (const byte of bytes) {
    id += ID_ALPHABET[byte & 63];
  }
  return id;
};

/** stable small integer from a string (seeds of the elements the deck adds) */
const hashOf = (text: string) => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
};

const sourcePath = (source: DeckSourceRef) => source.path ?? source.name;

/** "1 page", "7 pages" */
export const pageCount = (count: number) =>
  `${count} page${count === 1 ? "" : "s"}`;

const mostCommon = <T>(values: T[], fallback: T): T => {
  const counts = new Map<T, number>();
  let best = fallback;
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

/** the deck's sources, if `elements` is a deck */
export const getDeckMeta = (
  elements: readonly ExcalidrawElement[],
): DeckMeta | null => {
  for (const el of elements) {
    const deck = el.customData?.deck;
    if (
      !el.isDeleted &&
      deck?.version === DECK_VERSION &&
      Array.isArray(deck.sources) &&
      deck.sources.every(
        (s: any) => typeof s?.name === "string" && typeof s?.path === "string",
      )
    ) {
      return {
        version: DECK_VERSION,
        sources: deck.sources.map((s: any) => ({ name: s.name, path: s.path })),
        sections: !!deck.sections,
      };
    }
  }
  return null;
};

// copying one source ----------------------------------------------------------

type Copied = {
  elements: ExcalidrawElement[];
  files: BinaryFiles;
  /** old frame id → new frame id */
  frames: Map<string, string>;
};

/**
 * Copies the slides of one source and everything in them, moved by (dx, dy).
 * Ids, groups and files get new ids, and references are remapped; references
 * to anything left behind (outside every slide) are dropped.
 */
const copySlides = (
  source: DeckSource,
  slides: readonly Slide[],
  dx: number,
  dy: number,
  newId: () => string,
): Copied => {
  const all = (source.elements || []).filter((el) => !el.isDeleted);
  const slideIds = new Set(slides.map((s) => s.id));
  const inSlide = new Set(
    all
      .filter(
        (el) =>
          slideIds.has(el.id) ||
          (el.frameId !== null && slideIds.has(el.frameId)),
      )
      .map((el) => el.id),
  );
  const byId = new Map(all.map((el) => [el.id, el]));
  // labels follow their container even without a frameId of their own
  const kept = all.filter(
    (el) =>
      inSlide.has(el.id) ||
      (el.type === "text" && !!el.containerId && inSlide.has(el.containerId)),
  );

  const ids = new Map(kept.map((el) => [el.id, newId()]));
  const groups = new Map<string, string>();
  const fileIds = new Map<string, FileId>();
  const files: BinaryFiles = {};

  const groupId = (id: string) => {
    if (!groups.has(id)) {
      groups.set(id, newId());
    }
    return groups.get(id)!;
  };
  const fileId = (id: FileId) => {
    if (!fileIds.has(id)) {
      const next = newId() as FileId;
      fileIds.set(id, next);
      const file = source.files?.[id];
      if (file) {
        files[next] = { ...file, id: next };
      }
    }
    return fileIds.get(id)!;
  };
  const binding = (value: any) =>
    value && ids.has(value.elementId)
      ? { ...value, elementId: ids.get(value.elementId) }
      : null;
  const frameOf = (el: ExcalidrawElement): string | null => {
    if (el.frameId !== null && slideIds.has(el.frameId)) {
      return ids.get(el.frameId)!;
    }
    if (el.type === "text" && el.containerId) {
      const container = byId.get(el.containerId);
      return container ? frameOf(container) : null;
    }
    return null;
  };

  const elements = kept.map((el) => {
    const copy: Record<string, any> = {
      ...el,
      id: ids.get(el.id),
      x: el.x + dx,
      y: el.y + dy,
      index: null,
      frameId: el.type === "frame" ? null : frameOf(el),
      groupIds: el.groupIds.map(groupId),
      boundElements: el.boundElements
        ? el.boundElements
            .filter((bound) => ids.has(bound.id))
            .map((bound) => ({ ...bound, id: ids.get(bound.id)! }))
        : el.boundElements,
    };
    if ("containerId" in el) {
      copy.containerId =
        el.containerId && ids.has(el.containerId)
          ? ids.get(el.containerId)
          : null;
    }
    if ("startBinding" in el) {
      copy.startBinding = binding(el.startBinding);
      copy.endBinding = binding(el.endBinding);
    }
    if (el.type === "image" && el.fileId) {
      copy.fileId = fileId(el.fileId);
    }
    return copy as ExcalidrawElement;
  });

  const frames = new Map(slides.map((s) => [s.id, ids.get(s.id)!]));
  return { elements, files, frames };
};

// elements the deck adds ------------------------------------------------------

type TextStyle = {
  fontFamily: ExcalidrawTextElement["fontFamily"];
  lineHeight: ExcalidrawTextElement["lineHeight"];
  strokeColor: string;
  roughness: number;
};

const textStyleOf = (sources: readonly DeckSource[]): TextStyle => {
  const live = sources
    .flatMap((s) => s.elements || [])
    .filter((el) => !el.isDeleted);
  const texts = live.filter(
    (el): el is ExcalidrawTextElement => el.type === "text",
  );
  const fontFamily = mostCommon(
    texts.map((t) => t.fontFamily),
    5 as ExcalidrawTextElement["fontFamily"],
  );
  const sameFont = texts.filter((t) => t.fontFamily === fontFamily);
  return {
    fontFamily,
    lineHeight: mostCommon(
      sameFont.map((t) => t.lineHeight),
      1.25 as ExcalidrawTextElement["lineHeight"],
    ),
    strokeColor: mostCommon(
      texts.map((t) => t.strokeColor),
      "#1e1e1e",
    ),
    roughness: mostCommon(
      live.map((el) => el.roughness),
      0,
    ),
  };
};

const baseProps = (id: string, now: number, style: TextStyle) => ({
  id,
  angle: 0 as Radians,
  strokeColor: style.strokeColor,
  backgroundColor: "transparent",
  fillStyle: "solid" as const,
  strokeWidth: 1,
  strokeStyle: "solid" as const,
  roughness: style.roughness,
  opacity: 100,
  groupIds: [],
  index: null,
  roundness: null,
  seed: hashOf(id),
  version: 1,
  versionNonce: hashOf(`${id}:nonce`),
  isDeleted: false,
  boundElements: null,
  updated: now,
  created: null,
  link: null,
  locked: false,
});

const newText = (opts: {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  textAlign: "left" | "center";
  frameId: string | null;
  color?: string;
  style: TextStyle;
  now: number;
}): ExcalidrawTextElement => {
  const lines = opts.text.split("\n");
  const width =
    Math.max(...lines.map((line) => line.length)) * opts.fontSize * CHAR_WIDTH;
  return {
    ...baseProps(opts.id, opts.now, opts.style),
    strokeColor: opts.color ?? opts.style.strokeColor,
    type: "text",
    x: opts.textAlign === "center" ? opts.x - width / 2 : opts.x,
    y: opts.y,
    width,
    height: lines.length * opts.fontSize * opts.style.lineHeight,
    frameId: opts.frameId,
    text: opts.text,
    originalText: opts.text,
    fontSize: opts.fontSize,
    fontFamily: opts.style.fontFamily,
    baseFontSize: null,
    textAlign: opts.textAlign,
    verticalAlign: "top",
    containerId: null,
    lineHeight: opts.style.lineHeight,
    autoResize: true,
  } as ExcalidrawTextElement;
};

const MUTED = "#868e96";

/** a plain slide that opens one source: "Part 2 of 7" and its name */
const sectionSlide = (opts: {
  name: string;
  part: number;
  parts: number;
  x: number;
  y: number;
  size: { width: number; height: number };
  slideIndex: number;
  newId: () => string;
  style: TextStyle;
  now: number;
}): ExcalidrawElement[] => {
  const { size, style, now } = opts;
  const frameId = opts.newId();
  const frame = {
    ...baseProps(frameId, now, style),
    strokeWidth: 2,
    type: "frame",
    x: opts.x,
    y: opts.y,
    width: size.width,
    height: size.height,
    frameId: null,
    name: opts.name,
    customData: { slideIndex: opts.slideIndex, deckSection: true },
  } as ExcalidrawFrameElement;
  const nameSize = Math.max(
    24,
    Math.min(
      96,
      Math.floor((size.width * 0.8) / (opts.name.length * CHAR_WIDTH)),
    ),
  );
  const partSize = Math.max(16, Math.round(nameSize / 3));
  const blockHeight = (partSize + nameSize) * style.lineHeight + 24;
  const top = opts.y + (size.height - blockHeight) / 2;
  const centerX = opts.x + size.width / 2;
  return [
    frame,
    newText({
      id: opts.newId(),
      x: centerX,
      y: top,
      text: `Part ${opts.part} of ${opts.parts}`,
      fontSize: partSize,
      textAlign: "center",
      frameId,
      color: MUTED,
      style,
      now,
    }),
    newText({
      id: opts.newId(),
      x: centerX,
      y: top + partSize * style.lineHeight + 24,
      text: opts.name,
      fontSize: nameSize,
      textAlign: "center",
      frameId,
      style,
      now,
    }),
  ];
};

/** the locked note above the slides that records the deck's sources */
const deckNote = (opts: {
  meta: DeckMeta;
  missing: string[];
  empty: string[];
  x: number;
  bottom: number;
  newId: () => string;
  style: TextStyle;
  now: number;
}) => {
  const lines = [
    `Deck of ${pageCount(opts.meta.sources.length)}, in this order:`,
    ...opts.meta.sources.map((source, i) => {
      const flag = opts.missing.includes(source.path)
        ? " (missing)"
        : opts.empty.includes(source.path)
        ? " (no slides)"
        : "";
      return `${i + 1}. ${source.name} · ${source.path}${flag}`;
    }),
    `Pages sidebar → "Refresh deck from sources" rebuilds it.`,
  ];
  const fontSize = 20;
  const note = newText({
    id: opts.newId(),
    x: opts.x,
    y: 0,
    text: lines.join("\n"),
    fontSize,
    textAlign: "left",
    frameId: null,
    color: MUTED,
    style: opts.style,
    now: opts.now,
  });
  return {
    ...note,
    y: opts.bottom - note.height,
    locked: true,
    customData: { deck: opts.meta },
  } as ExcalidrawTextElement;
};

// the deck --------------------------------------------------------------------

const slideSize = (slides: readonly Slide[]) => {
  const key = mostCommon(
    slides.map((s) => `${s.width}x${s.height}`),
    `${DEFAULT_SLIDE.width}x${DEFAULT_SLIDE.height}`,
  );
  const [width, height] = key.split("x").map(Number);
  return { width, height };
};

const boundsOf = (slides: readonly Slide[]) => ({
  minX: Math.min(...slides.map((s) => s.x)),
  minY: Math.min(...slides.map((s) => s.y)),
  maxX: Math.max(...slides.map((s) => s.x + s.width)),
  maxY: Math.max(...slides.map((s) => s.y + s.height)),
});

/**
 * Combines `sources` (in order) into one scene. Each source's slides keep
 * their layout and are moved into a row of their own; with `sections`, a
 * plain slide naming the source opens each row.
 */
export const buildDeck = (
  sources: readonly DeckSource[],
  opts: BuildDeckOptions = {},
): Deck => {
  const newId = opts.newId ?? randomDeckId;
  const now = opts.now ?? Date.now();
  const sections = !!opts.sections;
  const meta: DeckMeta = {
    version: DECK_VERSION,
    sources: sources.map((s) => ({ name: s.name, path: sourcePath(s) })),
    sections,
  };
  const missing = sources.filter((s) => !s.elements).map(sourcePath);
  const withSlides = sources
    .map((source) => ({ source, slides: getSlides(source.elements || []) }))
    .filter(({ slides }) => slides.length > 0);
  const empty = sources
    .filter((s) => s.elements && !getSlides(s.elements).length)
    .map(sourcePath);

  const style = textStyleOf(sources);
  const size = slideSize(withSlides.flatMap(({ slides }) => slides));
  const left = sections ? -(size.width + SECTION_GAP) : 0;

  const elements: ExcalidrawElement[] = [];
  const files: BinaryFiles = {};
  let slideIndex = 0;
  let top = 0;

  withSlides.forEach(({ source, slides }, part) => {
    if (sections) {
      elements.push(
        ...sectionSlide({
          name: source.name,
          part: part + 1,
          parts: withSlides.length,
          x: left,
          y: top,
          size,
          slideIndex: slideIndex++,
          newId,
          style,
          now,
        }),
      );
    }
    const bounds = boundsOf(slides);
    const copied = copySlides(
      source,
      slides,
      -bounds.minX,
      top - bounds.minY,
      newId,
    );
    const order = new Map(
      slides.map((slide, i) => [
        copied.frames.get(slide.id)!,
        {
          index: slideIndex + i,
          name: `${source.name} · ${slideName(slide, i)}`,
        },
      ]),
    );
    slideIndex += slides.length;
    for (const el of copied.elements) {
      const slide = order.get(el.id);
      elements.push(
        slide
          ? ({
              ...el,
              name: slide.name,
              customData: { ...el.customData, slideIndex: slide.index },
            } as ExcalidrawElement)
          : el,
      );
    }
    Object.assign(files, copied.files);
    top += Math.max(bounds.maxY - bounds.minY, sections ? size.height : 0);
    top += ROW_GAP;
  });

  const note = deckNote({
    meta,
    missing,
    empty,
    x: left,
    bottom: -NOTE_GAP,
    newId,
    style,
    now,
  });

  return {
    elements: [note, ...elements],
    files,
    meta,
    slideCount: slideIndex,
    missing,
    empty,
  };
};
