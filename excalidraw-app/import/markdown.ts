/**
 * Markdown → DocBlock[] (CommonMark + common GFM: tables, task lists,
 * strikethrough, autolinks, front matter). Inline formatting is reduced to
 * plain text since canvas text has no rich formatting.
 */
import { bulletFor, decodeEntities } from "./docModel";

import type { DocBlock, TableCell } from "./docModel";

// inline ----------------------------------------------------------------------

const PLACEHOLDER = /\uE000(\d+)\uE000/g;

export const inlineText = (
  source: string,
): { text: string; links: string[] } => {
  const links: string[] = [];
  const stash: string[] = [];
  const hold = (value: string) => `\uE000${stash.push(value) - 1}\uE000`;

  let s = source;
  // code spans keep their content verbatim
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) =>
    hold(code.length > 2 ? code.replace(/^ ([\s\S]*) $/, "$1") : code),
  );
  // backslash escapes
  s = s.replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => hold(char));
  // autolinks
  s = s.replace(/<((?:https?|ftp|mailto):[^\s<>]+)>/gi, (_, url: string) => {
    links.push(url);
    return hold(url);
  });
  s = s.replace(/<([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/g, (_, mail: string) => {
    links.push(`mailto:${mail}`);
    return hold(mail);
  });
  const target = String.raw`\(\s*<?((?:[^()\s<>]|\([^()\s]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)`;
  // images → their alt text
  s = s.replace(new RegExp(String.raw`!\[([^\]]*)\]${target}`, "g"), "$1");
  // links → their text
  s = s.replace(
    new RegExp(String.raw`\[([^\]]*)\]${target}`, "g"),
    (_, text: string, url: string) => {
      if (url) {
        links.push(url);
      }
      return text;
    },
  );
  // reference links & footnote references
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/\[\^([^\]]+)\]/g, "[$1]");
  // html
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "");
  // emphasis, strikethrough, highlight
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  s = s.replace(/==(?=\S)([^=]*?\S)==/g, "$1");
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, "$1$2");
  s = s.replace(/(^|[^_\w])_(?=[^\s_])([^_]*?[^\s_])_(?![_\w])/g, "$1$2");

  s = decodeEntities(s);
  for (let i = 0; i < 4 && PLACEHOLDER.test(s); i++) {
    s = s.replace(PLACEHOLDER, (_, index: string) => stash[Number(index)]);
  }

  // bare URLs (GFM autolinks)
  for (const match of s.matchAll(/\bhttps?:\/\/[^\s<>]*[^\s<>().,;:!?'"*_]/g)) {
    links.push(match[0]);
  }

  return { text: s, links: [...new Set(links)] };
};

// blocks ----------------------------------------------------------------------

const RE = {
  blank: /^\s*$/,
  fence: /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  hr: /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  quote: /^ {0,3}> ?/,
  list: /^(\s*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/,
  tableSep: /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/,
  linkDef: /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S+/,
  image:
    /^\s*(?:\[\s*)?!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*["')])?\s*\)(?:\]\([^)]*\))?\s*$/,
  comment: /^ {0,3}<!--/,
  htmlBlock:
    /^ {0,3}<\/?(?:address|article|aside|blockquote|center|details|dialog|div|dl|dt|dd|figcaption|figure|footer|form|h[1-6]|header|hr|img|li|main|nav|ol|p|picture|pre|section|source|summary|table|tbody|td|tfoot|th|thead|tr|ul|video)\b[^>]*>/i,
  indentedCode: /^(?: {4}|\t)/,
};

const indentOf = (line: string) => {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width++;
    } else if (char === "\t") {
      width += 4 - (width % 4);
    } else {
      break;
    }
  }
  return width;
};

const stripIndent = (line: string, amount: number) => {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < amount) {
    if (line[i] === " ") {
      removed++;
    } else if (line[i] === "\t") {
      removed += 4 - (removed % 4);
    } else {
      break;
    }
    i++;
  }
  return line.slice(i);
};

/** splits a table row on unescaped pipes outside code spans */
const splitRow = (line: string): string[] => {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "\\" && row[i + 1] === "|") {
      current += "|";
      i++;
    } else if (char === "`") {
      inCode = !inCode;
      current += char;
    } else if (char === "|" && !inCode) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
};

/** joins paragraph lines: soft breaks become spaces, hard breaks newlines */
const joinLines = (lines: string[]) =>
  lines
    .map((line, i) => {
      const trimmed = line.trim();
      if (i === lines.length - 1) {
        return trimmed;
      }
      const hard = / {2,}$/.test(line) || /\\$/.test(trimmed);
      return hard ? `${trimmed.replace(/\\$/, "")}\n` : `${trimmed} `;
    })
    .join("");

const htmlImages = (html: string): DocBlock[] =>
  [...html.matchAll(/<img\b[^>]*>/gi)].flatMap((match) => {
    const tag = match[0];
    const src = tag.match(/\ssrc\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (!src) {
      return [];
    }
    const alt = decodeEntities(
      tag.match(/\salt\s*=\s*["']([^"']*)/i)?.[1] ?? "",
    );
    const width =
      Number(tag.match(/\swidth\s*=\s*["']?(\d+)/i)?.[1]) || undefined;
    const height =
      Number(tag.match(/\sheight\s*=\s*["']?(\d+)/i)?.[1]) || undefined;
    return [{ type: "image" as const, alt, src, width, height }];
  });

const skipFrontMatter = (lines: string[]) => {
  if (lines[0]?.trim() !== "---") {
    return 0;
  }
  for (let i = 1; i < Math.min(lines.length, 300); i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) {
      const body = lines.slice(1, i);
      return body.some((line) => /^[\w-][\w -]*:/.test(line)) ? i + 1 : 0;
    }
  }
  return 0;
};

export const parseMarkdown = (source: string): DocBlock[] => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let para: string[] = [];

  // list state: indentation of each open nesting level, and its numbering
  let listIndents: number[] = [];
  let counters: (number | null)[] = [];

  const resetList = () => {
    listIndents = [];
    counters = [];
  };

  const flushParagraph = () => {
    if (!para.length) {
      return;
    }
    const raw = joinLines(para);
    para = [];
    const image = raw.match(RE.image);
    if (image) {
      blocks.push({ type: "image", alt: image[1], src: image[2] });
      return;
    }
    const { text, links } = inlineText(raw);
    if (text.trim()) {
      blocks.push({ type: "paragraph", text: text.trim(), links });
    }
  };

  const isBlockStart = (line: string) =>
    RE.fence.test(line) ||
    RE.atx.test(line) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    RE.list.test(line) ||
    RE.comment.test(line) ||
    RE.htmlBlock.test(line);

  let i = skipFrontMatter(lines);

  while (i < lines.length) {
    const line = lines[i];

    if (RE.blank.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    // setext heading (underlined paragraph)
    const setext = para.length ? line.match(RE.setext) : null;
    if (setext) {
      const { text, links } = inlineText(joinLines(para));
      para = [];
      resetList();
      blocks.push({
        type: "heading",
        level: setext[1][0] === "=" ? 1 : 2,
        text: text.trim(),
        links,
      });
      i++;
      continue;
    }

    const fence = line.match(RE.fence);
    if (fence) {
      flushParagraph();
      const [, indent, marker, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const current = lines[i];
        const trimmed = current.trim();
        if (
          trimmed.startsWith(marker[0].repeat(marker.length)) &&
          /^(`+|~+)$/.test(trimmed)
        ) {
          i++;
          break;
        }
        body.push(stripIndent(current, indent.length));
        i++;
      }
      if (!indent.length) {
        resetList();
      }
      blocks.push({
        type: "code",
        text: body.join("\n").replace(/\s+$/, ""),
        lang: lang || undefined,
      });
      continue;
    }

    const atx = line.match(RE.atx);
    if (atx) {
      flushParagraph();
      resetList();
      const { text, links } = inlineText(atx[2] || "");
      blocks.push({
        type: "heading",
        level: atx[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: text.trim(),
        links,
      });
      i++;
      continue;
    }

    if (RE.hr.test(line)) {
      flushParagraph();
      resetList();
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (RE.quote.test(line)) {
      flushParagraph();
      resetList();
      const inner: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        if (RE.quote.test(current)) {
          inner.push(current.replace(RE.quote, ""));
        } else if (
          !RE.blank.test(current) &&
          inner.length &&
          !RE.blank.test(inner[inner.length - 1]) &&
          !isBlockStart(current)
        ) {
          inner.push(current); // lazy continuation
        } else if (
          RE.blank.test(current) &&
          i + 1 < lines.length &&
          RE.quote.test(lines[i + 1])
        ) {
          inner.push("");
        } else {
          break;
        }
        i++;
      }
      blocks.push({ type: "quote", blocks: parseMarkdown(inner.join("\n")) });
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      RE.tableSep.test(lines[i + 1]) &&
      (lines[i + 1].includes("|") || line.trim().startsWith("|"))
    ) {
      flushParagraph();
      resetList();
      const header = splitRow(line);
      const rows: TableCell[][] = [
        header.map((cell) => ({ text: inlineText(cell).text })),
      ];
      i += 2;
      while (
        i < lines.length &&
        !RE.blank.test(lines[i]) &&
        lines[i].includes("|")
      ) {
        const cells = splitRow(lines[i]);
        rows.push(
          header.map((_, col) => ({ text: inlineText(cells[col] ?? "").text })),
        );
        i++;
      }
      blocks.push({ type: "table", rows, header: true });
      continue;
    }

    const item = line.match(RE.list);
    if (item && !(para.length && /^\d/.test(item[2]) && item[2] !== "1.")) {
      flushParagraph();
      const indent = indentOf(item[1]);
      const marker = item[2];
      let first = item[3] ?? "";
      const contentIndent = indent + marker.length + 1;

      // nesting depth from indentation
      while (
        listIndents.length &&
        indent < listIndents[listIndents.length - 1]
      ) {
        listIndents.pop();
      }
      if (
        !listIndents.length ||
        indent >= listIndents[listIndents.length - 1] + 2
      ) {
        listIndents.push(indent);
      }
      const depth = listIndents.length - 1;
      counters = counters.slice(0, depth + 1);

      let label: string;
      if (/^\d/.test(marker)) {
        const delimiter = marker.slice(-1);
        const previous = counters[depth];
        const number =
          previous != null ? previous + 1 : parseInt(marker, 10) || 1;
        counters[depth] = number;
        label = `${number}${delimiter}`;
      } else {
        counters[depth] = null;
        label = bulletFor(depth);
      }
      const task = first.match(/^\[([ xX])\][ \t]+/);
      if (task) {
        label = task[1] === " " ? "☐" : "☑";
        first = first.slice(task[0].length);
      }

      // continuation lines
      const parts: string[] = [first];
      i++;
      while (i < lines.length) {
        const current = lines[i];
        if (RE.blank.test(current)) {
          // a blank line continues the item only if indented content follows
          let next = i + 1;
          while (next < lines.length && RE.blank.test(lines[next])) {
            next++;
          }
          if (
            next < lines.length &&
            indentOf(lines[next]) >= contentIndent &&
            !RE.list.test(lines[next]) &&
            !RE.fence.test(lines[next])
          ) {
            parts.push("\n");
            i = next;
            continue;
          }
          break;
        }
        if (
          RE.list.test(current) ||
          RE.fence.test(current) ||
          RE.atx.test(current) ||
          RE.hr.test(current) ||
          RE.quote.test(current.trimStart())
        ) {
          break;
        }
        parts.push(current);
        i++;
      }
      const raw = parts
        .reduce<string[][]>(
          (chunks, part) => {
            if (part === "\n") {
              chunks.push([]);
            } else {
              chunks[chunks.length - 1].push(part);
            }
            return chunks;
          },
          [[]],
        )
        .map(joinLines)
        .join("\n");
      const { text, links } = inlineText(raw);
      blocks.push({
        type: "listItem",
        text: text.trim(),
        depth,
        marker: label,
        links,
      });
      continue;
    }

    if (RE.comment.test(line) && !para.length) {
      while (i < lines.length && !lines[i].includes("-->")) {
        i++;
      }
      i++;
      continue;
    }

    if (RE.htmlBlock.test(line) && !para.length) {
      resetList();
      const html: string[] = [];
      while (i < lines.length && !RE.blank.test(lines[i])) {
        html.push(lines[i]);
        i++;
      }
      const joined = html.join("\n");
      blocks.push(...htmlImages(joined));
      const { text, links } = inlineText(
        joined.replace(/<img\b[^>]*>/gi, "").replace(/\n/g, " "),
      );
      if (text.trim()) {
        blocks.push({
          type: "paragraph",
          text: text.replace(/[ \t]+/g, " ").trim(),
          links,
        });
      }
      continue;
    }

    if (RE.linkDef.test(line) && !para.length) {
      i++;
      continue;
    }

    if (RE.indentedCode.test(line) && !para.length && !listIndents.length) {
      const body: string[] = [];
      while (
        i < lines.length &&
        (RE.indentedCode.test(lines[i]) || RE.blank.test(lines[i]))
      ) {
        body.push(stripIndent(lines[i], 4));
        i++;
      }
      blocks.push({ type: "code", text: body.join("\n").replace(/\s+$/, "") });
      continue;
    }

    if (!para.length && indentOf(line) === 0) {
      resetList();
    }
    para.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
};
