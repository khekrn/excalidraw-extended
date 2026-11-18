/**
 * Minimal PDF writer: one JPEG image per page (no dependencies).
 */
import { getNonDeletedElements } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getSlides, renderJpeg } from "./slides";

type PdfPage = { jpeg: Uint8Array; width: number; height: number };

const encoder = new TextEncoder();

export const buildPdf = (pages: PdfPage[]): Blob => {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string | (() => void)) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    if (typeof body === "string") {
      push(body);
    } else {
      body();
    }
    push("\nendobj\n");
  };

  // object ids: 1 catalog, 2 pages, then 3 per page (page, content, image)
  const pageIds = pages.map((_, i) => 3 + i * 3);

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] >>`,
  );

  pages.forEach((page, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    // 960pt wide (13.33in, like a 16:9 slide), height from the aspect ratio
    const pageWidth = 960;
    const pageHeight = Math.round((pageWidth * page.height) / page.width);
    const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;

    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    object(
      contentId,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
    object(imageId, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      );
      push(page.jpeg);
      push("\nendstream");
    });
  });

  const objectCount = 3 + pages.length * 3;
  const xrefOffset = length;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objectCount; id++) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
};

const download = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/**
 * One page per slide (frame) if the drawing has slides, otherwise the whole
 * canvas on one page.
 */
export const exportToPdf = async (
  api: ExcalidrawImperativeAPI,
  opts: { onProgress?: (done: number, total: number) => void } = {},
) => {
  const elements = getNonDeletedElements(api.getSceneElements());
  if (!elements.length) {
    throw new Error("Nothing to export — the canvas is empty.");
  }
  const slides = getSlides(elements);
  const targets = slides.length ? slides : [null];
  const pages: PdfPage[] = [];
  for (let i = 0; i < targets.length; i++) {
    opts.onProgress?.(i, targets.length);
    pages.push(await renderJpeg(api, targets[i]));
  }
  opts.onProgress?.(targets.length, targets.length);
  const name = api.getName() || "drawing";
  download(buildPdf(pages), `${name}.pdf`);
  return { pages: pages.length, slides: slides.length };
};
