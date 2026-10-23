// Loaded source files and page rendering (PDF.js).

// The "legacy" build includes polyfills. It matters for Linux, where Tauri uses the
// system WebKitGTK, which often lags behind current JavaScript features.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PageRef } from "./core/model";
import { uid } from "./core/model";
import { extractPageText } from "./core/extract";
import type { PageText } from "./core/markdown";
import type { ImageFormat } from "./core/formats";
import { decodeImage, imagePagesToPdf } from "./images";
import { drawMarkOnCanvas } from "./core/marks";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

export interface PageInfo {
  /** Size in points at rotation 0 (after the page's own /Rotate). */
  width: number;
  height: number;
  rotate: number;
}

export class Source {
  readonly id = uid("src");
  pdf!: PDFDocumentProxy;
  private task: { destroy(): Promise<void> } | null = null;
  pages: PDFPageProxy[] = [];
  info: PageInfo[] = [];
  private textCache = new Map<number, Promise<string>>();
  /** For images: the original file, so it can be saved back at full quality. */
  original: { bytes: Uint8Array; format: ImageFormat; pointsPerPixel: number[] } | null = null;

  constructor(readonly name: string, readonly bytes: Uint8Array) {}

  static async loadImage(name: string, bytes: Uint8Array, format: ImageFormat): Promise<Source> {
    let pages;
    try {
      pages = await decodeImage(bytes, format);
    } catch (e: any) {
      throw new Error(`Couldn't open “${name}”: ${e?.message ?? e}`);
    }
    const { pdf, pointsPerPixel } = await imagePagesToPdf(pages, format);
    for (const c of pages) {
      c.width = 0;
      c.height = 0;
    }
    const src = await Source.load(name, pdf);
    src.original = { bytes, format, pointsPerPixel };
    return src;
  }

  static async load(name: string, bytes: Uint8Array): Promise<Source> {
    const src = new Source(name, bytes);
    const task = pdfjs.getDocument({
      data: bytes.slice(), // PDF.js takes ownership of the buffer it's given
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      wasmUrl: `${ASSETS}wasm/`,
      isEvalSupported: false,
    } as any);
    task.onPassword = () => {
      void task.destroy();
    };
    src.task = task;
    try {
      src.pdf = await task.promise;
    } catch (e: any) {
      if (e?.name === "PasswordException") throw new Error(`“${name}” is password-protected, which Unacro doesn't support yet.`);
      throw new Error(`Couldn't open “${name}”: ${e?.message ?? e}`);
    }
    const n = src.pdf.numPages;
    src.pages = new Array(n);
    src.info = new Array(n);
    const batch = 16;
    for (let start = 0; start < n; start += batch) {
      await Promise.all(
        Array.from({ length: Math.min(batch, n - start) }, async (_, k) => {
          const i = start + k;
          const page = await src.pdf.getPage(i + 1);
          const vp = page.getViewport({ scale: 1 });
          src.pages[i] = page;
          src.info[i] = { width: vp.width, height: vp.height, rotate: page.rotate };
        }),
      );
    }
    return src;
  }

  get pageCount() {
    return this.pages.length;
  }

  text(index: number): Promise<string> {
    let t = this.textCache.get(index);
    if (!t) {
      t = this.pages[index].getTextContent().then((tc) =>
        tc.items.map((it: any) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join(""),
      );
      this.textCache.set(index, t);
    }
    return t;
  }

  pageText(index: number, extraRotation: number): Promise<PageText> {
    return extractPageText(this.pages[index] as any, extraRotation);
  }

  destroy() {
    void this.task?.destroy();
  }
}

export class Sources {
  private map = new Map<string, Source>();
  add(s: Source) {
    this.map.set(s.id, s);
  }
  get(id: string): Source {
    const s = this.map.get(id);
    if (!s) throw new Error(`Unknown source ${id}`);
    return s;
  }
  bytesMap(): Map<string, Uint8Array> {
    return new Map([...this.map].map(([id, s]) => [id, s.bytes]));
  }
  /** Free sources no document refers to any more. */
  collect(inUse: Set<string>) {
    for (const [id, s] of this.map) {
      if (!inUse.has(id)) {
        s.destroy();
        this.map.delete(id);
      }
    }
  }
}

export function totalRotation(sources: Sources, ref: PageRef) {
  return (sources.get(ref.sourceId).info[ref.index].rotate + ref.rotation) % 360;
}

/** Displayed size in points, including all rotation. */
export function displaySize(sources: Sources, ref: PageRef) {
  if (ref.crop) {
    const w = ref.crop.x2 - ref.crop.x1, h = ref.crop.y2 - ref.crop.y1;
    return totalRotation(sources, ref) % 180 ? { width: h, height: w } : { width: w, height: h };
  }
  const info = sources.get(ref.sourceId).info[ref.index];
  const swap = ref.rotation % 180 !== 0;
  return swap ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

/** Where a cropped page's visible window sits inside the full page at `scale` (CSS px), or null if not cropped. */
export function cropWindow(sources: Sources, ref: PageRef, scale: number) {
  if (!ref.crop) return null;
  const vp = viewportFor(sources, ref, scale);
  const [ax, ay] = vp.convertToViewportPoint(ref.crop.x1, ref.crop.y1);
  const [bx, by] = vp.convertToViewportPoint(ref.crop.x2, ref.crop.y2);
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

export function viewportFor(sources: Sources, ref: PageRef, scale: number): PageViewport {
  const src = sources.get(ref.sourceId);
  return src.pages[ref.index].getViewport({ scale, rotation: totalRotation(sources, ref) });
}

// ------------------------------------------------------------ rendering

interface CacheEntry {
  bitmap: HTMLCanvasElement;
}
const renderCache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 60;

function remember(key: string, entry: CacheEntry) {
  renderCache.delete(key);
  renderCache.set(key, entry);
  while (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value!;
    const old = renderCache.get(oldest)!;
    old.bitmap.width = 0;
    old.bitmap.height = 0;
    renderCache.delete(oldest);
  }
}

/** Render a page into the given canvas at `scale` (CSS px per point). Uses a cache of recent renders. */
export async function renderInto(
  sources: Sources,
  ref: PageRef,
  scale: number,
  canvas: HTMLCanvasElement,
  isStillWanted: () => boolean,
): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  const rot = totalRotation(sources, ref);
  const key = `${ref.sourceId}:${ref.index}:${rot}:${Math.round(scale * dpr * 100)}`;
  const vp = viewportFor(sources, ref, scale * dpr);
  const cached = renderCache.get(key);
  const ctx = canvas.getContext("2d")!;
  if (cached) {
    remember(key, cached);
    canvas.width = cached.bitmap.width;
    canvas.height = cached.bitmap.height;
    ctx.drawImage(cached.bitmap, 0, 0);
    return;
  }
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.floor(vp.width));
  off.height = Math.max(1, Math.floor(vp.height));
  const page = sources.get(ref.sourceId).pages[ref.index];
  const task = page.render({ canvas: off, viewport: vp } as any);
  try {
    await task.promise;
  } catch (e: any) {
    if (e?.name === "RenderingCancelledException") return;
    throw e;
  }
  remember(key, { bitmap: off });
  if (!isStillWanted()) return;
  canvas.width = off.width;
  canvas.height = off.height;
  ctx.drawImage(off, 0, 0);
}

export async function renderTextLayer(sources: Sources, ref: PageRef, scale: number, container: HTMLElement) {
  const page = sources.get(ref.sourceId).pages[ref.index];
  const vp = viewportFor(sources, ref, scale);
  container.replaceChildren();
  container.style.setProperty("--total-scale-factor", String(scale));
  const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: vp });
  await layer.render();
}

// ------------------------------------------------------------ flattening to an image

async function bitmapFromPng(bytes: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
}

/**
 * Draw a page as it will look when saved: rotation and signatures included.
 * Image pages are drawn from the original pixels; PDF pages are rendered at 144 dpi.
 */
export async function flattenPage(
  sources: Sources,
  ref: PageRef,
  stampImages: Map<string, Uint8Array>,
  opaque: boolean,
): Promise<HTMLCanvasElement> {
  const src = sources.get(ref.sourceId);
  const page = src.pages[ref.index];
  const rotation = totalRotation(sources, ref);
  const scale = src.original ? 1 / src.original.pointsPerPixel[ref.index] : 2;
  const vp = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d")!;
  if (opaque) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const [a, b, c, d, e, f] = vp.transform;

  // Draw `img` into the page-space rectangle anchored at its bottom-left corner (x, y).
  const drawInPageSpace = (img: CanvasImageSource, x: number, y: number, w: number, h: number, deg: number) => {
    ctx.save();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.translate(x, y);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.scale(1, -1);
    ctx.drawImage(img, 0, -h, w, h);
    ctx.restore();
  };

  if (src.original) {
    const pages = await decodeImage(src.original.bytes, src.original.format);
    const img = pages[ref.index];
    const [x0, y0, x1, y1] = page.view;
    ctx.imageSmoothingEnabled = false;
    drawInPageSpace(img, x0, y0, x1 - x0, y1 - y0, 0);
    ctx.imageSmoothingEnabled = true;
  } else {
    await page.render({ canvas, viewport: vp, background: opaque ? "#fff" : "rgba(0,0,0,0)" } as any).promise;
  }

  ctx.save();
  ctx.setTransform(a, b, c, d, e, f);
  for (const m of ref.marks ?? []) drawMarkOnCanvas(ctx, m);
  ctx.restore();

  for (const s of ref.stamps) {
    const png = stampImages.get(s.imageId);
    if (!png) continue;
    const bmp = await bitmapFromPng(png);
    drawInPageSpace(bmp, s.x, s.y, s.width, s.height, s.rotation);
    bmp.close();
  }

  const win = cropWindow(sources, ref, scale);
  if (!win) return canvas;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(win.width));
  out.height = Math.max(1, Math.round(win.height));
  out.getContext("2d")!.drawImage(canvas, Math.round(win.left), Math.round(win.top), out.width, out.height, 0, 0, out.width, out.height);
  canvas.width = canvas.height = 0;
  return out;
}
