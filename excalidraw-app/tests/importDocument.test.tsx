import React from "react";
import { deflateRaw } from "pako";

import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { parseDocx } from "../import/docx";
import { insertDocumentsIntoCanvas } from "../import/importFiles";
import { layoutDocument } from "../import/layout";
import { parseMarkdown } from "../import/markdown";

import type { DocBlock } from "../import/docModel";

// -----------------------------------------------------------------------------
// a tiny ZIP writer, to build .docx packages in tests
// -----------------------------------------------------------------------------

const zip = (entries: Record<string, string | Uint8Array>) => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];

  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === "string" ? encoder.encode(content) : content;
    const data = deflateRaw(raw);
    const nameBytes = encoder.encode(name);
    const fields = [
      ...u16(20), // version
      ...u16(0), // flags
      ...u16(8), // deflate
      ...u16(0),
      ...u16(0), // time, date
      ...u32(0), // crc (not checked by the reader)
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(0), // extra
    ];
    const local = new Uint8Array([...u32(0x04034b50), ...fields, ...nameBytes]);
    chunks.push(local, data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...fields,
        ...u16(0), // comment
        ...u16(0), // disk
        ...u16(0), // internal attrs
        ...u32(0), // external attrs
        ...u32(offset),
        ...nameBytes,
      ]),
    );
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const count = central.length;
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"`;

const para = (text: string, pPr = "", rPr = "") =>
  `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const styled = (style: string, text: string) =>
  para(text, `<w:pStyle w:val="${style}"/>`);
const listPara = (numId: number, ilvl: number, text: string) =>
  para(
    text,
    `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`,
  );

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const buildDocx = () =>
  zip({
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/></Relationships>`,
    "word/styles.xml": `<?xml version="1.0"?><w:styles ${W}>
      <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Kop1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Custom2"><w:name w:val="My section"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
      <w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/></w:style>
    </w:styles>`,
    "word/numbering.xml": `<?xml version="1.0"?><w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
      </w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
    </w:numbering>`,
    "word/footnotes.xml": `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="2">${para(
      "A note.",
    )}</w:footnote></w:footnotes>`,
    "word/media/pic.png": PNG,
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>
      ${styled("Title", "Report")}
      ${styled("Kop1", "Intro")}
      ${styled("Custom2", "Outline level heading")}
      <w:p><w:r><w:t xml:space="preserve">See the </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>site</w:t></w:r></w:hyperlink><w:r><w:footnoteReference w:id="2"/></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:ins><w:r><w:t xml:space="preserve"> now</w:t></w:r></w:ins></w:p>
      ${listPara(1, 0, "One")}
      ${listPara(1, 1, "Sub a")}
      ${listPara(1, 1, "Sub b")}
      ${listPara(1, 0, "Two")}
      ${listPara(2, 0, "Bullet")}
      ${styled("Quote", "Wise words")}
      ${styled("SourceCode", "line1")}
      ${styled("SourceCode", "  line2")}
      <w:tbl><w:tblPr/><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${para(
        "Name",
      )}</w:tc><w:tc>${para(
      "Role",
    )}</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${para(
      "Spans both",
    )}</w:tc></w:tr></w:tbl>
      <w:p><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="Pic"/><a:graphic><a:graphicData><a:blip r:embed="rId2"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
      <w:p><w:r><w:pict><v:rect o:hr="t"/></w:pict></w:r></w:p>
      ${para("Bold label", "", "<w:b/>")}
      ${para("Big words", "", '<w:sz w:val="44"/>')}
      ${para("<w:t>hidden</w:t>", "", "<w:vanish/>")}
      ${para("\t1\tTyped list item", '<w:ind w:left="720"/>')}
      ${para(
        "let x = 1;",
        "",
        '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>',
      )}
      <w:sectPr/>
    </w:body></w:document>`,
  });

// -----------------------------------------------------------------------------

describe("markdown import", () => {
  it("parses blocks, nesting and inline formatting", () => {
    const blocks = parseMarkdown(
      [
        "---",
        "title: Front matter is skipped",
        "---",
        "# Plan",
        "",
        "Some **bold** and _italic_ with a [link](https://example.com) and `code *kept*`,",
        "continued here.  ",
        "Hard break above. snake_case_word stays.",
        "",
        "1. First",
        "   - nested *one*",
        "   - [x] nested task",
        "1. Second",
        "",
        "- [ ] todo",
        "",
        "> quoted",
        "> - list in quote",
        "",
        "```js",
        "  indented();",
        "```",
        "",
        "| A | B |",
        "|---|:-:|",
        "| 1 | x \\| y |",
        "",
        "![Alt text](img/pic.png)",
        "",
        "Under",
        "=====",
        "",
        "---",
        "",
        "<!-- a comment -->",
        "[ref]: https://example.com/ref",
        "Done &amp; dusted.",
      ].join("\n"),
    );

    expect(blocks).toEqual<DocBlock[]>([
      { type: "heading", level: 1, text: "Plan", links: [] },
      {
        type: "paragraph",
        text: "Some bold and italic with a link and code *kept*, continued here.\nHard break above. snake_case_word stays.",
        links: ["https://example.com"],
      },
      { type: "listItem", text: "First", depth: 0, marker: "1.", links: [] },
      {
        type: "listItem",
        text: "nested one",
        depth: 1,
        marker: "◦",
        links: [],
      },
      {
        type: "listItem",
        text: "nested task",
        depth: 1,
        marker: "☑",
        links: [],
      },
      { type: "listItem", text: "Second", depth: 0, marker: "2.", links: [] },
      { type: "listItem", text: "todo", depth: 0, marker: "☐", links: [] },
      {
        type: "quote",
        blocks: [
          { type: "paragraph", text: "quoted", links: [] },
          {
            type: "listItem",
            text: "list in quote",
            depth: 0,
            marker: "•",
            links: [],
          },
        ],
      },
      { type: "code", text: "  indented();", lang: "js" },
      {
        type: "table",
        header: true,
        rows: [
          [{ text: "A" }, { text: "B" }],
          [{ text: "1" }, { text: "x | y" }],
        ],
      },
      { type: "image", alt: "Alt text", src: "img/pic.png" },
      { type: "heading", level: 1, text: "Under", links: [] },
      { type: "rule" },
      { type: "paragraph", text: "Done & dusted.", links: [] },
    ]);
  });
});

describe("docx import", () => {
  it("reads styles, lists, links, tables, images and footnotes", () => {
    const blocks = parseDocx(buildDocx());
    const image = blocks.find((block) => block.type === "image") as any;
    expect(image).toMatchObject({ alt: "Pic", width: 200, height: 100 });
    expect(image.data.mimeType).toBe("image/png");
    expect(Array.from(image.data.bytes)).toEqual(Array.from(PNG));

    expect(
      blocks.map((block) =>
        block.type === "image" ? { type: "image" } : block,
      ),
    ).toEqual([
      { type: "heading", level: 0, text: "Report" },
      { type: "heading", level: 1, text: "Intro" },
      { type: "heading", level: 2, text: "Outline level heading" },
      {
        type: "paragraph",
        text: "See the site[1] now",
        links: ["https://example.com"],
      },
      { type: "listItem", text: "One", depth: 0, marker: "1." },
      { type: "listItem", text: "Sub a", depth: 1, marker: "a)" },
      { type: "listItem", text: "Sub b", depth: 1, marker: "b)" },
      { type: "listItem", text: "Two", depth: 0, marker: "2." },
      { type: "listItem", text: "Bullet", depth: 0, marker: "•" },
      {
        type: "quote",
        blocks: [{ type: "paragraph", text: "Wise words" }],
      },
      { type: "code", text: "line1\n  line2" },
      {
        type: "table",
        header: true,
        rows: [
          [{ text: "Name" }, { text: "Role" }],
          [{ text: "Spans both", span: 2 }],
        ],
      },
      { type: "image" },
      { type: "rule" },
      { type: "heading", level: 4, text: "Bold label" },
      { type: "heading", level: 1, text: "Big words" },
      { type: "listItem", text: "Typed list item", depth: 0, marker: "1." },
      { type: "code", text: "let x = 1;" },
      { type: "rule" },
      { type: "paragraph", text: "[1] A note." },
    ]);
  });

  it("rejects files that aren't Word documents", () => {
    expect(() => parseDocx(new TextEncoder().encode("hello"))).toThrow(
      /not a valid \.docx/i,
    );
  });
});

describe("document layout", () => {
  it("lays blocks out top to bottom as editable elements", async () => {
    const longText = "word ".repeat(80).trim();
    const { elements, files, height } = await layoutDocument(
      [
        { type: "heading", level: 1, text: "Title" },
        { type: "paragraph", text: longText, links: ["https://example.com"] },
        { type: "listItem", text: "Item", depth: 1, marker: "1." },
        { type: "code", text: "const a = 1;" },
        {
          type: "table",
          header: true,
          rows: [[{ text: "A" }, { text: "B" }], [{ text: "Spans", span: 2 }]],
        },
        { type: "quote", blocks: [{ type: "paragraph", text: "Quoted" }] },
        { type: "image", alt: "Missing", src: "nowhere.png" },
        { type: "rule" },
      ],
      { x: 100, y: 50 },
    );

    const texts = elements.filter((el) => el.type === "text") as any[];
    const title = texts.find((el) => el.text === "Title");
    expect(title).toMatchObject({ x: 100, y: 50, fontSize: 38 });

    // long paragraphs wrap to the column width and keep their link
    const paragraph = texts.find((el) => el.originalText === longText);
    expect(paragraph.autoResize).toBe(false);
    expect(paragraph.width).toBe(760);
    expect(paragraph.text).toContain("\n");
    expect(paragraph.link).toBe("https://example.com");
    expect(paragraph.y).toBeGreaterThan(title.y + title.height);

    // list items: indented marker, text after it (hanging indent)
    const marker = texts.find((el) => el.text === "1.");
    const item = texts.find((el) => el.text === "Item");
    expect(marker.x).toBe(100 + 32);
    expect(item.x).toBeGreaterThan(marker.x + marker.width);
    expect(item.y).toBe(marker.y);

    // code: a background box grouped with its text
    const code = texts.find((el) => el.text === "const a = 1;");
    const codeBox = elements.find(
      (el) => el.type === "rectangle" && el.groupIds[0] === code.groupIds[0],
    )!;
    expect(code.groupIds).toHaveLength(1);
    expect(codeBox.backgroundColor).not.toBe("transparent");
    expect(code.y).toBeGreaterThan(codeBox.y);

    // table: one cell rectangle per cell, the spanning cell is full width
    const tableGroup = texts.find((el) => el.text === "A").groupIds[0];
    const cells = elements.filter(
      (el) => el.type === "rectangle" && el.groupIds[0] === tableGroup,
    );
    expect(cells).toHaveLength(3);
    expect(cells[2].width).toBeCloseTo(cells[0].width + cells[1].width);

    // quote bar, rule
    const lines = elements.filter((el) => el.type === "line");
    expect(lines).toHaveLength(2);

    // an image that couldn't be loaded becomes a labelled placeholder
    expect(texts.some((el) => el.text.includes("Missing"))).toBe(true);
    expect(Object.keys(files)).toHaveLength(0);

    // reading order = vertical order
    const tops = texts
      .filter((el) => el.x <= 160)
      .map((el) => el.y as number)
      .filter((y, i, all) => i === 0 || y !== all[i - 1]);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    expect(height).toBeGreaterThan(300);
    // valid fractional indices for the scene
    expect(elements.every((el) => typeof el.index === "string")).toBe(true);
  });

  it("embeds loaded images as files", async () => {
    const { elements, files } = await layoutDocument(
      [{ type: "image", alt: "", width: 2000, height: 1000 }],
      {
        loadImage: async () => ({
          id: "file-1" as any,
          dataURL: "data:image/png;base64,AAAA" as any,
          mimeType: "image/png",
          width: 2000,
          height: 1000,
        }),
      },
    );
    const image = elements[0] as any;
    expect(image).toMatchObject({ type: "image", fileId: "file-1" });
    // scaled down to the column, aspect ratio kept
    expect(image.width).toBe(760);
    expect(image.height).toBe(380);
    expect(files["file-1"]).toMatchObject({ mimeType: "image/png" });
  });
});

describe("dropping documents on the canvas", () => {
  it("inserts them where they're dropped, selected", async () => {
    const ready = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw onExcalidrawAPI={(api) => ready.resolve(api as any)} />,
    );
    const api = await ready;

    const file = new File(["# Notes\n\n- one\n- two\n"], "notes.md", {
      type: "text/markdown",
    });
    const { offsetLeft, offsetTop, zoom, scrollX, scrollY } = api.getAppState();
    await act(() =>
      insertDocumentsIntoCanvas(api, [file], {
        clientX: offsetLeft + 300,
        clientY: offsetTop + 200,
      }),
    );

    const elements = api.getSceneElements();
    const heading = elements.find(
      (el) => el.type === "text" && (el as any).text === "Notes",
    )!;
    expect(heading.x).toBeCloseTo(300 / zoom.value - scrollX);
    expect(heading.y).toBeCloseTo(200 / zoom.value - scrollY);
    expect(elements).toHaveLength(5); // heading + 2 × (marker + text)
    const selected = api.getAppState().selectedElementIds;
    expect(elements.every((el) => selected[el.id])).toBe(true);
  });
});
