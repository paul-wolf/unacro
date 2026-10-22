// Turn a list of PageRefs into PDF bytes with pdf-lib.
//
// To keep as much of the original file as possible (bookmarks, form fields,
// metadata), the source that contributes the most pages is used as the base
// document and edited in place. Pages from other sources are copied in.

import { PDFDocument, PDFName, PDFPage, degrees } from "pdf-lib";
import type { PageRef } from "./model";

export interface BuildInput {
  pages: PageRef[];
  /** Original bytes of each source file, by source id. */
  sources: Map<string, Uint8Array>;
  /** PNG bytes of stamp images, by image id. */
  images: Map<string, Uint8Array>;
}

const INHERITABLE = ["MediaBox", "CropBox", "Rotate", "Resources"];

/** Copy inherited page attributes onto the page itself so it survives being moved in the page tree. */
function materializeInherited(page: PDFPage) {
  const node = page.node;
  for (const key of INHERITABLE) {
    const name = PDFName.of(key);
    if (node.get(name) === undefined) {
      const value = node.getInheritableAttribute(name);
      if (value !== undefined) node.set(name, value);
    }
  }
}

function pickBase(pages: PageRef[]): string | null {
  const counts = new Map<string, number>();
  for (const p of pages) counts.set(p.sourceId, (counts.get(p.sourceId) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}

export async function buildPdf({ pages, sources, images }: BuildInput): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("A document needs at least one page.");

  const baseId = pickBase(pages)!;
  const baseBytes = sources.get(baseId);
  if (!baseBytes) throw new Error(`Missing source ${baseId}`);
  const out = await PDFDocument.load(baseBytes, { ignoreEncryption: true, updateMetadata: false });

  // Load every other source once.
  const loaded = new Map<string, PDFDocument>();
  for (const p of pages) {
    if (p.sourceId === baseId || loaded.has(p.sourceId)) continue;
    const bytes = sources.get(p.sourceId);
    if (!bytes) throw new Error(`Missing source ${p.sourceId}`);
    loaded.set(p.sourceId, await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }));
  }

  // Decide which PDFPage object each output page uses. The first use of a base
  // page reuses the original object; repeats are copied.
  const basePages = out.getPages();
  basePages.forEach(materializeInherited);
  const used = new Set<number>();
  const finalPages: PDFPage[] = [];
  const copyRequests: { slot: number; from: PDFDocument; index: number }[] = [];

  pages.forEach((p, slot) => {
    if (p.sourceId === baseId && !used.has(p.index)) {
      used.add(p.index);
      finalPages[slot] = basePages[p.index];
    } else {
      copyRequests.push({ slot, from: p.sourceId === baseId ? out : loaded.get(p.sourceId)!, index: p.index });
    }
  });

  // Group copies by source document for efficiency.
  const bySource = new Map<PDFDocument, { slot: number; index: number }[]>();
  for (const r of copyRequests) {
    const list = bySource.get(r.from) ?? [];
    list.push(r);
    bySource.set(r.from, list);
  }
  for (const [from, reqs] of bySource) {
    const copied = await out.copyPages(from, reqs.map((r) => r.index));
    reqs.forEach((r, i) => (finalPages[r.slot] = copied[i]));
  }

  // Rebuild the page tree in the new order.
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  finalPages.forEach((page, i) => out.insertPage(i, page));

  // Rotation and stamps.
  const embedded = new Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    const page = finalPages[i];
    if (ref.rotation) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((((current + ref.rotation) % 360) + 360) % 360));
    }
    for (const s of ref.stamps) {
      let img = embedded.get(s.imageId);
      if (!img) {
        const png = images.get(s.imageId);
        if (!png) throw new Error(`Missing image ${s.imageId}`);
        img = await out.embedPng(png);
        embedded.set(s.imageId, img);
      }
      page.drawImage(img, { x: s.x, y: s.y, width: s.width, height: s.height, rotate: degrees(s.rotation) });
    }
  }

  out.setProducer("Unacro");
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}
