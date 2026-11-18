import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { THEME } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { atom, useAtom } from "../app-jotai";

import { getSlides, renderSlideSvg, slideName } from "./slides";

import "./Presenter.scss";

import type { Slide } from "./slides";

export const presentationAtom = atom<{ startIndex: number } | null>(null);

const NEXT_KEYS = new Set([
  "ArrowRight",
  "ArrowDown",
  "PageDown",
  " ",
  "Enter",
  "n",
]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"]);

export const Presenter = ({ api }: { api: ExcalidrawImperativeAPI }) => {
  const [presentation, setPresentation] = useAtom(presentationAtom);
  if (!presentation) {
    return null;
  }
  return (
    <PresenterView
      api={api}
      startIndex={presentation.startIndex}
      onClose={() => setPresentation(null)}
    />
  );
};

const PresenterView = ({
  api,
  startIndex,
  onClose,
}: {
  api: ExcalidrawImperativeAPI;
  startIndex: number;
  onClose: () => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [slides] = useState<Slide[]>(() => getSlides(api.getSceneElements()));
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), Math.max(0, slides.length - 1)),
  );
  const [rendered, setRendered] = useState<(SVGSVGElement | null)[]>([]);
  const [showChrome, setShowChrome] = useState(true);
  const dark = api.getAppState().theme === THEME.DARK;

  // pre-render every slide (current one first)
  useEffect(() => {
    let cancelled = false;
    const order = [
      index,
      ...slides.map((_, i) => i).filter((i) => i !== index),
    ];
    (async () => {
      const result: (SVGSVGElement | null)[] = slides.map(() => null);
      for (const i of order) {
        try {
          const svg = await renderSlideSvg(
            api,
            slides[i],
            dark ? THEME.DARK : THEME.LIGHT,
          );
          if (!svg.getAttribute("viewBox")) {
            svg.setAttribute(
              "viewBox",
              `0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`,
            );
          }
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
          result[i] = svg;
        } catch (error) {
          console.error("[slides] couldn't render slide", error);
        }
        if (cancelled) {
          return;
        }
        setRendered([...result]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // render once per presentation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const svg = rendered[index];
    if (!stage) {
      return;
    }
    stage.replaceChildren(...(svg ? [svg] : []));
  }, [rendered, index]);

  const go = useCallback(
    (delta: number) =>
      setIndex((i) => Math.min(slides.length - 1, Math.max(0, i + delta))),
    [slides.length],
  );

  const close = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    // leave the canvas on the slide we ended on
    const slide = slides[index];
    if (slide) {
      api.setViewport({ target: slide, fit: "contain" });
    }
    onClose();
  }, [api, index, onClose, slides]);

  // fullscreen
  useEffect(() => {
    const root = rootRef.current;
    let entered = false;
    root
      ?.requestFullscreen?.()
      .then(() => {
        entered = true;
      })
      .catch(() => {
        // not allowed (e.g. iframe) — present in the window instead
      });
    const onFullscreenChange = () => {
      if (entered && !document.fullscreenElement) {
        onClose();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [onClose]);

  // keyboard (capture phase, before the editor's global shortcuts)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      let handled = true;
      if (NEXT_KEYS.has(event.key)) {
        go(1);
      } else if (PREV_KEYS.has(event.key)) {
        go(-1);
      } else if (event.key === "Home") {
        setIndex(0);
      } else if (event.key === "End") {
        setIndex(slides.length - 1);
      } else if (event.key === "Escape") {
        close();
      } else if (event.key === "f") {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          rootRef.current?.requestFullscreen?.().catch(() => {});
        }
      } else {
        handled = false;
      }
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [go, close, slides.length]);

  // hide the controls while idle
  useEffect(() => {
    let timer = setTimeout(() => setShowChrome(false), 2500);
    const onMove = () => {
      setShowChrome(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShowChrome(false), 2500);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  const background = api.getAppState().viewBackgroundColor;

  return createPortal(
    <div
      ref={rootRef}
      className={`presenter ${dark ? "presenter--dark" : ""} ${
        showChrome ? "" : "presenter--idle"
      }`}
      onClick={(event) => {
        const x = event.clientX / window.innerWidth;
        go(x < 0.3 ? -1 : 1);
      }}
    >
      {slides.length === 0 ? (
        <div className="presenter__empty">
          <p>No slides yet.</p>
          <p>Add a slide (a frame) from the Slides panel, then present.</p>
        </div>
      ) : (
        <div
          className="presenter__slide"
          style={{
            aspectRatio: `${slides[index].width} / ${slides[index].height}`,
            width: `min(100vw, calc(100vh * ${
              slides[index].width / slides[index].height
            }))`,
            background: dark ? undefined : background,
          }}
        >
          <div ref={stageRef} className="presenter__stage" />
          {!rendered[index] && <div className="presenter__loading" />}
        </div>
      )}

      <div className="presenter__bar" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => go(-1)}
          disabled={index === 0}
          title="Previous (←)"
        >
          ‹
        </button>
        <span className="presenter__counter">
          {slides.length ? `${index + 1} / ${slides.length}` : "0 / 0"}
          {slides[index] && (
            <span className="presenter__title">
              {slideName(slides[index], index)}
            </span>
          )}
        </span>
        <button
          onClick={() => go(1)}
          disabled={index >= slides.length - 1}
          title="Next (→ or Space)"
        >
          ›
        </button>
        <button className="presenter__exit" onClick={close} title="Exit (Esc)">
          Exit
        </button>
      </div>
      <div
        className="presenter__progress"
        style={{
          width: slides.length ? `${((index + 1) / slides.length) * 100}%` : 0,
        }}
      />
    </div>,
    document.body,
  );
};
