// Core data model. Everything here is plain data so it can be cloned for undo.

/** A signature (or other image) placed on a page. */
export interface Stamp {
  id: string;
  /** Key into the image registry (PNG bytes). */
  imageId: string;
  /** Anchor = the image's bottom-left corner, in the source page's PDF user space. */
  x: number;
  y: number;
  /** Size in PDF points. */
  width: number;
  height: number;
  /** Counter-clockwise rotation of the image in PDF space, in degrees (0, 90, 180, 270). */
  rotation: number;
}

/** A markup shape drawn on a page. */
export type MarkType = "rect" | "oval" | "arrow";

export interface Mark {
  id: string;
  type: MarkType;
  /**
   * Two points in the source page's PDF user space. For rectangles and ovals they
   * are opposite corners of the bounding box; for arrows, the tail (1) and the tip (2).
   */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** "#rrggbb" */
  color: string;
  /** Line width in PDF points. */
  width: number;
}

/** A crop rectangle in the source page's PDF user space (x1 < x2, y1 < y2). */
export interface Crop {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One page in a document: a reference to a page of some loaded source file. */
export interface PageRef {
  id: string;
  sourceId: string;
  /** 0-based page index in the source file. */
  index: number;
  /** Extra clockwise rotation added on top of the page's own /Rotate (0, 90, 180, 270). */
  rotation: number;
  stamps: Stamp[];
  marks: Mark[];
  /** Visible part of the page, if cropped. */
  crop?: Crop | null;
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function normRotation(deg: number): number {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/** Deep copy of pages with fresh ids, e.g. when copying pages into another document. */
export function clonePages(pages: PageRef[]): PageRef[] {
  return pages.map((p) => ({
    ...p,
    id: uid("p"),
    stamps: p.stamps.map((s) => ({ ...s, id: uid("s") })),
    marks: p.marks.map((m) => ({ ...m, id: uid("m") })),
  }));
}

export function pagesForSource(sourceId: string, pageCount: number): PageRef[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    id: uid("p"),
    sourceId,
    index,
    rotation: 0,
    stamps: [],
    marks: [],
  }));
}

/** Move the pages with the given ids so they sit before position `to` (index into the original list). */
export function movePages(pages: PageRef[], ids: Set<string>, to: number): PageRef[] {
  const moving = pages.filter((p) => ids.has(p.id));
  const before = pages.slice(0, to).filter((p) => !ids.has(p.id));
  const after = pages.slice(to).filter((p) => !ids.has(p.id));
  return [...before, ...moving, ...after];
}
