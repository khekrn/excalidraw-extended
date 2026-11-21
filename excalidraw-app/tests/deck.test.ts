import { restoreElements } from "@excalidraw/excalidraw";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { buildDeck, getDeckMeta } from "../slides/deck";
import { getSlides } from "../slides/order";

import type { DeckSource } from "../slides/deck";

// fixtures --------------------------------------------------------------------

const el = (props: Record<string, any>) =>
  ({
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    created: null,
    link: null,
    locked: false,
    width: 100,
    height: 40,
    ...props,
  } as unknown as ExcalidrawElement);

const frame = (id: string, x: number, y: number, extra = {}) =>
  el({ id, type: "frame", x, y, width: 400, height: 225, name: id, ...extra });

const text = (props: Record<string, any>) =>
  el({
    type: "text",
    text: "label",
    originalText: "label",
    fontSize: 20,
    fontFamily: 11,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: null,
    lineHeight: 1.32,
    autoResize: true,
    ...props,
  });

const arrow = (props: Record<string, any>) =>
  el({
    type: "arrow",
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
    ...props,
  });

const image = (props: Record<string, any>) =>
  el({ type: "image", status: "saved", scale: [1, 1], crop: null, ...props });

const fileData = (id: string) => ({
  id,
  mimeType: "image/png",
  dataURL: `data:image/png;base64,${id}`,
  created: 1,
});

/** two slides, given in reverse by `slideIndex`; bindings, a group, a file */
const alpha = (): DeckSource => ({
  name: "Alpha",
  path: "alpha.excalidraw",
  elements: [
    frame("fA1", 0, 0, { customData: { slideIndex: 1 } }),
    el({
      id: "r1",
      type: "rectangle",
      x: 20,
      y: 20,
      frameId: "fA1",
      groupIds: ["g1"],
      boundElements: [
        { id: "t1", type: "text" },
        { id: "a1", type: "arrow" },
      ],
    }),
    text({ id: "t1", x: 30, y: 30, frameId: "fA1", containerId: "r1" }),
    el({
      id: "r3",
      type: "rectangle",
      x: 20,
      y: 100,
      frameId: "fA1",
      groupIds: ["g1"],
    }),
    arrow({
      id: "a1",
      x: 120,
      y: 40,
      frameId: "fA1",
      startBinding: { elementId: "r1", focus: 0, gap: 4 },
      endBinding: { elementId: "outside", focus: 0, gap: 4 },
    }),
    el({
      id: "gone",
      type: "rectangle",
      x: 5,
      y: 5,
      frameId: "fA1",
      isDeleted: true,
    }),
    frame("fA2", 600, 0, { customData: { slideIndex: 0, note: "kept" } }),
    el({
      id: "r2",
      type: "rectangle",
      x: 620,
      y: 20,
      frameId: "fA2",
      boundElements: [{ id: "t3", type: "text" }],
    }),
    // a label without a frameId of its own follows its container
    text({ id: "t3", x: 630, y: 30, frameId: null, containerId: "r2" }),
    image({ id: "i1", x: 700, y: 100, frameId: "fA2", fileId: "file1" }),
    // outside every slide: left behind, with the references to it
    el({
      id: "outside",
      type: "rectangle",
      x: 2000,
      y: 0,
      boundElements: [{ id: "a1", type: "arrow" }],
    }),
    frame("fA3", 1200, 0, { isDeleted: true }),
  ],
  files: {
    file1: fileData("file1"),
    file2: fileData("file2"),
  } as unknown as BinaryFiles,
});

/** the same ids, group and file as alpha: they must not collide in the deck */
const beta = (): DeckSource => ({
  name: "Beta",
  path: "beta.excalidraw",
  elements: [
    frame("fB1", -50, 300),
    el({
      id: "r1",
      type: "rectangle",
      x: -30,
      y: 320,
      frameId: "fB1",
      groupIds: ["g1"],
    }),
    image({ id: "i1", x: 0, y: 400, frameId: "fB1", fileId: "file1" }),
  ],
  files: { file1: fileData("file1") } as unknown as BinaryFiles,
});

const missing = (): DeckSource => ({
  name: "Gamma",
  path: "gamma.excalidraw",
  elements: null,
});

const noSlides = (): DeckSource => ({
  name: "Delta",
  path: "delta.excalidraw",
  elements: [el({ id: "lonely", type: "rectangle", x: 0, y: 0 })],
});

const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

// helpers ---------------------------------------------------------------------

const live = (elements: readonly ExcalidrawElement[]) =>
  elements.filter((e) => !e.isDeleted);

/** the copy of `sourceId` in the deck, found through its frame's name */
const copyOf = (
  elements: readonly ExcalidrawElement[],
  frameName: string,
  pick: (e: any) => boolean,
) => {
  const f = elements.find(
    (e) => e.type === "frame" && (e as any).name === frameName,
  )!;
  expect(f).toBeTruthy();
  const found = elements.filter((e) => e.frameId === f.id && pick(e));
  expect(found).toHaveLength(1);
  return found[0] as any;
};

const overlaps = (a: ExcalidrawElement, b: ExcalidrawElement) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

// tests -----------------------------------------------------------------------

describe("buildDeck", () => {
  it("orders slides across sources and prefixes their names", () => {
    const deck = buildDeck([alpha(), beta()], { newId: counter() });
    const slides = getSlides(deck.elements);
    expect(slides.map((s) => s.name)).toEqual([
      "Alpha · fA2",
      "Alpha · fA1",
      "Beta · fB1",
    ]);
    expect(slides.map((s) => s.customData?.slideIndex)).toEqual([0, 1, 2]);
    expect(deck.slideCount).toBe(3);
    // other customData survives
    expect(slides[0].customData?.note).toBe("kept");
  });

  it("gives every element a new, unique id", () => {
    const deck = buildDeck([alpha(), beta()], { newId: counter() });
    const ids = deck.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sourceIds = new Set(
      [...alpha().elements!, ...beta().elements!].map((e) => e.id),
    );
    expect(ids.filter((id) => sourceIds.has(id))).toEqual([]);
  });

  it("copies each slide's children, and only them", () => {
    const deck = buildDeck([alpha(), beta()], { newId: counter() });
    const frames = new Map(
      deck.elements.filter((e) => e.type === "frame").map((f) => [f.id, f]),
    );
    const children = deck.elements.filter(
      (e) => e.type !== "frame" && !e.customData?.deck,
    );
    // r1 t1 r3 a1 | r2 t3 i1 | r1 i1 — no deleted, outside or loose elements
    expect(children).toHaveLength(9);
    for (const child of children) {
      expect(frames.has(child.frameId!)).toBe(true);
    }
    // the label without a frameId joined its container's slide
    const r2 = copyOf(
      deck.elements,
      "Alpha · fA2",
      (e) => e.type === "rectangle",
    );
    const t3 = deck.elements.find((e: any) => e.containerId === r2.id)!;
    expect(t3.frameId).toBe(r2.frameId);
  });

  it("remaps bindings and drops references to what was left behind", () => {
    const deck = buildDeck([alpha()], { newId: counter() });
    const r1 = copyOf(
      deck.elements,
      "Alpha · fA1",
      (e) => e.type === "rectangle" && e.boundElements?.length,
    );
    const t1 = copyOf(deck.elements, "Alpha · fA1", (e) => e.type === "text");
    const a1 = copyOf(deck.elements, "Alpha · fA1", (e) => e.type === "arrow");
    expect(r1.boundElements).toEqual([
      { id: t1.id, type: "text" },
      { id: a1.id, type: "arrow" },
    ]);
    expect(t1.containerId).toBe(r1.id);
    expect(a1.startBinding).toEqual({ elementId: r1.id, focus: 0, gap: 4 });
    expect(a1.endBinding).toBeNull();
  });

  it("gives groups new ids, per source", () => {
    const deck = buildDeck([alpha(), beta()], { newId: counter() });
    const grouped = deck.elements.filter((e) => e.groupIds.length);
    const alphaGroups = grouped
      .filter((e) => e.type === "rectangle" && e.y < 300)
      .map((e) => e.groupIds[0]);
    const betaGroups = grouped
      .filter((e) => e.y >= 300)
      .map((e) => e.groupIds[0]);
    expect(alphaGroups).toHaveLength(2);
    expect(new Set(alphaGroups).size).toBe(1);
    expect(betaGroups).toHaveLength(1);
    expect(alphaGroups[0]).not.toBe("g1");
    expect(betaGroups[0]).not.toBe(alphaGroups[0]);
  });

  it("gives files new ids and copies only the ones in use", () => {
    const deck = buildDeck([alpha(), beta()], { newId: counter() });
    const images = deck.elements.filter(
      (e: any) => e.type === "image",
    ) as any[];
    expect(images).toHaveLength(2);
    expect(images[0].fileId).not.toBe(images[1].fileId);
    expect(Object.keys(deck.files).sort()).toEqual(
      images.map((i) => i.fileId).sort(),
    );
    for (const [id, file] of Object.entries(deck.files)) {
      expect(file.id).toBe(id);
      expect(file.dataURL).toBe("data:image/png;base64,file1");
    }
  });

  it("lays sources out in rows, with no two slides overlapping", () => {
    const deck = buildDeck([alpha(), beta()], {
      newId: counter(),
      sections: true,
    });
    const slides = getSlides(deck.elements);
    for (let i = 0; i < slides.length; i++) {
      for (let j = i + 1; j < slides.length; j++) {
        expect(overlaps(slides[i], slides[j])).toBe(false);
      }
    }
    const alphaBottom = Math.max(
      ...slides
        .filter((s) => s.name?.startsWith("Alpha"))
        .map((s) => s.y + s.height),
    );
    const betaTop = Math.min(
      ...slides.filter((s) => s.name?.startsWith("Beta")).map((s) => s.y),
    );
    expect(betaTop).toBeGreaterThan(alphaBottom);
    // children keep their place inside their slide
    const fA1 = slides.find((s) => s.name === "Alpha · fA1")!;
    const r3 = copyOf(
      deck.elements,
      "Alpha · fA1",
      (e) => e.type === "rectangle" && !e.boundElements,
    );
    expect([r3.x - fA1.x, r3.y - fA1.y]).toEqual([20, 100]);
  });

  it("opens each source with a section slide when asked", () => {
    const deck = buildDeck([alpha(), beta()], {
      newId: counter(),
      sections: true,
    });
    const slides = getSlides(deck.elements);
    expect(slides.map((s) => s.name)).toEqual([
      "Alpha",
      "Alpha · fA2",
      "Alpha · fA1",
      "Beta",
      "Beta · fB1",
    ]);
    expect(slides.map((s) => s.customData?.slideIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    const texts = deck.elements.filter(
      (e) => e.frameId === slides[3].id,
    ) as any[];
    expect(texts.map((t) => t.text)).toEqual(["Part 2 of 2", "Beta"]);
    // the sources' font
    expect(texts.every((t) => t.fontFamily === 11)).toBe(true);
  });

  it("records its sources, the missing ones too, for a refresh", () => {
    const sources = [alpha(), missing(), noSlides(), beta()];
    const deck = buildDeck(sources, { newId: counter(), sections: true });
    expect(deck.missing).toEqual(["gamma.excalidraw"]);
    expect(deck.empty).toEqual(["delta.excalidraw"]);
    expect(getDeckMeta(deck.elements)).toEqual({
      version: 1,
      sections: true,
      sources: [
        { name: "Alpha", path: "alpha.excalidraw" },
        { name: "Gamma", path: "gamma.excalidraw" },
        { name: "Delta", path: "delta.excalidraw" },
        { name: "Beta", path: "beta.excalidraw" },
      ],
    });
    const note = deck.elements.find((e) => e.customData?.deck) as any;
    expect(note.frameId).toBeNull();
    expect(note.locked).toBe(true);
    expect(note.text).toContain("gamma.excalidraw (missing)");
    // the note sits above every slide
    const top = Math.min(...getSlides(deck.elements).map((s) => s.y));
    expect(note.y + note.height).toBeLessThan(top);
    expect(getDeckMeta(alpha().elements!)).toBeNull();
  });

  it("leaves its sources untouched", () => {
    const sources = [alpha(), beta()];
    const before = JSON.stringify(sources);
    buildDeck(sources, { sections: true });
    expect(JSON.stringify(sources)).toBe(before);
  });

  it("survives the editor's restore with bindings and frames intact", () => {
    const deck = buildDeck([alpha(), beta()], { sections: true });
    const restored = live(
      restoreElements(deck.elements, null, { repairBindings: true }),
    );
    expect(restored).toHaveLength(deck.elements.length);
    const byId = new Map(restored.map((e) => [e.id, e]));
    for (const e of restored) {
      if (e.frameId) {
        expect(byId.get(e.frameId)?.type).toBe("frame");
      }
      for (const bound of e.boundElements || []) {
        expect(byId.has(bound.id)).toBe(true);
      }
    }
    expect(getSlides(restored).map((s) => s.customData?.slideIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it("takes a deck as a source, in the deck's own order", () => {
    const inner = buildDeck([alpha(), beta()], { sections: true });
    const outer = buildDeck([{ name: "Deck", elements: inner.elements }], {
      newId: counter(),
    });
    const slides = getSlides(outer.elements);
    expect(slides.map((s) => s.name)).toEqual([
      "Deck · Alpha",
      "Deck · Alpha · fA2",
      "Deck · Alpha · fA1",
      "Deck · Beta",
      "Deck · Beta · fB1",
    ]);
    expect(slides.map((s) => s.customData?.slideIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    // the inner deck's note is outside every slide: left behind
    expect(getDeckMeta(outer.elements)?.sources).toEqual([
      { name: "Deck", path: "Deck" },
    ]);
  });
});
