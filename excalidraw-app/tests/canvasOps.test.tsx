import React from "react";

import { resolvablePromise } from "@excalidraw/common";
import {
  Excalidraw,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { applyOps, describeScene } from "../ai/canvasOps";
import { buildPdf } from "../slides/pdf";
import { addSlide, deleteSlide, getSlides, moveSlide } from "../slides/slides";

import type { AIOp } from "../workspace/api";

const live = (api: ExcalidrawImperativeAPI) => api.getSceneElements() as any[];
const byId = (api: ExcalidrawImperativeAPI, id: string) =>
  live(api).find((el) => el.id === id);
const labelOf = (api: ExcalidrawImperativeAPI, id: string) => {
  const ref = byId(api, id)?.boundElements?.find((b: any) => b.type === "text");
  return ref ? byId(api, ref.id) : null;
};

describe("Claude canvas ops", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    const ready = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw onExcalidrawAPI={(a) => ready.resolve(a as any)} />,
    );
    api = await ready;
    act(() => {
      api.updateScene({
        elements: convertToExcalidrawElements(
          [
            {
              type: "rectangle",
              id: "box-a",
              x: 100,
              y: 100,
              width: 160,
              height: 80,
              label: { text: "Browser" },
            },
          ],
          { regenerateIds: false },
        ),
      });
    });
  });

  it("adds shapes and binds arrows to new and existing shapes", () => {
    // verbatim shape of a real Sonnet response
    const ops: AIOp[] = [
      {
        op: "add",
        elements: [
          {
            id: "api-box",
            type: "rectangle",
            x: 340,
            y: 100,
            width: 160,
            height: 80,
            label: { text: "API Server", fontSize: 20 },
            backgroundColor: "#a5d8ff",
            fillStyle: "solid",
            roundness: { type: 3 },
          },
          {
            id: "db-box",
            type: "ellipse",
            x: 580,
            y: 100,
            width: 160,
            height: 80,
            label: { text: "Database" },
          },
          {
            id: "arrow-browser-api",
            type: "arrow",
            x: 260,
            y: 140,
            points: [
              [0, 0],
              [80, 0],
            ],
            start: { id: "box-a" },
            end: { id: "api-box" },
          },
          {
            id: "arrow-api-db",
            type: "arrow",
            x: 500,
            y: 140,
            points: [
              [0, 0],
              [80, 0],
            ],
            start: { id: "api-box" },
            end: { id: "db-box" },
          },
        ],
      },
    ];

    let summary!: ReturnType<typeof applyOps>;
    act(() => {
      summary = applyOps(api, ops);
    });

    expect(summary.errors).toEqual([]);
    expect(summary.added).toBeGreaterThanOrEqual(4);
    expect(labelOf(api, "api-box")?.text).toBe("API Server");
    expect(labelOf(api, "db-box")?.text).toBe("Database");

    const arrow = byId(api, "arrow-browser-api");
    expect(arrow.startBinding?.elementId).toBe("box-a");
    expect(arrow.endBinding?.elementId).toBe("api-box");
    // the existing shape knows about the arrow bound to it
    expect(
      byId(api, "box-a").boundElements.some(
        (b: any) => b.id === "arrow-browser-api",
      ),
    ).toBe(true);
    // the existing label is untouched
    expect(labelOf(api, "box-a")?.text).toBe("Browser");
  });

  it("gives clashing ids fresh ones and keeps references working", () => {
    act(() => {
      applyOps(api, [
        {
          op: "add",
          elements: [
            { id: "box-a", type: "rectangle", x: 400, y: 400 },
            {
              id: "link",
              type: "arrow",
              x: 0,
              y: 0,
              start: { id: "box-a" },
              end: { id: "nowhere" },
            },
          ],
        },
      ]);
    });
    const rects = live(api).filter((el) => el.type === "rectangle");
    expect(rects).toHaveLength(2);
    const fresh = rects.find((el) => el.id !== "box-a");
    expect(fresh.id).toMatch(/^box-a-/);
    const arrow = byId(api, "link");
    expect(arrow.startBinding?.elementId).toBe(fresh.id);
    expect(arrow.endBinding).toBeNull();
  });

  it("updates label text and moves shapes with their label & arrows", () => {
    act(() => {
      applyOps(api, [
        {
          op: "add",
          elements: [
            {
              id: "b",
              type: "rectangle",
              x: 400,
              y: 100,
              width: 160,
              height: 80,
            },
            {
              id: "ab",
              type: "arrow",
              x: 260,
              y: 140,
              start: { id: "box-a" },
              end: { id: "b" },
            },
          ],
        },
      ]);
    });
    const arrowBefore = byId(api, "ab");
    const labelBefore = labelOf(api, "box-a");

    act(() => {
      applyOps(api, [
        {
          op: "update",
          updates: [
            {
              id: "box-a",
              x: 100,
              y: 300,
              text: "Web app",
              strokeColor: "#e03131",
            },
          ],
        },
      ]);
    });

    const box = byId(api, "box-a");
    expect(box.y).toBe(300);
    expect(box.strokeColor).toBe("#e03131");
    const label = labelOf(api, "box-a");
    expect(label.id).toBe(labelBefore.id);
    expect(label.originalText).toBe("Web app");
    expect(label.y).toBeGreaterThan(labelBefore.y + 150);

    // start of the arrow followed the shape, its end stayed on "b"
    const arrow = byId(api, "ab");
    expect(arrow.y).toBeCloseTo(arrowBefore.y + 200, 0);
    const lastBefore = arrowBefore.points[arrowBefore.points.length - 1];
    const lastAfter = arrow.points[arrow.points.length - 1];
    expect(arrow.x + lastAfter[0]).toBeCloseTo(
      arrowBefore.x + lastBefore[0],
      0,
    );
    expect(arrow.y + lastAfter[1]).toBeCloseTo(
      arrowBefore.y + lastBefore[1],
      0,
    );
  });

  it("deletes shapes with their labels", () => {
    const label = labelOf(api, "box-a");
    act(() => {
      applyOps(api, [{ op: "delete", ids: ["box-a"] }]);
    });
    expect(byId(api, "box-a")).toBeUndefined();
    expect(byId(api, label.id)).toBeUndefined();
  });

  it("builds slides from frames with children", () => {
    act(() => {
      applyOps(api, [
        {
          op: "add",
          elements: [
            {
              id: "t1",
              type: "text",
              x: 1080,
              y: 80,
              text: "Roadmap",
              fontSize: 48,
            },
            {
              id: "s1",
              type: "frame",
              name: "Intro",
              x: 1000,
              y: 0,
              width: 1280,
              height: 720,
              children: ["t1"],
            },
          ],
        },
      ]);
    });
    expect(byId(api, "t1").frameId).toBe("s1");
    const context = JSON.parse(describeScene(api));
    expect(context.slides).toEqual([
      expect.objectContaining({ id: "s1", name: "Intro", index: 1 }),
    ]);
    expect(context.elements.find((el: any) => el.id === "box-a").label).toBe(
      "Browser",
    );
  });
});

describe("slides", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    const ready = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw onExcalidrawAPI={(a) => ready.resolve(a as any)} />,
    );
    api = await ready;
  });

  it("adds, reorders and deletes slides", () => {
    let first: any;
    let second: any;
    act(() => {
      first = addSlide(api);
    });
    act(() => {
      second = addSlide(api);
    });
    expect(second.x).toBe(first.x + 1280 + 160);
    expect(getSlides(api.getSceneElements()).map((s) => s.id)).toEqual([
      first.id,
      second.id,
    ]);

    act(() => moveSlide(api, second.id, 0));
    expect(getSlides(api.getSceneElements()).map((s) => s.id)).toEqual([
      second.id,
      first.id,
    ]);

    act(() => deleteSlide(api, second.id));
    expect(getSlides(api.getSceneElements()).map((s) => s.id)).toEqual([
      first.id,
    ]);
  });
});

describe("pdf", () => {
  it("writes a structurally valid PDF", async () => {
    // smallest valid-looking JPEG payload; the writer doesn't decode it
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const blob = buildPdf([
      { jpeg, width: 1600, height: 900 },
      { jpeg, width: 800, height: 800 },
    ]);
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 960 540]");
    expect(text).toContain("/MediaBox [0 0 960 960]");

    // startxref must point at the xref table, and each xref entry at its object
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text
      .slice(startxref)
      .split("\n")
      .filter((line) => / 00000 n $/.test(line));
    entries.forEach((line, i) => {
      const offset = Number(line.slice(0, 10));
      expect(text.slice(offset).startsWith(`${i + 1} 0 obj\n`)).toBe(true);
    });
  });
});
