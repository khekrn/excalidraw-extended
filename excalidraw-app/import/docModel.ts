/**
 * The format-neutral shape of an imported document (Markdown, Word, text).
 * Parsers produce it; `layoutDocument` turns it into canvas elements.
 *
 * Inline formatting (bold, italic…) isn't representable on the canvas, so
 * text here is plain. Links are kept so a block with one link can carry it.
 */

export type DocImage = {
  type: "image";
  alt: string;
  /** where the image came from (URL / path), for placeholders */
  src?: string;
  /** the image itself, when the parser has it (e.g. embedded in a .docx) */
  data?: { bytes: Uint8Array; mimeType: string };
  /** intended display size in px, when the document says */
  width?: number;
  height?: number;
};

export type TableCell = { text: string; span?: number };

export type DocBlock =
  | {
      type: "heading";
      /** 0 = document title (Word "Title" style) */
      level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
      text: string;
      links?: string[];
    }
  | {
      type: "paragraph";
      text: string;
      links?: string[];
      /** "caption": small, muted text (e.g. under an image) */
      tone?: "caption";
    }
  | {
      type: "listItem";
      text: string;
      /** nesting depth, 0 = top level */
      depth: number;
      /** "•", "1.", "a)", "☐", "☑"… */
      marker: string;
      links?: string[];
    }
  | { type: "quote"; blocks: DocBlock[] }
  | { type: "code"; text: string; lang?: string }
  | { type: "table"; rows: TableCell[][]; header: boolean }
  | DocImage
  | { type: "rule" };

export const BULLETS = ["•", "◦", "▪"];

export const bulletFor = (depth: number) => BULLETS[depth % BULLETS.length];

export const toAlpha = (n: number) => {
  let out = "";
  let value = Math.max(1, n);
  while (value > 0) {
    value--;
    out = String.fromCharCode(97 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
};

export const toRoman = (n: number) => {
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let value = Math.max(1, Math.min(n, 3999));
  let out = "";
  for (const [amount, numeral] of table) {
    while (value >= amount) {
      out += numeral;
      value -= amount;
    }
  }
  return out;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rarr: "→",
  larr: "←",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  times: "×",
  deg: "°",
};

export const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      try {
        return Number.isFinite(value) && value > 0
          ? String.fromCodePoint(value)
          : match;
      } catch {
        return match;
      }
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });

/** plain text, one block per paragraph (blank-line separated) */
export const parsePlainText = (source: string): DocBlock[] =>
  source
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.replace(/\s+$/, "").replace(/^\n+/, ""))
    .filter((chunk) => chunk.trim())
    .map((text) => ({ type: "paragraph" as const, text }));
