/**
 * Slide order, with no editor imports: frames are slides, ordered by
 * `customData.slideIndex` (frames without one follow in canvas order). Shared
 * by the editor (`slides.ts`) and deck building (`deck.ts`).
 */
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

export type Slide = NonDeleted<ExcalidrawFrameElement>;

export const slideIndexOf = (frame: ExcalidrawElement) => {
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
