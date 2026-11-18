/**
 * Translates Claude's canvas operations (add / update / delete) into one
 * undoable scene update, and describes the scene to Claude.
 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
  getNonDeletedElements,
  newElementWith,
} from "@excalidraw/excalidraw";
import { newFrameElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getSlides, slideName } from "../slides/slides";

import type { AIOp } from "../workspace/api";

type Skeleton = Record<string, any>;
type AnyElement = ExcalidrawElement & Record<string, any>;

const round = (n: number) => Math.round(n);
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const ADDABLE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
  "stickynote",
]);

const SKELETON_KEYS = new Set([
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "label",
  "text",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "points",
  "start",
  "end",
  "startArrowhead",
  "endArrowhead",
  "name",
  "children",
  "link",
]);

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "angle",
  "link",
] as const;

// -----------------------------------------------------------------------------
// scene context
// -----------------------------------------------------------------------------

const MAX_CONTEXT_ELEMENTS = 400;

export const describeScene = (api: ExcalidrawImperativeAPI) => {
  const appState = api.getAppState();
  const elements = getNonDeletedElements(api.getSceneElements());
  const byId = new Map(elements.map((el) => [el.id, el as AnyElement]));
  const zoom = appState.zoom.value;
  const viewport = {
    x: round(-appState.scrollX),
    y: round(-appState.scrollY),
    width: round(appState.width / zoom),
    height: round(appState.height / zoom),
  };
  const selectedIds = Object.keys(appState.selectedElementIds).filter(
    (id) => appState.selectedElementIds[id] && byId.has(id),
  );
  const selected = new Set(selectedIds);

  const inViewport = (el: ExcalidrawElement) =>
    el.x + el.width >= viewport.x &&
    el.x <= viewport.x + viewport.width &&
    el.y + el.height >= viewport.y &&
    el.y <= viewport.y + viewport.height;

  const candidates = elements.filter(
    // bound labels are folded into their container's `label`
    (el) => !(el.type === "text" && (el as AnyElement).containerId),
  );
  const prioritized = [
    ...candidates.filter((el) => selected.has(el.id)),
    ...candidates.filter((el) => !selected.has(el.id) && inViewport(el)),
    ...candidates.filter((el) => !selected.has(el.id) && !inViewport(el)),
  ];
  const included = prioritized.slice(0, MAX_CONTEXT_ELEMENTS);

  const compact = included.map((raw) => {
    const el = raw as AnyElement;
    const out: Record<string, unknown> = {
      id: el.id,
      type: el.type,
      x: round(el.x),
      y: round(el.y),
      w: round(el.width),
      h: round(el.height),
    };
    if (el.type === "text") {
      out.text = el.originalText ?? el.text;
      out.fontSize = el.fontSize;
    }
    const labelRef = el.boundElements?.find(
      (b: { type: string }) => b.type === "text",
    );
    const label = labelRef ? byId.get(labelRef.id) : null;
    if (label) {
      out.label = label.originalText ?? label.text;
    }
    if (el.type === "frame") {
      out.name = el.name;
    }
    if (el.strokeColor && el.strokeColor !== "#1e1e1e") {
      out.stroke = el.strokeColor;
    }
    if (el.backgroundColor && el.backgroundColor !== "transparent") {
      out.bg = el.backgroundColor;
    }
    if (el.frameId) {
      out.frameId = el.frameId;
    }
    if (el.angle) {
      out.angle = Number(el.angle.toFixed(3));
    }
    if (el.type === "arrow" || el.type === "line") {
      if (el.startBinding?.elementId) {
        out.start = el.startBinding.elementId;
      }
      if (el.endBinding?.elementId) {
        out.end = el.endBinding.elementId;
      }
      out.points = el.points?.map((p: number[]) => [round(p[0]), round(p[1])]);
    }
    if (el.link) {
      out.link = el.link;
    }
    return out;
  });

  const slides = getSlides(elements).map((slide, i) => ({
    index: i + 1,
    id: slide.id,
    name: slideName(slide, i),
    x: round(slide.x),
    y: round(slide.y),
    w: round(slide.width),
    h: round(slide.height),
  }));

  return JSON.stringify({
    page: api.getName(),
    viewport,
    selectedIds,
    elements: compact,
    omitted: Math.max(0, candidates.length - included.length),
    slides,
  });
};

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const randomSuffix = () => Math.random().toString(36).slice(2, 7);

const boundLabelOf = (
  el: AnyElement,
  elements: Map<string, AnyElement>,
): AnyElement | null => {
  const ref = el.boundElements?.find(
    (b: { type: string }) => b.type === "text",
  );
  const label = ref ? elements.get(ref.id) : null;
  return label && !label.isDeleted ? label : null;
};

/**
 * Builds (measured) label text for a container by running a throwaway
 * skeleton through the converter — keeps us on the public API.
 */
const measureLabel = (
  container: AnyElement,
  text: string,
  style: Partial<AnyElement> = {},
) => {
  const converted = convertToExcalidrawElements(
    [
      {
        type: container.type,
        id: container.id,
        x: container.x,
        y: container.y,
        width: container.width,
        height: container.height,
        label: {
          text,
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          textAlign: style.textAlign,
          verticalAlign: style.verticalAlign,
          strokeColor: style.strokeColor,
        },
      } as any,
    ],
    { regenerateIds: false },
  ) as AnyElement[];
  const measuredContainer = converted.find((el) => el.id === container.id)!;
  const label = converted.find((el) => el.type === "text")!;
  return { measuredContainer, label };
};

const measureText = (el: AnyElement, text: string, fontSize?: number) => {
  const [measured] = convertToExcalidrawElements(
    [
      {
        type: "text",
        id: el.id,
        x: el.x,
        y: el.y,
        text,
        fontSize: fontSize ?? el.fontSize,
        fontFamily: el.fontFamily,
        textAlign: el.textAlign,
        verticalAlign: el.verticalAlign,
      } as any,
    ],
    { regenerateIds: false },
  ) as AnyElement[];
  return measured;
};

const pickStyle = (source: Record<string, any>) => {
  const patch: Record<string, any> = {};
  for (const key of STYLE_KEYS) {
    if (source[key] !== undefined) {
      patch[key] = source[key];
    }
  }
  if (isNum(patch.opacity)) {
    patch.opacity = Math.max(0, Math.min(100, patch.opacity));
  }
  return patch;
};

// -----------------------------------------------------------------------------
// apply
// -----------------------------------------------------------------------------

export type ApplySummary = {
  added: number;
  updated: number;
  deleted: number;
  errors: string[];
};

export const applyOps = (
  api: ExcalidrawImperativeAPI,
  ops: AIOp[],
): ApplySummary => {
  const summary: ApplySummary = {
    added: 0,
    updated: 0,
    deleted: 0,
    errors: [],
  };
  // working copy, keyed by id, insertion-ordered
  const scene = new Map<string, AnyElement>(
    api
      .getSceneElementsIncludingDeleted()
      .map((el) => [el.id, el as AnyElement]),
  );
  const addedIds: string[] = [];

  const set = (el: AnyElement) => scene.set(el.id, el);
  const live = (id: string) => {
    const el = scene.get(id);
    return el && !el.isDeleted ? el : null;
  };

  for (const op of ops) {
    try {
      if (op.op === "add" && Array.isArray(op.elements)) {
        const created = addElements(op.elements, scene, live, set);
        addedIds.push(...created);
        summary.added += created.length;
      } else if (op.op === "update" && Array.isArray(op.updates)) {
        for (const update of op.updates) {
          try {
            if (updateElement(update, scene, live, set)) {
              summary.updated++;
            }
          } catch (error: any) {
            summary.errors.push(error.message);
          }
        }
      } else if (op.op === "delete" && Array.isArray(op.ids)) {
        summary.deleted += deleteElements(op.ids, scene, live, set);
      }
    } catch (error: any) {
      console.error("[claude] failed to apply op", op, error);
      summary.errors.push(error?.message || String(error));
    }
  }

  if (summary.added || summary.updated || summary.deleted) {
    api.updateScene({
      elements: [...scene.values()],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    revealElements(api, addedIds);
  }
  return summary;
};

const revealElements = (api: ExcalidrawImperativeAPI, ids: string[]) => {
  if (!ids.length) {
    return;
  }
  const idSet = new Set(ids);
  const added = api
    .getSceneElements()
    .filter((el) => idSet.has(el.id)) as NonDeletedExcalidrawElement[];
  if (!added.length) {
    return;
  }
  const [minX, minY, maxX, maxY] = getCommonBounds(added);
  const appState = api.getAppState();
  const zoom = appState.zoom.value;
  const viewX = -appState.scrollX;
  const viewY = -appState.scrollY;
  const fullyVisible =
    minX >= viewX &&
    minY >= viewY &&
    maxX <= viewX + appState.width / zoom &&
    maxY <= viewY + appState.height / zoom;
  if (!fullyVisible) {
    api.setViewport({ target: added, fit: "scale-down", animation: true });
  }
};

// add ---------------------------------------------------------------------------

const LINEAR_TYPES = new Set(["arrow", "line"]);
/** what arrows can attach to (the converter binds through a stand-in) */
const BINDABLE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "stickynote",
  "text",
]);

type Point = [number, number];

/**
 * Where a ray from the element's center towards `toward` leaves its outline.
 */
const outlinePoint = (el: AnyElement, toward: Point): Point => {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const a = Math.max(1, el.width / 2);
  const b = Math.max(1, el.height / 2);
  let dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (!dx && !dy) {
    dx = 1;
  }
  let t: number;
  if (el.type === "ellipse") {
    t = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
  } else if (el.type === "diamond") {
    t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  } else {
    t = Math.min(
      dx ? a / Math.abs(dx) : Infinity,
      dy ? b / Math.abs(dy) : Infinity,
    );
  }
  return [cx + dx * t, cy + dy * t];
};

const centerOf = (el: AnyElement): Point => [
  el.x + el.width / 2,
  el.y + el.height / 2,
];

const addElements = (
  rawSkeletons: Skeleton[],
  scene: Map<string, AnyElement>,
  live: (id: string) => AnyElement | null,
  set: (el: AnyElement) => void,
): string[] => {
  // 1. sanitize & give every element a unique id
  const renamed = new Map<string, string>();
  const skeletons: Skeleton[] = [];
  const usedIds = new Set<string>();
  for (const raw of rawSkeletons) {
    if (!raw || typeof raw !== "object" || !ADDABLE_TYPES.has(raw.type)) {
      continue;
    }
    const skeleton: Skeleton = {};
    for (const [key, value] of Object.entries(raw)) {
      if (SKELETON_KEYS.has(key) && value !== null && value !== undefined) {
        skeleton[key] = value;
      }
    }
    // explicit nulls are meaningful for arrowheads
    for (const key of ["startArrowhead", "endArrowhead"]) {
      if (raw[key] === null) {
        skeleton[key] = null;
      }
    }
    skeleton.x = isNum(skeleton.x) ? skeleton.x : 0;
    skeleton.y = isNum(skeleton.y) ? skeleton.y : 0;
    const originalId =
      typeof skeleton.id === "string" && skeleton.id ? skeleton.id : null;
    let id = originalId || `ai-${randomSuffix()}`;
    while (scene.has(id) || usedIds.has(id)) {
      id = `${originalId || "ai"}-${randomSuffix()}`;
    }
    usedIds.add(id);
    if (originalId && originalId !== id) {
      renamed.set(originalId, id);
    }
    skeleton.id = id;

    if (typeof skeleton.label === "string") {
      skeleton.label = { text: skeleton.label };
    }
    if (skeleton.label && typeof skeleton.label.text !== "string") {
      delete skeleton.label;
    }
    if (skeleton.type === "text") {
      skeleton.text = String(skeleton.text ?? skeleton.label?.text ?? "");
      delete skeleton.label;
    }
    if (Array.isArray(skeleton.points)) {
      skeleton.points = skeleton.points
        .filter((p: unknown) => Array.isArray(p) && p.length >= 2)
        .map((p: number[]) => [Number(p[0]) || 0, Number(p[1]) || 0]);
      if (skeleton.points.length < 2) {
        delete skeleton.points;
      }
    }
    skeletons.push(skeleton);
  }
  const resolveRef = (ref: unknown) =>
    typeof ref === "string" ? renamed.get(ref) ?? ref : null;

  const shapes = skeletons.filter(
    (s) => !LINEAR_TYPES.has(s.type) && s.type !== "frame",
  );
  const linears = skeletons.filter((s) => LINEAR_TYPES.has(s.type));
  const frames = skeletons.filter((s) => s.type === "frame");
  const created: string[] = [];

  // 2. shapes & text (their real size is known only after conversion, e.g.
  // shapes sized to fit their label)
  if (shapes.length) {
    const converted = convertToExcalidrawElements(shapes as any, {
      regenerateIds: false,
    }) as AnyElement[];
    for (const el of converted) {
      set(el);
      created.push(el.id);
    }
  }

  // 3. arrows & lines: place bound ends exactly on the outlines of what they
  // connect — the converter drops bindings whose ends don't reach the shape
  if (linears.length) {
    const proxies = new Map<string, Skeleton>();
    for (const skeleton of linears) {
      const given: Point[] = (
        skeleton.points || [
          [0, 0],
          [
            isNum(skeleton.width) ? skeleton.width : 100,
            isNum(skeleton.height) ? skeleton.height : 0,
          ],
        ]
      ).map((p: number[]) => [skeleton.x + p[0], skeleton.y + p[1]] as Point);

      const target = (end: "start" | "end") => {
        const id = resolveRef(skeleton[end]?.id);
        const el = id && skeleton.type === "arrow" ? live(id) : null;
        return el && BINDABLE_TYPES.has(el.type) ? el : null;
      };
      const startEl = target("start");
      const endEl = target("end");
      delete skeleton.start;
      delete skeleton.end;

      if (startEl || endEl) {
        let from = given[0];
        let to = given[given.length - 1];
        if (startEl && endEl) {
          from = outlinePoint(startEl, centerOf(endEl));
          to = outlinePoint(endEl, centerOf(startEl));
        } else if (startEl) {
          from = outlinePoint(startEl, to);
        } else if (endEl) {
          to = outlinePoint(endEl, from);
        }
        skeleton.x = from[0];
        skeleton.y = from[1];
        skeleton.points = [
          [0, 0],
          [to[0] - from[0], to[1] - from[1]],
        ];
        delete skeleton.width;
        delete skeleton.height;
      }
      for (const [end, el] of [
        ["start", startEl],
        ["end", endEl],
      ] as const) {
        if (!el) {
          continue;
        }
        skeleton[end] = { id: el.id };
        if (!proxies.has(el.id)) {
          proxies.set(el.id, {
            // stand-in with the same geometry; arrows bind to its outline
            type:
              el.type === "ellipse" || el.type === "diamond"
                ? el.type
                : "rectangle",
            id: el.id,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
          });
        }
      }
    }

    const converted = convertToExcalidrawElements(
      [...proxies.values(), ...linears] as any,
      { regenerateIds: false },
    ) as AnyElement[];

    for (const el of converted) {
      if (!proxies.has(el.id)) {
        set(el);
        created.push(el.id);
        continue;
      }
      // merge the new bindings into the real (new or existing) element
      const original = live(el.id);
      if (!original) {
        continue;
      }
      const known = new Set(
        (original.boundElements || []).map((b: { id: string }) => b.id),
      );
      const extra = (el.boundElements || []).filter(
        (b: { id: string; type: string }) =>
          b.type === "arrow" && !known.has(b.id),
      );
      if (extra.length) {
        set(
          newElementWith(original as ExcalidrawElement, {
            boundElements: [...(original.boundElements || []), ...extra],
          }) as AnyElement,
        );
      }
    }
  }

  // 4. frames (slides) around their children
  for (const skeleton of frames) {
    const children = (Array.isArray(skeleton.children) ? skeleton.children : [])
      .map(resolveRef)
      .map((id: string | null) => (id ? live(id) : null))
      .filter((el: AnyElement | null): el is AnyElement => !!el);
    const members = new Map<string, AnyElement>();
    for (const child of children) {
      members.set(child.id, child);
      const label = boundLabelOf(child, scene);
      if (label) {
        members.set(label.id, label);
      }
    }

    let { x, y, width, height } = skeleton;
    if (
      !(isNum(width) && width > 0 && isNum(height) && height > 0) &&
      members.size
    ) {
      const PADDING = 40;
      const [minX, minY, maxX, maxY] = getCommonBounds([
        ...members.values(),
      ] as NonDeletedExcalidrawElement[]);
      x = minX - PADDING;
      y = minY - PADDING;
      width = maxX - minX + PADDING * 2;
      height = maxY - minY + PADDING * 2;
    }
    const frame = {
      ...newFrameElement({
        x,
        y,
        width: isNum(width) && width > 0 ? width : 1280,
        height: isNum(height) && height > 0 ? height : 720,
        name: typeof skeleton.name === "string" ? skeleton.name : undefined,
      }),
      id: skeleton.id,
    } as AnyElement;
    set(frame);
    created.push(frame.id);
    for (const member of members.values()) {
      set(
        newElementWith(member as ExcalidrawElement, {
          frameId: frame.id,
        }) as AnyElement,
      );
    }
  }

  return created;
};

// update ------------------------------------------------------------------------

const translate = (el: AnyElement, dx: number, dy: number) =>
  newElementWith(el as ExcalidrawElement, {
    x: el.x + dx,
    y: el.y + dy,
  }) as AnyElement;

const updateElement = (
  update: { id: string } & Record<string, any>,
  scene: Map<string, AnyElement>,
  live: (id: string) => AnyElement | null,
  set: (el: AnyElement) => void,
): boolean => {
  let el = live(update.id);
  if (!el) {
    throw new Error(`No element with id "${update.id}"`);
  }
  // updating a bound label by its own id → treat as the container's text
  if (el.type === "text" && el.containerId && live(el.containerId)) {
    el = live(el.containerId)!;
  }

  const patch: Record<string, any> = pickStyle(update);
  if (el.type === "frame" && typeof update.name === "string") {
    patch.name = update.name;
  }
  if (isNum(update.width) && update.width > 0) {
    patch.width = update.width;
  }
  if (isNum(update.height) && update.height > 0) {
    patch.height = update.height;
  }
  const dx = isNum(update.x) ? update.x - el.x : 0;
  const dy = isNum(update.y) ? update.y - el.y : 0;

  if (
    el.type === "text" &&
    (typeof update.text === "string" || isNum(update.fontSize))
  ) {
    const measured = measureText(
      el,
      typeof update.text === "string" ? update.text : el.originalText,
      isNum(update.fontSize) ? update.fontSize : undefined,
    );
    Object.assign(patch, {
      text: measured.text,
      originalText: measured.originalText,
      fontSize: measured.fontSize,
      width: measured.width,
      height: measured.height,
      lineHeight: measured.lineHeight,
    });
  }

  let next = newElementWith(
    el as ExcalidrawElement,
    patch as any,
  ) as AnyElement;
  if (dx || dy) {
    next = translate(next, dx, dy);
  }
  set(next);

  // a container's label: new text, or re-centered after a resize/move
  const label = boundLabelOf(el, scene);
  const newLabelText =
    typeof update.text === "string" && el.type !== "text" ? update.text : null;
  if (label || newLabelText !== null) {
    const { measuredContainer, label: measuredLabel } = measureLabel(
      next,
      newLabelText ?? label?.originalText ?? label?.text ?? "",
      {
        fontSize: isNum(update.fontSize) ? update.fontSize : label?.fontSize,
        fontFamily: label?.fontFamily,
        textAlign: label?.textAlign,
        verticalAlign: label?.verticalAlign,
        strokeColor:
          update.strokeColor ?? label?.strokeColor ?? next.strokeColor,
      },
    );
    if (measuredContainer.height > next.height) {
      next = newElementWith(next as ExcalidrawElement, {
        height: measuredContainer.height,
      }) as AnyElement;
      set(next);
    }
    if (label) {
      set(
        newElementWith(
          label as ExcalidrawElement,
          {
            text: measuredLabel.text,
            originalText: measuredLabel.originalText,
            fontSize: measuredLabel.fontSize,
            x: measuredLabel.x,
            y: measuredLabel.y,
            width: measuredLabel.width,
            height: measuredLabel.height,
            ...(update.strokeColor ? { strokeColor: update.strokeColor } : {}),
          } as any,
        ) as AnyElement,
      );
    } else {
      set({ ...measuredLabel, containerId: next.id, frameId: next.frameId });
      set(
        newElementWith(next as ExcalidrawElement, {
          boundElements: [
            ...(next.boundElements || []),
            { type: "text", id: measuredLabel.id },
          ],
        }) as AnyElement,
      );
    }
  }

  if (dx || dy) {
    moveDependents(el, dx, dy, scene, set);
  }
  return true;
};

/** moves frame children, and keeps bound arrows attached to moved shapes */
const moveDependents = (
  moved: AnyElement,
  dx: number,
  dy: number,
  scene: Map<string, AnyElement>,
  set: (el: AnyElement) => void,
) => {
  const movedIds = new Set([moved.id]);
  const label = boundLabelOf(moved, scene);
  if (label) {
    // labels were re-measured from the moved container already
    movedIds.add(label.id);
  }
  if (moved.type === "frame") {
    for (const el of scene.values()) {
      if (!el.isDeleted && el.frameId === moved.id) {
        set(translate(el, dx, dy));
        movedIds.add(el.id);
        const childLabel = boundLabelOf(el, scene);
        if (childLabel && childLabel.frameId !== moved.id) {
          set(translate(childLabel, dx, dy));
          movedIds.add(childLabel.id);
        }
      }
    }
  }
  for (const el of scene.values()) {
    if (el.isDeleted || el.type !== "arrow" || movedIds.has(el.id)) {
      continue;
    }
    const startMoved =
      !!el.startBinding && movedIds.has(el.startBinding.elementId);
    const endMoved = !!el.endBinding && movedIds.has(el.endBinding.elementId);
    if (!startMoved && !endMoved) {
      continue;
    }
    if (startMoved && endMoved) {
      set(translate(el, dx, dy));
      continue;
    }
    const points: number[][] = el.points.map((p: number[]) => [p[0], p[1]]);
    let { x, y } = el;
    if (startMoved) {
      x += dx;
      y += dy;
      for (let i = 1; i < points.length; i++) {
        points[i] = [points[i][0] - dx, points[i][1] - dy];
      }
    } else {
      const last = points.length - 1;
      points[last] = [points[last][0] + dx, points[last][1] + dy];
    }
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    set(
      newElementWith(
        el as ExcalidrawElement,
        {
          x,
          y,
          points: points as any,
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        } as any,
      ) as AnyElement,
    );
  }
};

// delete ------------------------------------------------------------------------

const deleteElements = (
  ids: string[],
  scene: Map<string, AnyElement>,
  live: (id: string) => AnyElement | null,
  set: (el: AnyElement) => void,
) => {
  const doomed = new Set<string>();
  for (const id of ids) {
    const el = live(String(id));
    if (!el) {
      continue;
    }
    doomed.add(el.id);
    const label = boundLabelOf(el, scene);
    if (label) {
      doomed.add(label.id);
    }
    if (el.type === "frame") {
      for (const child of scene.values()) {
        if (!child.isDeleted && child.frameId === el.id) {
          doomed.add(child.id);
          const childLabel = boundLabelOf(child, scene);
          if (childLabel) {
            doomed.add(childLabel.id);
          }
        }
      }
    }
  }
  for (const id of doomed) {
    set(
      newElementWith(scene.get(id)! as ExcalidrawElement, {
        isDeleted: true,
      }) as AnyElement,
    );
  }
  return [...doomed].filter((id) => {
    const el = scene.get(id);
    return !(el?.type === "text" && el.containerId);
  }).length;
};
