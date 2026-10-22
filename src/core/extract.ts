// Convert PDF.js text content into display-space TextRuns for the Markdown converter.
// Typed loosely so it works with both the browser and the Node (legacy) builds of PDF.js.

import type { PageText, TextRun } from "./markdown";

type Matrix = number[];

function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

interface PdfjsPageLike {
  rotate: number;
  getViewport(opts: { scale: number; rotation?: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: any[] }>;
}

export async function extractPageText(page: PdfjsPageLike, extraRotation = 0): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + extraRotation) % 360 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (typeof item.str !== "string") continue; // marked-content markers
    const tx = mul(viewport.transform, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    // Width is along the text direction; for upright text this is just scaled width.
    const scaleX = Math.hypot(viewport.transform[0], viewport.transform[1]);
    runs.push({ str: item.str, x: tx[4], y: tx[5], size, width: (item.width ?? 0) * scaleX });
  }
  return { width: viewport.width, height: viewport.height, runs };
}
