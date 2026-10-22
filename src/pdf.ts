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

  constructor(readonly name: string, readonly bytes: Uint8Array) {}

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
  const info = sources.get(ref.sourceId).info[ref.index];
  const swap = ref.rotation % 180 !== 0;
  return swap ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
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
