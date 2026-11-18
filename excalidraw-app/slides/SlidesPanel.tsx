import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useSetAtom } from "../app-jotai";

import { exportToPdf } from "./pdf";
import { presentationAtom } from "./Presenter";
import {
  addSlide,
  deleteSlide,
  getSlides,
  goToSlide,
  moveSlide,
  renameSlide,
  renderSlideThumbnail,
  slideFingerprint,
  slideName,
} from "./slides";

import "./SlidesPanel.scss";

import type { Slide } from "./slides";

const DRAG_TYPE = "application/x-excalidraw-slide";

export const SlidesPanel = () => {
  const api = useExcalidrawAPI();
  const setPresentation = useSetAtom(presentationAtom);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [fingerprints, setFingerprints] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const thumbCache = useRef(new Map<string, string>());
  const rendering = useRef(false);

  // track slides (debounced — onChange fires a lot)
  useEffect(() => {
    if (!api) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = "";
    const update = () => {
      timer = null;
      const elements = api.getSceneElementsIncludingDeleted();
      const next = getSlides(elements);
      const prints = next.map((slide) => slideFingerprint(slide, elements));
      const signature = `${prints.join("|")}#${next
        .map((s) => s.name)
        .join("|")}#${api.getAppState().exportWithDarkMode}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        setSlides(next);
        setFingerprints(prints);
      }
    };
    update();
    const unsubscribe = api.onChange(() => {
      if (!timer) {
        timer = setTimeout(update, 400);
      }
    });
    return () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [api]);

  // render missing thumbnails one at a time
  useEffect(() => {
    if (!api || rendering.current) {
      return;
    }
    const missing = slides
      .map((slide, i) => ({ slide, print: fingerprints[i] }))
      .filter(({ print }) => print && !thumbCache.current.has(print));
    if (!missing.length) {
      return;
    }
    rendering.current = true;
    (async () => {
      for (const { slide, print } of missing) {
        try {
          thumbCache.current.set(print, await renderSlideThumbnail(api, slide));
        } catch (error) {
          console.warn("[slides] thumbnail failed", error);
          thumbCache.current.set(print, "");
        }
        setThumbs(Object.fromEntries(thumbCache.current));
      }
      rendering.current = false;
      // slides may have changed while rendering
      setThumbs(Object.fromEntries(thumbCache.current));
    })();
  }, [api, slides, fingerprints, thumbs]);

  if (!api) {
    return null;
  }

  const present = (startIndex = 0) => setPresentation({ startIndex });

  const onExportPdf = async () => {
    setBusy("Preparing PDF…");
    try {
      const { pages } = await exportToPdf(api, {
        onProgress: (done, total) =>
          setBusy(`Rendering page ${Math.min(done + 1, total)} of ${total}…`),
      });
      api.setToast({
        message: `Exported ${pages} page${pages > 1 ? "s" : ""} to PDF`,
      });
    } catch (error: any) {
      api.setToast({ message: error.message, closable: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="slides-panel">
      <div className="slides-panel__actions">
        <button
          className="slides-btn slides-btn--primary"
          onClick={() => present(0)}
          disabled={!slides.length}
          title="Present from the first slide"
        >
          ▶ Present
        </button>
        <button className="slides-btn" onClick={() => addSlide(api)}>
          + Slide
        </button>
        <button
          className="slides-btn"
          onClick={onExportPdf}
          disabled={!!busy}
          title={
            slides.length
              ? "One page per slide"
              : "No slides — exports the whole canvas as one page"
          }
        >
          PDF
        </button>
      </div>
      {busy && <div className="slides-panel__busy">{busy}</div>}

      {slides.length === 0 ? (
        <div className="slides-panel__empty">
          <p>
            <strong>Slides are frames.</strong> Add a slide, then draw inside it
            — or ask Claude to "make a 5-slide deck about…".
          </p>
          <button
            className="slides-btn slides-btn--primary"
            onClick={() => addSlide(api)}
          >
            + Add first slide
          </button>
        </div>
      ) : (
        <ol className="slides-list">
          {slides.map((slide, index) => {
            const thumb = thumbs[fingerprints[index]];
            return (
              <li
                key={slide.id}
                className={clsx("slides-item", {
                  "is-drop-target": dragOver === index,
                })}
                draggable={renaming !== slide.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, slide.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                    e.preventDefault();
                    setDragOver(index);
                  }
                }}
                onDragLeave={() => setDragOver((d) => (d === index ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const id = e.dataTransfer.getData(DRAG_TYPE);
                  if (id) {
                    moveSlide(api, id, index);
                  }
                }}
              >
                <span className="slides-item__number">{index + 1}</span>
                <div className="slides-item__body">
                  <button
                    className="slides-item__thumb"
                    style={{ aspectRatio: `${slide.width} / ${slide.height}` }}
                    onClick={() => goToSlide(api, slide)}
                    onDoubleClick={() => present(index)}
                    title="Click to view · double-click to present from here"
                  >
                    {thumb ? (
                      <img src={thumb} alt="" draggable={false} />
                    ) : null}
                  </button>
                  <div className="slides-item__row">
                    {renaming === slide.id ? (
                      <input
                        className="slides-item__rename"
                        autoFocus
                        defaultValue={slideName(slide, index)}
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={(e) => {
                          renameSlide(api, slide.id, e.currentTarget.value);
                          setRenaming(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setRenaming(null);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="slides-item__name"
                        onDoubleClick={() => setRenaming(slide.id)}
                        title="Double-click to rename"
                      >
                        {slideName(slide, index)}
                      </span>
                    )}
                    <span className="slides-item__tools">
                      <button
                        title="Present from here"
                        onClick={() => present(index)}
                      >
                        ▶
                      </button>
                      <button
                        title="Move up"
                        disabled={index === 0}
                        onClick={() => moveSlide(api, slide.id, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        title="Move down"
                        disabled={index === slides.length - 1}
                        onClick={() => moveSlide(api, slide.id, index + 1)}
                      >
                        ↓
                      </button>
                      <button
                        title="Delete slide and its content (⌘Z to undo)"
                        className="is-danger"
                        onClick={() => deleteSlide(api, slide.id)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
