/**
 * Lays a parsed document out on the canvas as a single readable column:
 * headings, wrapped paragraphs, lists with hanging indents, quotes, code
 * blocks, tables and images. Everything stays editable (plain text elements
 * and shapes); code blocks and tables are grouped so they move as one.
 */
import {
  FONT_FAMILY,
  ROUNDNESS,
  getFontString,
  getLineHeight,
  randomId,
} from "@excalidraw/common";
import {
  charWidth,
  measureText,
  newElement,
  newImageElement,
  newLinearElement,
  newTextElement,
  syncInvalidIndices,
  wrapText,
} from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";
import { Fonts } from "@excalidraw/excalidraw/fonts/Fonts";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
  FontString,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import type { DocBlock, DocImage, TableCell } from "./docModel";
import type { LoadedImage } from "./images";

export const DOC_WIDTH = 760;

const BODY_FONT = FONT_FAMILY.Nunito as FontFamilyValues;
const CODE_FONT = FONT_FAMILY["Comic Shanns"] as FontFamilyValues;

const COLORS = {
  text: "#1e1e1e",
  muted: "#495057",
  subtle: "#868e96",
  rule: "#dee2e6",
  quoteBar: "#ced4da",
  codeBackground: "#f1f3f5",
  codeBorder: "#e9ecef",
  cellBorder: "#ced4da",
  headerBackground: "#e9ecef",
};

const SIZE = {
  body: 20,
  code: 16,
  table: 16,
  caption: 16,
  /** by heading level, 0 = document title */
  heading: [48, 38, 30, 25, 22, 20, 20],
};

const SPACE = {
  block: 18,
  listItem: 6,
  afterHeading: 12,
  beforeHeading: [36, 36, 30, 24, 20, 18, 18],
  listIndent: 32,
  quoteIndent: 28,
  codePadding: 16,
  cellPadding: 10,
};

const MAX_TABLE_WIDTH = 1200;
const MIN_COLUMN_WIDTH = 64;

const cleanText = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/\u00a0/g, " ")
    // zero-width & bidi controls that render as boxes
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "");

const safeLink = (links?: string[]) => {
  const link = links?.length === 1 ? links[0] : null;
  return link && /^(https?:|mailto:)/i.test(link) ? link : null;
};

/** every family/text the layout will use, so fonts can load before measuring */
const collectText = (blocks: DocBlock[], into: Map<number, string>) => {
  const add = (family: number, text: string) =>
    into.set(family, (into.get(family) || "") + text);
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        add(BODY_FONT, block.text);
        break;
      case "listItem":
        add(BODY_FONT, block.marker + block.text);
        break;
      case "quote":
        collectText(block.blocks, into);
        break;
      case "code":
        add(CODE_FONT, block.text);
        break;
      case "table":
        add(
          BODY_FONT,
          block.rows
            .flat()
            .map((cell) => cell.text)
            .join(""),
        );
        break;
      case "image":
        add(BODY_FONT, `🖼 ${block.alt}${block.src || ""}`);
        break;
    }
  }
  return into;
};

/**
 * Text is measured with the real fonts, so they have to be loaded first —
 * otherwise wrapping would be computed with a fallback font's metrics.
 */
const loadFonts = async (blocks: DocBlock[]) => {
  const texts = collectText(blocks, new Map());
  const probes = [...texts].map(
    ([fontFamily, text]) =>
      ({
        type: "text",
        fontFamily,
        text,
        originalText: text,
        isDeleted: false,
      } as unknown as ExcalidrawTextElement),
  );
  try {
    await Fonts.loadElementsFonts(probes);
  } catch (error) {
    console.warn("Couldn't load fonts for the imported document", error);
  }
};

export type LayoutResult = {
  elements: OrderedExcalidrawElement[];
  files: BinaryFiles;
  width: number;
  height: number;
};

export const layoutDocument = async (
  blocks: DocBlock[],
  opts: {
    x?: number;
    y?: number;
    width?: number;
    loadImage?: (image: DocImage) => Promise<LoadedImage | null>;
  } = {},
): Promise<LayoutResult> => {
  const originX = opts.x ?? 0;
  const originY = opts.y ?? 0;
  const contentWidth = opts.width ?? DOC_WIDTH;

  // images load in parallel, before anything is placed
  const imageBlocks: DocImage[] = [];
  const findImages = (list: DocBlock[]) =>
    list.forEach((block) => {
      if (block.type === "image") {
        imageBlocks.push(block);
      } else if (block.type === "quote") {
        findImages(block.blocks);
      }
    });
  findImages(blocks);
  const [, ...loaded] = await Promise.all([
    loadFonts(blocks),
    ...imageBlocks.map((image) =>
      opts.loadImage ? opts.loadImage(image) : Promise.resolve(null),
    ),
  ]);
  const loadedImages = new Map(
    imageBlocks.map((image, i) => [image, loaded[i] as LoadedImage | null]),
  );

  const elements: ExcalidrawElement[] = [];
  const files: BinaryFiles = {};
  let y = originY;
  let maxRight = originX + contentWidth;

  const fontsSeen = new Set<FontString>();
  const fontFor = (fontSize: number, fontFamily: FontFamilyValues) => {
    const font = getFontString({ fontSize, fontFamily });
    if (!fontsSeen.has(font)) {
      // drop widths cached before the font finished loading
      fontsSeen.add(font);
      charWidth.clearCache(font);
    }
    return font;
  };

  const shapeDefaults = {
    roughness: 0,
    opacity: 100,
    strokeWidth: 1,
    strokeStyle: "solid" as const,
    fillStyle: "solid" as const,
    locked: false,
  };

  /** a text element wrapped to `width`; returns it (not yet added) */
  const makeText = (
    rawText: string,
    o: {
      x: number;
      y: number;
      width: number;
      fontSize: number;
      fontFamily?: FontFamilyValues;
      color?: string;
      link?: string | null;
      groupIds?: string[];
    },
  ) => {
    const text = cleanText(rawText);
    const fontFamily = o.fontFamily ?? BODY_FONT;
    const font = fontFor(o.fontSize, fontFamily);
    const lineHeight = getLineHeight(fontFamily);
    const base = {
      x: o.x,
      y: o.y,
      fontSize: o.fontSize,
      fontFamily,
      lineHeight,
      textAlign: "left" as const,
      verticalAlign: "top" as const,
      strokeColor: o.color ?? COLORS.text,
      link: o.link ?? null,
      groupIds: o.groupIds ?? [],
      ...shapeDefaults,
    };
    const natural = measureText(text, font, lineHeight);
    if (natural.width <= o.width) {
      return newTextElement({ ...base, text, autoResize: true });
    }
    const element = newTextElement({
      ...base,
      text: wrapText(text, font, o.width),
      originalText: text,
      autoResize: false,
    });
    return { ...element, width: o.width };
  };

  const addText = (...args: Parameters<typeof makeText>) => {
    const element = makeText(...args);
    elements.push(element);
    return element;
  };

  const addRule = (x: number, top: number, width: number) => {
    elements.push(
      newLinearElement({
        type: "line",
        x,
        y: top,
        width,
        height: 0,
        points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(width, 0)],
        strokeColor: COLORS.rule,
        backgroundColor: "transparent",
        ...shapeDefaults,
        strokeWidth: 2,
      }),
    );
  };

  const layoutTable = (
    rows: TableCell[][],
    header: boolean,
    x: number,
    available: number,
  ) => {
    const groupId = randomId();
    const font = fontFor(SIZE.table, BODY_FONT);
    const lineHeight = getLineHeight(BODY_FONT);
    const pad = SPACE.cellPadding;
    const columns = Math.max(
      ...rows.map((row) =>
        row.reduce((sum, cell) => sum + (cell.span || 1), 0),
      ),
    );
    if (!columns) {
      return 0;
    }

    // natural (unwrapped) width of every column
    const natural = new Array(columns).fill(MIN_COLUMN_WIDTH);
    for (const row of rows) {
      let col = 0;
      for (const cell of row) {
        if ((cell.span || 1) === 1 && col < columns) {
          const width = cleanText(cell.text)
            .split("\n")
            .reduce(
              (max, line) =>
                Math.max(max, measureText(line, font, lineHeight).width),
              0,
            );
          natural[col] = Math.max(natural[col], Math.ceil(width) + pad * 2);
        }
        col += cell.span || 1;
      }
    }

    // fit to the width: narrow columns keep their size, wide ones share the rest
    const maxWidth = Math.max(
      available,
      Math.min(
        MAX_TABLE_WIDTH,
        natural.reduce((a, b) => a + b, 0),
      ),
    );
    const widths = [...natural];
    if (natural.reduce((a, b) => a + b, 0) > maxWidth) {
      let remaining = maxWidth;
      const order = natural
        .map((width, index) => ({ width, index }))
        .sort((a, b) => a.width - b.width);
      order.forEach(({ width, index }, i) => {
        const share = remaining / (order.length - i);
        widths[index] = Math.max(MIN_COLUMN_WIDTH, Math.min(width, share));
        remaining -= widths[index];
      });
    }
    const tableWidth = widths.reduce((a, b) => a + b, 0);
    maxRight = Math.max(maxRight, x + tableWidth);

    const top = y;
    let rowY = top;
    rows.forEach((row, rowIndex) => {
      const cells: {
        x: number;
        width: number;
        text: ExcalidrawElement | null;
      }[] = [];
      let col = 0;
      let cellX = x;
      let rowHeight = SIZE.table * lineHeight + pad * 2;
      for (let c = 0; c < row.length && col < columns; c++) {
        const cell = row[c];
        const span = Math.min(cell.span || 1, columns - col);
        // the last cell stretches over columns the row doesn't fill
        const lastSpan = c === row.length - 1 ? columns - col : span;
        const width = widths
          .slice(col, col + lastSpan)
          .reduce((a, b) => a + b, 0);
        const text = cell.text.trim()
          ? makeText(cell.text.trim(), {
              x: cellX + pad,
              y: rowY + pad,
              width: width - pad * 2,
              fontSize: SIZE.table,
              groupIds: [groupId],
            })
          : null;
        if (text) {
          rowHeight = Math.max(rowHeight, text.height + pad * 2);
        }
        cells.push({ x: cellX, width, text });
        cellX += width;
        col += lastSpan;
      }
      if (col < columns) {
        // a short row: fill it with empty cells
        cells.push({
          x: cellX,
          width: widths.slice(col).reduce((a, b) => a + b, 0),
          text: null,
        });
      }
      const isHeader = header && rowIndex === 0;
      for (const cell of cells) {
        elements.push(
          newElement({
            type: "rectangle",
            x: cell.x,
            y: rowY,
            width: cell.width,
            height: rowHeight,
            strokeColor: COLORS.cellBorder,
            backgroundColor: isHeader ? COLORS.headerBackground : "transparent",
            groupIds: [groupId],
            ...shapeDefaults,
          }),
        );
      }
      for (const cell of cells) {
        if (cell.text) {
          elements.push(cell.text);
        }
      }
      rowY += rowHeight;
    });
    return rowY - top;
  };

  const layoutImage = (image: DocImage, x: number, available: number) => {
    const data = loadedImages.get(image);
    if (!data) {
      const label = image.alt || image.src || "image";
      const element = addText(`🖼  ${label}`, {
        x,
        y,
        width: available,
        fontSize: 16,
        color: COLORS.subtle,
        link: safeLink(image.src ? [image.src] : undefined),
      });
      return element.height;
    }
    const intrinsicWidth = image.width || data.width;
    const ratio = data.height / data.width || 1;
    const width = Math.max(16, Math.min(intrinsicWidth, available));
    const height = width * ratio;
    files[data.id] = {
      id: data.id,
      dataURL: data.dataURL,
      mimeType: data.mimeType as BinaryFiles[string]["mimeType"],
      created: Date.now(),
      lastRetrieved: Date.now(),
    };
    elements.push(
      newImageElement({
        type: "image",
        x,
        y,
        width,
        height,
        fileId: data.id,
        status: "saved",
        scale: [1, 1],
        ...shapeDefaults,
      }),
    );
    return height;
  };

  const gapBefore = (previous: DocBlock | null, block: DocBlock) => {
    if (!previous) {
      return 0;
    }
    if (block.type === "heading") {
      return previous.type === "heading"
        ? SPACE.afterHeading
        : SPACE.beforeHeading[block.level];
    }
    if (previous.type === "heading") {
      return SPACE.afterHeading;
    }
    if (
      block.type === "paragraph" &&
      block.tone === "caption" &&
      previous.type === "image"
    ) {
      return SPACE.listItem;
    }
    if (block.type === "listItem" && previous.type === "listItem") {
      return SPACE.listItem;
    }
    return SPACE.block;
  };

  const layoutBlocks = (
    list: DocBlock[],
    indent: number,
    color: string = COLORS.text,
  ) => {
    let previous: DocBlock | null = null;
    for (const block of list) {
      const x = originX + indent;
      const available = contentWidth - indent;
      const gap = gapBefore(previous, block);
      y += gap;
      const before = y;

      switch (block.type) {
        case "heading": {
          const element = addText(block.text, {
            x,
            y,
            width: available,
            fontSize: SIZE.heading[block.level],
            color: block.level >= 5 ? COLORS.muted : color,
            link: safeLink(block.links),
          });
          y += element.height;
          break;
        }
        case "paragraph": {
          const caption = block.tone === "caption";
          const element = addText(block.text, {
            x,
            y,
            width: available,
            fontSize: caption ? SIZE.caption : SIZE.body,
            color: caption ? COLORS.subtle : color,
            link: safeLink(block.links),
          });
          y += element.height;
          break;
        }
        case "listItem": {
          const itemX = x + block.depth * SPACE.listIndent;
          const marker = block.marker
            ? addText(block.marker, {
                x: itemX,
                y,
                width: available,
                fontSize: SIZE.body,
                color: /^[•◦▪]$/.test(block.marker) ? COLORS.muted : color,
              })
            : null;
          const textX =
            itemX + Math.max(SPACE.listIndent - 4, (marker?.width ?? 0) + 10);
          const element = addText(block.text, {
            x: textX,
            y,
            width: Math.max(120, originX + contentWidth - textX),
            fontSize: SIZE.body,
            color,
            link: safeLink(block.links),
          });
          y += Math.max(element.height, marker?.height ?? 0);
          break;
        }
        case "quote": {
          const top = y;
          layoutBlocks(block.blocks, indent + SPACE.quoteIndent, COLORS.muted);
          if (y > top) {
            elements.push(
              newLinearElement({
                type: "line",
                x: x + 4,
                y: top,
                width: 0,
                height: y - top,
                points: [
                  pointFrom<LocalPoint>(0, 0),
                  pointFrom<LocalPoint>(0, y - top),
                ],
                strokeColor: COLORS.quoteBar,
                backgroundColor: "transparent",
                ...shapeDefaults,
                strokeWidth: 4,
              }),
            );
          }
          break;
        }
        case "code": {
          if (!block.text.trim()) {
            y -= gap;
            continue;
          }
          const groupId = randomId();
          const pad = SPACE.codePadding;
          const text = makeText(block.text, {
            x: x + pad,
            y: y + pad,
            width: available - pad * 2,
            fontSize: SIZE.code,
            fontFamily: CODE_FONT,
            groupIds: [groupId],
          });
          const height = text.height + pad * 2;
          elements.push(
            newElement({
              type: "rectangle",
              x,
              y,
              width: available,
              height,
              strokeColor: COLORS.codeBorder,
              backgroundColor: COLORS.codeBackground,
              roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
              groupIds: [groupId],
              ...shapeDefaults,
            }),
            text,
          );
          y += height;
          break;
        }
        case "table":
          y += layoutTable(block.rows, block.header, x, available);
          break;
        case "image":
          y += layoutImage(block, x, available);
          break;
        case "rule":
          addRule(x, y + 6, available);
          y += 12;
          break;
      }
      if (y === before && block.type !== "rule") {
        // nothing was placed (e.g. an empty quote)
        y -= gap;
        continue;
      }
      previous = block;
    }
  };

  layoutBlocks(blocks, 0);

  return {
    elements: syncInvalidIndices(elements),
    files,
    width: maxRight - originX,
    height: y - originY,
  };
};
