import clsx from "clsx";
import { useState } from "react";

import { basename, dirname } from "./api";

import "./DeckPicker.scss";

import type { TreeNode } from "./api";

export type DeckRequest = {
  name: string;
  sources: { name: string; path: string }[];
  sections: boolean;
};

/**
 * "New deck from pages…": tick pages in the order they should play (the
 * list stays put, so ticks can follow one another), fix the order with ↑ ↓,
 * name the deck.
 */
export const DeckPicker = ({
  pages,
  initial = [],
  onCreate,
  onClose,
}: {
  pages: TreeNode[];
  initial?: string[];
  onCreate: (request: DeckRequest) => Promise<void>;
  onClose: () => void;
}) => {
  const [picked, setPicked] = useState<string[]>(initial);
  const [name, setName] = useState("Deck");
  const [sections, setSections] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (path: string) =>
    setPicked((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  const move = (from: number, to: number) =>
    setPicked((prev) => {
      if (to < 0 || to >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const create = async () => {
    if (!picked.length || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim() || "Deck",
        sources: picked.map((path) => ({ name: basename(path), path })),
        sections,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || "Couldn't create the deck");
      setBusy(false);
    }
  };

  const pageName = (path: string) => (
    <span className="deck-picker__name" title={path}>
      {basename(path)}
      {dirname(path) && (
        <span className="deck-picker__folder">{dirname(path)}</span>
      )}
    </span>
  );

  return (
    <div className="deck-picker">
      <div className="deck-picker__title">New deck from pages</div>
      <input
        className="deck-picker__input"
        autoFocus
        value={name}
        placeholder="Deck name"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            create();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <div className="deck-picker__hint">
        Tick pages in the order they should play. Their slides (frames) are
        copied, one row per page.
      </div>
      <div className="deck-picker__list">
        {pages.map((page) => {
          const position = picked.indexOf(page.path);
          return (
            <label
              key={page.path}
              className={clsx("deck-picker__row", {
                "is-picked": position !== -1,
              })}
            >
              <input
                type="checkbox"
                checked={position !== -1}
                onChange={() => toggle(page.path)}
              />
              <span className="deck-picker__position">
                {position !== -1 ? position + 1 : ""}
              </span>
              {pageName(page.path)}
            </label>
          );
        })}
      </div>
      {picked.length > 0 && (
        <>
          <div className="deck-picker__subtitle">Order</div>
          <div className="deck-picker__list deck-picker__list--order">
            {picked.map((path, i) => (
              <div key={path} className="deck-picker__row is-picked">
                <span className="deck-picker__position">{i + 1}</span>
                {pageName(path)}
                <span className="deck-picker__moves">
                  <button
                    className="ws-icon-btn"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    className="ws-icon-btn"
                    title="Move down"
                    disabled={i === picked.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <label className="deck-picker__option">
        <input
          type="checkbox"
          checked={sections}
          onChange={(e) => setSections(e.target.checked)}
        />
        A section slide before each page
      </label>
      {error && <div className="deck-picker__error">{error}</div>}
      <div className="deck-picker__actions">
        <button className="ws-text-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="ws-callout__btn"
          disabled={!picked.length || busy}
          onClick={create}
        >
          {busy
            ? "Creating…"
            : `Create deck${picked.length ? ` (${picked.length})` : ""}`}
        </button>
      </div>
    </div>
  );
};
