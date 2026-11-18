/**
 * Word (.docx) → DocBlock[].
 *
 * Reads the Office Open XML package directly: paragraphs (with heading /
 * quote / code styles), numbered & bulleted lists, tables, embedded images,
 * hyperlinks, text boxes and footnotes. Character formatting is dropped.
 */
import { bulletFor, toAlpha, toRoman } from "./docModel";
import { readZip } from "./zip";

import type { DocBlock, DocImage, TableCell } from "./docModel";
import type { ZipArchive } from "./zip";

const W_NS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const R_NS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const A_NS = [
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
];
const WP_NS = [
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
];
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const VML_NS = "urn:schemas-microsoft-com:vml";

const EMU_PER_PX = 9525;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
};

// xml helpers -----------------------------------------------------------------

const childElements = (node: Node | null | undefined): Element[] =>
  node
    ? (Array.from(node.childNodes).filter(
        (child) => child.nodeType === 1,
      ) as Element[])
    : [];

const isW = (node: Node | null | undefined, name?: string): boolean =>
  !!node &&
  node.nodeType === 1 &&
  W_NS.has((node as Element).namespaceURI || "") &&
  (!name || (node as Element).localName === name);

const wChild = (el: Element | null | undefined, name: string) =>
  childElements(el).find((child) => isW(child, name)) ?? null;

const wChildren = (el: Element | null | undefined, name: string) =>
  childElements(el).filter((child) => isW(child, name));

const nsAttr = (
  el: Element | null | undefined,
  name: string,
  namespaces: Set<string>,
) => {
  if (!el) {
    return null;
  }
  for (const attribute of Array.from(el.attributes)) {
    if (
      attribute.localName === name &&
      namespaces.has(attribute.namespaceURI || "")
    ) {
      return attribute.value;
    }
  }
  return null;
};

const wAttr = (el: Element | null | undefined, name: string) =>
  nsAttr(el, name, W_NS);

const wVal = (el: Element | null | undefined) => wAttr(el, "val");

/** a toggle property like <w:b/> or <w:b w:val="false"/> */
const isOn = (el: Element | null) => {
  if (!el) {
    return false;
  }
  const value = wVal(el);
  return value === null || !/^(0|false|off|none)$/i.test(value);
};

const descendants = (el: Element, namespaces: string[], name: string) =>
  namespaces.flatMap((ns) => Array.from(el.getElementsByTagNameNS(ns, name)));

const parseXml = (text: string | null): Document | null => {
  if (!text) {
    return null;
  }
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    return null;
  }
  return doc;
};

const resolvePath = (base: string, target: string) => {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const parts = base.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
};

// package parts ---------------------------------------------------------------

type Relationship = { target: string; external: boolean };

const readRelationships = (zip: ZipArchive, part: string) => {
  const slash = part.lastIndexOf("/");
  const dir = part.slice(0, slash);
  const relsPath = `${dir}/_rels/${part.slice(slash + 1)}.rels`;
  const rels = new Map<string, Relationship>();
  const doc = parseXml(zip.readText(relsPath));
  if (!doc) {
    return rels;
  }
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) {
      continue;
    }
    const external = rel.getAttribute("TargetMode") === "External";
    rels.set(id, {
      target: external ? target : resolvePath(dir, target),
      external,
    });
  }
  return rels;
};

const findMainPart = (zip: ZipArchive) => {
  const doc = parseXml(zip.readText("_rels/.rels"));
  const rel = doc
    ? Array.from(doc.getElementsByTagName("Relationship")).find((el) =>
        /\/officeDocument$/.test(el.getAttribute("Type") || ""),
      )
    : null;
  const target = rel?.getAttribute("Target");
  if (target && zip.has(resolvePath("", target))) {
    return resolvePath("", target);
  }
  return zip.has("word/document.xml") ? "word/document.xml" : null;
};

type StyleInfo = {
  name: string;
  basedOn: string | null;
  outline: number | null;
  numId: string | null;
  ilvl: number | null;
  size: number | null;
};

type ResolvedStyle = {
  heading: number | null;
  kind: "quote" | "code" | "caption" | null;
  numId: string | null;
  ilvl: number;
  size: number | null;
};

const readStyles = (doc: Document | null) => {
  const styles = new Map<string, StyleInfo>();
  let defaultParagraphStyle: string | null = null;
  let baseSize = 22; // half-points (11pt)

  if (doc) {
    const docDefaultSize = wVal(
      wChild(
        wChild(
          wChild(
            Array.from(doc.getElementsByTagNameNS("*", "docDefaults"))[0],
            "rPrDefault",
          ),
          "rPr",
        ),
        "sz",
      ),
    );
    if (docDefaultSize) {
      baseSize = Number(docDefaultSize) || baseSize;
    }
    for (const style of Array.from(doc.getElementsByTagNameNS("*", "style"))) {
      if (!isW(style) || wAttr(style, "type") !== "paragraph") {
        continue;
      }
      const id = wAttr(style, "styleId");
      if (!id) {
        continue;
      }
      const pPr = wChild(style, "pPr");
      const numPr = wChild(pPr, "numPr");
      const outline = wVal(wChild(pPr, "outlineLvl"));
      const size = wVal(wChild(wChild(style, "rPr"), "sz"));
      styles.set(id, {
        name: wVal(wChild(style, "name")) || id,
        basedOn: wVal(wChild(style, "basedOn")),
        outline: outline === null ? null : Number(outline),
        numId: wVal(wChild(numPr, "numId")),
        ilvl: numPr ? Number(wVal(wChild(numPr, "ilvl")) || 0) : null,
        size: size ? Number(size) : null,
      });
      if (isDefault(style)) {
        defaultParagraphStyle = id;
      }
    }
  }

  const normal = defaultParagraphStyle
    ? styles.get(defaultParagraphStyle)
    : null;
  if (normal?.size) {
    baseSize = normal.size;
  }

  const cache = new Map<string, ResolvedStyle>();
  const resolve = (id: string | null): ResolvedStyle => {
    const key = id ?? defaultParagraphStyle ?? "";
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const result: ResolvedStyle = {
      heading: null,
      kind: null,
      numId: null,
      ilvl: 0,
      size: null,
    };
    let current = key ? styles.get(key) : undefined;
    const seen = new Set<string>();
    let nameChecked = false;
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      const name = current.name.trim();
      if (!nameChecked) {
        // the most specific style's name decides the kind
        nameChecked = true;
        const heading = name.match(/^heading\s*(\d)$/i);
        if (heading) {
          result.heading = Math.min(6, Math.max(1, Number(heading[1])));
        } else if (/^title$/i.test(name)) {
          result.heading = 0;
        } else if (/^subtitle$/i.test(name)) {
          result.heading = 3;
        }
        if (/quote|^block text$/i.test(name)) {
          result.kind = "quote";
        } else if (/caption/i.test(name)) {
          result.kind = "caption";
        } else if (
          /^(source code|code|html preformatted|plain text|macro text|verbatim)/i.test(
            name,
          )
        ) {
          result.kind = "code";
        }
      }
      if (
        result.heading === null &&
        current.outline !== null &&
        current.outline < 6
      ) {
        result.heading = current.outline + 1;
      }
      if (result.numId === null && current.numId !== null) {
        result.numId = current.numId;
        result.ilvl = current.ilvl ?? 0;
      }
      if (result.size === null && current.size !== null) {
        result.size = current.size;
      }
      current = current.basedOn ? styles.get(current.basedOn) : undefined;
    }
    cache.set(key, result);
    return result;
  };

  return { resolve, baseSize, defaultParagraphStyle };
};

const isDefault = (style: Element) =>
  /^(1|true|on)$/i.test(wAttr(style, "default") || "");

type LevelDef = { format: string; text: string; start: number };

const readNumbering = (doc: Document | null) => {
  const abstracts = new Map<string, Map<number, LevelDef>>();
  const nums = new Map<
    string,
    { abstractId: string; overrides: Map<number, number> }
  >();
  if (doc) {
    for (const abstract of Array.from(
      doc.getElementsByTagNameNS("*", "abstractNum"),
    )) {
      const id = wAttr(abstract, "abstractNumId");
      if (!id) {
        continue;
      }
      const levels = new Map<number, LevelDef>();
      for (const lvl of wChildren(abstract, "lvl")) {
        levels.set(Number(wAttr(lvl, "ilvl") || 0), {
          format: wVal(wChild(lvl, "numFmt")) || "decimal",
          text: wVal(wChild(lvl, "lvlText")) ?? "",
          start: Number(wVal(wChild(lvl, "start")) || 1),
        });
      }
      abstracts.set(id, levels);
    }
    for (const num of Array.from(doc.getElementsByTagNameNS("*", "num"))) {
      const id = wAttr(num, "numId");
      const abstractId = wVal(wChild(num, "abstractNumId"));
      if (!id || !abstractId) {
        continue;
      }
      const overrides = new Map<number, number>();
      for (const override of wChildren(num, "lvlOverride")) {
        const start = wVal(wChild(override, "startOverride"));
        if (start !== null) {
          overrides.set(Number(wAttr(override, "ilvl") || 0), Number(start));
        }
      }
      nums.set(id, { abstractId, overrides });
    }
  }

  // lists sharing an abstract definition continue each other's numbering,
  // unless a list instance restarts it
  const counters = new Map<string, number[]>();

  const formatNumber = (value: number, format: string) => {
    switch (format) {
      case "lowerLetter":
        return toAlpha(value);
      case "upperLetter":
        return toAlpha(value).toUpperCase();
      case "lowerRoman":
        return toRoman(value);
      case "upperRoman":
        return toRoman(value).toUpperCase();
      case "decimalZero":
        return String(value).padStart(2, "0");
      default:
        return String(value);
    }
  };

  return (numId: string, ilvl: number): string | null => {
    const num = nums.get(numId);
    const levels = num ? abstracts.get(num.abstractId) : undefined;
    const level = levels?.get(ilvl);
    if (!num || !levels || !level || level.format === "bullet") {
      return bulletFor(ilvl);
    }
    if (level.format === "none") {
      return "";
    }
    const key = num.overrides.size ? `num:${numId}` : `abs:${num.abstractId}`;
    const values = counters.get(key) ?? [];
    const start = num.overrides.get(ilvl) ?? level.start;
    values[ilvl] = values[ilvl] === undefined ? start : values[ilvl] + 1;
    values.length = ilvl + 1;
    counters.set(key, values);

    const pattern = level.text || `%${ilvl + 1}.`;
    return pattern.replace(/%(\d)/g, (_, n: string) => {
      const index = Number(n) - 1;
      const def = levels.get(index);
      return formatNumber(
        values[index] ?? def?.start ?? 1,
        def?.format ?? "decimal",
      );
    });
  };
};

// document --------------------------------------------------------------------

type ParagraphContent = {
  text: string;
  links: string[];
  images: DocImage[];
  extraBlocks: DocBlock[];
  allBold: boolean;
  /** every run is in a monospace font (code pasted into a document) */
  allMono: boolean;
  minSize: number | null;
};

export const parseDocx = (bytes: Uint8Array): DocBlock[] => {
  const zip = readZip(bytes);
  const mainPart = findMainPart(zip);
  const doc = mainPart ? parseXml(zip.readText(mainPart)) : null;
  if (!mainPart || !doc) {
    throw new Error("This doesn't look like a Word (.docx) document");
  }
  const dir = mainPart.slice(0, mainPart.lastIndexOf("/"));
  const rels = readRelationships(zip, mainPart);
  const partFor = (type: string) => {
    for (const name of zip.names) {
      if (name.startsWith(`${dir}/`) && name.endsWith(`/${type}.xml`)) {
        return name;
      }
    }
    return `${dir}/${type}.xml`;
  };
  const styles = readStyles(parseXml(zip.readText(partFor("styles"))));
  const listMarker = readNumbering(
    parseXml(zip.readText(partFor("numbering"))),
  );

  // footnotes, numbered in order of reference
  const footnotesDoc = parseXml(zip.readText(partFor("footnotes")));
  const footnoteNumbers = new Map<string, number>();

  const imageFromRel = (
    relId: string | null,
    alt: string,
    width?: number,
    height?: number,
  ): DocImage | null => {
    const rel = relId ? rels.get(relId) : undefined;
    if (!rel) {
      return null;
    }
    if (rel.external) {
      return { type: "image", alt, src: rel.target, width, height };
    }
    const ext = rel.target.split(".").pop()?.toLowerCase() || "";
    const mimeType = IMAGE_TYPES[ext];
    const data = mimeType ? zip.read(rel.target) : null;
    if (!mimeType || !data) {
      return {
        type: "image",
        alt: alt || `${ext.toUpperCase() || "Embedded"} image`,
        src: rel.target.split("/").pop(),
        width,
        height,
      };
    }
    return {
      type: "image",
      alt,
      data: { bytes: data, mimeType },
      width,
      height,
    };
  };

  const drawingContent = (drawing: Element) => {
    const images: DocImage[] = [];
    const extraBlocks: DocBlock[] = [];

    const extent = descendants(drawing, WP_NS, "extent")[0];
    const docPr = descendants(drawing, WP_NS, "docPr")[0];
    const alt =
      docPr?.getAttribute("descr") || docPr?.getAttribute("title") || "";
    const cx = Number(extent?.getAttribute("cx"));
    const cy = Number(extent?.getAttribute("cy"));
    const width = cx > 0 ? cx / EMU_PER_PX : undefined;
    const height = cy > 0 ? cy / EMU_PER_PX : undefined;

    for (const blip of descendants(drawing, A_NS, "blip")) {
      const image = imageFromRel(
        nsAttr(blip, "embed", R_NS) || nsAttr(blip, "link", R_NS),
        alt,
        width,
        height,
      );
      if (image) {
        images.push(image);
      }
    }
    // legacy VML pictures
    for (const data of Array.from(
      drawing.getElementsByTagNameNS(VML_NS, "imagedata"),
    )) {
      const style = (data.parentNode as Element | null)?.getAttribute?.(
        "style",
      );
      const pt = (prop: string) => {
        const match = style?.match(new RegExp(`${prop}:\\s*([\\d.]+)pt`));
        return match ? (Number(match[1]) * 4) / 3 : undefined;
      };
      const image = imageFromRel(
        nsAttr(data, "id", R_NS),
        data.getAttribute("o:title") || alt,
        pt("width"),
        pt("height"),
      );
      if (image) {
        images.push(image);
      }
    }
    // horizontal lines (VML "hr" shapes)
    for (const shape of Array.from(
      drawing.getElementsByTagNameNS(VML_NS, "*"),
    )) {
      if (/^(t|true)$/i.test(shape.getAttribute("o:hr") || "")) {
        extraBlocks.push({ type: "rule" });
        break;
      }
    }
    // text boxes
    for (const box of Array.from(
      drawing.getElementsByTagNameNS("*", "txbxContent"),
    )) {
      const inner = blockContainer(box);
      if (inner.length) {
        extraBlocks.push({ type: "quote", blocks: inner });
      }
    }
    return { images, extraBlocks };
  };

  const paragraphContent = (
    p: Element,
    paragraphSize: number | null,
  ): ParagraphContent => {
    const content: ParagraphContent = {
      text: "",
      links: [],
      images: [],
      extraBlocks: [],
      allBold: true,
      allMono: true,
      minSize: null,
    };
    let sawText = false;

    const run = (r: Element) => {
      const rPr = wChild(r, "rPr");
      if (isOn(wChild(rPr, "vanish"))) {
        return;
      }
      let text = "";
      for (const child of childElements(r)) {
        if (child.namespaceURI === MC_NS) {
          const choice = childElements(child)[0];
          if (choice) {
            const extra = drawingContent(choice);
            content.images.push(...extra.images);
            content.extraBlocks.push(...extra.extraBlocks);
          }
          continue;
        }
        if (!isW(child)) {
          continue;
        }
        switch (child.localName) {
          case "t":
            text += child.textContent || "";
            break;
          case "tab":
          case "ptab":
            text += "\t";
            break;
          case "br":
          case "cr":
            text += "\n";
            break;
          case "noBreakHyphen":
            text += "-";
            break;
          case "drawing":
          case "pict":
          case "object": {
            const extra = drawingContent(child);
            content.images.push(...extra.images);
            content.extraBlocks.push(...extra.extraBlocks);
            break;
          }
          case "footnoteReference": {
            const id = wAttr(child, "id");
            if (id) {
              if (!footnoteNumbers.has(id)) {
                footnoteNumbers.set(id, footnoteNumbers.size + 1);
              }
              text += `[${footnoteNumbers.get(id)}]`;
            }
            break;
          }
        }
      }
      if (text.trim()) {
        sawText = true;
        const bold = isOn(wChild(rPr, "b")) || isOn(wChild(rPr, "bCs"));
        content.allBold = content.allBold && bold;
        const fonts = wChild(rPr, "rFonts");
        const fontName = `${wAttr(fonts, "ascii") || ""} ${
          wAttr(fonts, "hAnsi") || ""
        } ${wVal(wChild(rPr, "rStyle")) || ""}`;
        content.allMono = content.allMono && MONOSPACE.test(fontName);
        const sizeValue = wVal(wChild(rPr, "sz"));
        const size = sizeValue ? Number(sizeValue) : paragraphSize;
        if (size) {
          content.minSize =
            content.minSize === null ? size : Math.min(content.minSize, size);
        }
      }
      content.text += text;
    };

    const walk = (node: Element) => {
      for (const child of childElements(node)) {
        if (child.namespaceURI === MC_NS) {
          const choice = childElements(child)[0];
          if (choice) {
            walk(choice);
          }
          continue;
        }
        if (!isW(child)) {
          continue;
        }
        switch (child.localName) {
          case "r":
            run(child);
            break;
          case "hyperlink": {
            const rel = rels.get(nsAttr(child, "id", R_NS) || "");
            if (rel?.external) {
              content.links.push(rel.target);
            }
            walk(child);
            break;
          }
          case "sdt":
            walk(wChild(child, "sdtContent") ?? child);
            break;
          case "ins":
          case "moveTo":
          case "smartTag":
          case "customXml":
          case "fldSimple":
          case "bdo":
          case "dir":
          case "sdtContent":
            walk(child);
            break;
        }
      }
    };

    walk(p);
    if (!sawText) {
      content.allBold = false;
      content.allMono = false;
    }
    content.links = [...new Set(content.links)];
    return content;
  };

  /** block-level content of the body, a table cell, a text box… */
  const blockContainer = (container: Element, inTable = false): DocBlock[] => {
    const blocks: DocBlock[] = [];

    const paragraph = (p: Element) => {
      const pPr = wChild(p, "pPr");
      const style = styles.resolve(wVal(wChild(pPr, "pStyle")));
      const numPr = wChild(pPr, "numPr");
      const numId = numPr ? wVal(wChild(numPr, "numId")) : style.numId;
      const ilvl = numPr
        ? Number(wVal(wChild(numPr, "ilvl")) || 0)
        : style.ilvl;

      const content = paragraphContent(p, style.size);
      const text = content.text.replace(/\s+$/, "").replace(/^\n+/, "");
      const links = content.links.length ? content.links : undefined;

      if (text.trim()) {
        if (style.heading !== null) {
          blocks.push({
            type: "heading",
            level: style.heading as 0 | 1 | 2 | 3 | 4 | 5 | 6,
            text: text.trim(),
            links,
          });
        } else if (numId && numId !== "0") {
          blocks.push({
            type: "listItem",
            text: text.trim(),
            depth: Math.max(0, Math.min(8, ilvl)),
            marker: listMarker(numId, ilvl) ?? bulletFor(ilvl),
            links,
          });
        } else if (style.kind === "code" || (content.allMono && !inTable)) {
          blocks.push({ type: "code", text: content.text.replace(/\s+$/, "") });
        } else if (style.kind === "caption") {
          blocks.push({
            type: "paragraph",
            text: text.trim(),
            tone: "caption",
          });
        } else if (literalListItem(text)) {
          // lists typed out by hand or exported without numbering (Pages, textutil)
          const item = literalListItem(text)!;
          const ind = wChild(pPr, "ind");
          const left = Number(wAttr(ind, "left") || wAttr(ind, "start") || 0);
          blocks.push({
            type: "listItem",
            text: item.text,
            depth: Math.max(item.depth, Math.round(left / 720) - 1, 0),
            marker: item.marker,
            links,
          });
        } else if (style.kind === "quote") {
          blocks.push({
            type: "quote",
            blocks: [{ type: "paragraph", text: text.trim(), links }],
          });
        } else {
          const trimmed = text.trim();
          const ratio = content.minSize ? content.minSize / styles.baseSize : 1;
          const headingLike =
            !inTable &&
            trimmed.length <= 120 &&
            !trimmed.includes("\n") &&
            !/[.:;,]$/.test(trimmed);
          if (headingLike && ratio >= 1.15) {
            blocks.push({
              type: "heading",
              level: ratio >= 1.75 ? 1 : ratio >= 1.4 ? 2 : 3,
              text: trimmed,
              links,
            });
          } else if (headingLike && content.allBold && trimmed.length <= 80) {
            blocks.push({ type: "heading", level: 4, text: trimmed, links });
          } else {
            blocks.push({ type: "paragraph", text, links });
          }
        }
      }
      blocks.push(...content.images, ...content.extraBlocks);
    };

    const table = (tbl: Element) => {
      const rowElements: Element[] = [];
      const collectRows = (node: Element) => {
        for (const child of childElements(node)) {
          if (isW(child, "tr")) {
            rowElements.push(child);
          } else if (isW(child, "sdt")) {
            collectRows(wChild(child, "sdtContent") ?? child);
          } else if (isW(child, "customXml")) {
            collectRows(child);
          }
        }
      };
      collectRows(tbl);

      const rows: TableCell[][] = rowElements.map((tr) =>
        wChildren(tr, "tc").map((tc) => {
          const tcPr = wChild(tc, "tcPr");
          const span = Number(wVal(wChild(tcPr, "gridSpan")) || 1);
          const vMerge = wChild(tcPr, "vMerge");
          const continued = vMerge && wVal(vMerge) !== "restart";
          const text = continued
            ? ""
            : blockContainer(tc, true)
                .map((block) => blockText(block))
                .filter(Boolean)
                .join("\n");
          return { text, span: span > 1 ? span : undefined };
        }),
      );
      if (!rows.length) {
        return;
      }
      const look = wChild(wChild(tbl, "tblPr"), "tblLook");
      const lookValue = parseInt(wVal(look) || "0", 16) || 0;
      const header =
        !!wChild(wChild(rowElements[0], "trPr"), "tblHeader") ||
        /^(1|true|on)$/i.test(wAttr(look, "firstRow") || "") ||
        (lookValue & 0x20) !== 0;
      blocks.push({ type: "table", rows, header: header && rows.length > 1 });
    };

    const visit = (node: Element) => {
      for (const child of childElements(node)) {
        if (!isW(child)) {
          if (child.namespaceURI === MC_NS) {
            const choice = childElements(child)[0];
            if (choice) {
              visit(choice);
            }
          }
          continue;
        }
        switch (child.localName) {
          case "p":
            paragraph(child);
            break;
          case "tbl":
            table(child);
            break;
          case "sdt":
            visit(wChild(child, "sdtContent") ?? child);
            break;
          case "customXml":
          case "ins":
          case "moveTo":
            visit(child);
            break;
        }
      }
    };

    visit(container);
    return mergeAdjacent(blocks);
  };

  const body = Array.from(doc.getElementsByTagNameNS("*", "body"))[0];
  if (!body) {
    throw new Error("This Word document has no body");
  }
  const blocks = blockContainer(body);

  if (footnoteNumbers.size && footnotesDoc) {
    const notes = new Map<string, Element>();
    for (const note of Array.from(
      footnotesDoc.getElementsByTagNameNS("*", "footnote"),
    )) {
      const id = wAttr(note, "id");
      if (id) {
        notes.set(id, note);
      }
    }
    const footnotes: DocBlock[] = [];
    for (const [id, number] of footnoteNumbers) {
      const note = notes.get(id);
      if (!note) {
        continue;
      }
      const text = blockContainer(note, true)
        .map((block) => blockText(block))
        .filter(Boolean)
        .join(" ");
      footnotes.push({ type: "paragraph", text: `[${number}] ${text.trim()}` });
    }
    if (footnotes.length) {
      blocks.push({ type: "rule" }, ...footnotes);
    }
  }

  return blocks;
};

const MONOSPACE =
  /courier|menlo|monaco|consolas|mono|source code|fira code|inconsolata|lucida console|andale|verbatim/i;

/**
 * A paragraph that starts with a list marker followed by a tab (how Pages and
 * other converters export lists), or a bullet symbol and a space.
 */
const literalListItem = (text: string) => {
  const match = text.match(
    /^[ \t]*(?:([•◦▪‣⁃●○■□➢►])[ \t]+|([-–*]|\d{1,3}[.)]?|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\t+)(\S[\s\S]*)$/,
  );
  if (!match) {
    return null;
  }
  const symbol = match[1] || match[2];
  const depth = /[◦○]/.test(symbol) ? 1 : /[▪■□]/.test(symbol) ? 2 : 0;
  let marker = symbol;
  if (/^[-–*●➢►‣⁃]$/.test(symbol)) {
    marker = bulletFor(depth);
  } else if (/^\d+$/.test(symbol)) {
    marker = `${symbol}.`;
  }
  return { marker, depth, text: match[3].trim() };
};

/** plain text of a block, for table cells and footnotes */
const blockText = (block: DocBlock): string => {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "code":
      return block.text;
    case "listItem":
      return `${"  ".repeat(block.depth)}${block.marker} ${block.text}`;
    case "quote":
      return block.blocks.map(blockText).join("\n");
    case "table":
      return block.rows
        .map((row) => row.map((cell) => cell.text).join(" | "))
        .join("\n");
    case "image":
      return block.alt ? `[${block.alt}]` : "";
    default:
      return "";
  }
};

/** consecutive code lines form one block; consecutive quotes one quote */
const mergeAdjacent = (blocks: DocBlock[]) => {
  const merged: DocBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (block.type === "code" && previous?.type === "code") {
      merged[merged.length - 1] = {
        ...previous,
        text: `${previous.text}\n${block.text}`,
      };
    } else if (block.type === "quote" && previous?.type === "quote") {
      merged[merged.length - 1] = {
        type: "quote",
        blocks: [...previous.blocks, ...block.blocks],
      };
    } else {
      merged.push(block);
    }
  }
  return merged;
};
