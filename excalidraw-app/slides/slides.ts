/**
 * Slides = frames. Their order is kept in `customData.slideIndex` (frames
 * without one follow in canvas order), so it travels with the drawing.
 */
import {
  CaptureUpdateAction,
  exportScene,
  getNonDeletedElements,
  newElementWith,
  THEME,
} from "@excalidraw/excalidraw";
import { newFrameElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
const SLIDE_GAP = 160;

export type Slide = NonDeleted<ExcalidrawFrameElement>;

const slideIndexOf = (frame: ExcalidrawElement) => {
  const index = frame.customData?.slideIndex;
  return typeof index === "number" && Number.isFinite(index) ? index : null;
};

export const getSlides = (elements: readonly ExcalidrawElement[]): Slide[] => {
  const frames = elements.filter(
    (el): el is Slide => el.type === "frame" && !el.isDeleted,
  );
  return frames
    .map((frame, order) => ({ frame, order, index: slideIndexOf(frame) }))
    .sort((a, b) => {
      if (a.index !== null && b.index !== null && a.index !== b.index) {
        return a.index - b.index;
      }
      if (a.index !== null && b.index === null) {
        return -1;
      }
      if (a.index === null && b.index !== null) {
        return 1;
      }
      return a.order - b.order;
    })
    .map(({ frame }) => frame);
};

export const slideName = (slide: Slide, index: number) =>
  slide.name?.trim() || `Slide ${index + 1}`;

/** cheap fingerprint of a slide's content, for thumbnail caching */
export const slideFingerprint = (
  slide: Slide,
  elements: readonly ExcalidrawElement[],
) => {
  let hash = slide.version;
  let count = 0;
  for (const el of elements) {
    if (el.frameId === slide.id) {
      hash = (hash * 31 + el.version + (el.isDeleted ? 7 : 0)) | 0;
      count++;
    }
  }
  return `${slide.id}:${hash}:${count}:${slide.width}x${slide.height}`;
};

const exportTheme = (api: ExcalidrawImperativeAPI) =>
  api.getAppState().exportWithDarkMode ? THEME.DARK : THEME.LIGHT;

const sceneData = (api: ExcalidrawImperativeAPI) => {
  const appState = api.getAppState();
  return {
    elements: getNonDeletedElements(api.getSceneElements()),
    appState: { viewBackgroundColor: appState.viewBackgroundColor },
    files: api.getFiles(),
  };
};

export const renderSlideThumbnail = async (
  api: ExcalidrawImperativeAPI,
  slide: Slide,
  size = 320,
) => {
  const canvas = await exportScene({
    type: "canvas",
    data: sceneData(api),
    config: {
      exportingFrame: slide,
      maxWidthOrHeight: size,
      theme: exportTheme(api),
    },
  });
  return canvas.toDataURL("image/png");
};

export const renderSlideSvg = (
  api: ExcalidrawImperativeAPI,
  slide: Slide,
  theme = exportTheme(api),
) =>
  exportScene({
    type: "svg",
    data: sceneData(api),
    config: { exportingFrame: slide, theme },
  });

export const renderJpeg = async (
  api: ExcalidrawImperativeAPI,
  slide: Slide | null,
) => {
  const canvas = await exportScene({
    type: "canvas",
    data: sceneData(api),
    config: {
      exportingFrame: slide,
      theme: exportTheme(api),
      padding: slide ? 0 : 32,
      // ~2560px wide slides, and at most ~24MP for whole-canvas exports
      scale: (width, height) =>
        Math.max(
          0.5,
          Math.min(3, 2560 / width, Math.sqrt(24e6 / (width * height))),
        ),
    },
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't render page"))),
      "image/jpeg",
      0.92,
    ),
  );
  return {
    jpeg: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
};

// editing ---------------------------------------------------------------------

/** frames → elements with every slide's `slideIndex` set to its position */
const withSlideOrder = (
  elements: readonly ExcalidrawElement[],
  ordered: readonly Slide[],
) => {
  const position = new Map(ordered.map((slide, i) => [slide.id, i]));
  return elements.map((el) => {
    const index = position.get(el.id);
    if (index === undefined || slideIndexOf(el) === index) {
      return el;
    }
    return newElementWith(el, {
      customData: { ...el.customData, slideIndex: index },
    });
  });
};

export const addSlide = (api: ExcalidrawImperativeAPI) => {
  const elements = api.getSceneElementsIncludingDeleted();
  const slides = getSlides(elements);
  const last = slides[slides.length - 1];
  const appState = api.getAppState();

  let x: number;
  let y: number;
  if (last) {
    x = last.x + last.width + SLIDE_GAP;
    y = last.y;
  } else {
    const zoom = appState.zoom.value;
    x = Math.round(
      -appState.scrollX + appState.width / zoom / 2 - SLIDE_WIDTH / 2,
    );
    y = Math.round(
      -appState.scrollY + appState.height / zoom / 2 - SLIDE_HEIGHT / 2,
    );
  }

  const frame = newFrameElement({
    x,
    y,
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    name: `Slide ${slides.length + 1}`,
    customData: { slideIndex: slides.length },
  });

  api.updateScene({
    elements: [...withSlideOrder(elements, slides), frame],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.setViewport({ target: frame, fit: "contain", animation: true });
  return frame;
};

export const moveSlide = (
  api: ExcalidrawImperativeAPI,
  slideId: string,
  toIndex: number,
) => {
  const elements = api.getSceneElementsIncludingDeleted();
  const slides = getSlides(elements);
  const from = slides.findIndex((s) => s.id === slideId);
  if (from === -1) {
    return;
  }
  const target = Math.max(0, Math.min(slides.length - 1, toIndex));
  if (target === from) {
    return;
  }
  const next = [...slides];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  api.updateScene({
    elements: withSlideOrder(elements, next),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

export const renameSlide = (
  api: ExcalidrawImperativeAPI,
  slideId: string,
  name: string,
) => {
  api.updateScene({
    elements: api
      .getSceneElementsIncludingDeleted()
      .map((el) =>
        el.id === slideId && el.type === "frame"
          ? newElementWith(el, { name: name.trim() || null })
          : el,
      ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/** deletes the frame and everything in it (undoable) */
export const deleteSlide = (api: ExcalidrawImperativeAPI, slideId: string) => {
  const elements = api.getSceneElementsIncludingDeleted();
  const doomed = new Set<string>([slideId]);
  for (const el of elements) {
    if (el.frameId === slideId) {
      doomed.add(el.id);
    }
  }
  // labels bound to deleted containers
  for (const el of elements) {
    if (el.type === "text" && el.containerId && doomed.has(el.containerId)) {
      doomed.add(el.id);
    }
  }
  api.updateScene({
    elements: elements.map((el) =>
      doomed.has(el.id) ? newElementWith(el, { isDeleted: true }) : el,
    ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

export const goToSlide = (api: ExcalidrawImperativeAPI, slide: Slide) => {
  api.setViewport({ target: slide, fit: "contain", animation: true });
};
