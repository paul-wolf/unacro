import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPdf } from "../src/core/build";
import { arrowGeometry, hexToRgb01 } from "../src/core/marks";
import { pagesForSource, clonePages, type Mark } from "../src/core/model";
import { labeledPdf } from "./fixtures";

const mark = (type: Mark["type"], extra: Partial<Mark> = {}): Mark => ({
  id: "m", type, x1: 50, y1: 50, x2: 150, y2: 120, color: "#e5383b", width: 3, ...extra,
});

async function pathOps(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const ops = await (await doc.getPage(1)).getOperatorList();
  await task.destroy();
  const count = (fn: number) => ops.fnArray.filter((f: number) => f === fn).length;
  return { paths: count(pdfjs.OPS.constructPath) };
}

describe("arrowGeometry", () => {
  it("ends the shaft at the base of the head and puts the tip at the end point", () => {
    const g = arrowGeometry(mark("arrow", { x1: 0, y1: 0, x2: 100, y2: 0, width: 2 }))!;
    expect(g.head[0]).toEqual([100, 0]);
    const headLen = 2 * 3.5 + 7;
    expect(g.shaft[1][0]).toBeCloseTo(100 - headLen + 0.5);
    expect(g.head[1][0]).toBeCloseTo(100 - headLen);
    expect(Math.abs(g.head[1][1])).toBeCloseTo(2 * 1.8 + 4);
  });
  it("returns nothing for a zero-length arrow", () => {
    expect(arrowGeometry(mark("arrow", { x2: 50, y2: 50 }))).toBeNull();
  });
});

describe("hexToRgb01", () => {
  it("parses colours", () => {
    expect(hexToRgb01("#ff8000")).toEqual([1, 128 / 255, 0]);
  });
});

describe("marks in saved PDFs", () => {
  it("draws rectangles, ovals and arrows as vector graphics", async () => {
    const sources = new Map([["a", await labeledPdf("A", 1)]]);
    const plain = pagesForSource("a", 1);
    const marked = plain.map((p) => ({ ...p, marks: [mark("rect"), mark("oval"), mark("arrow")] }));
    const before = await pathOps(await buildPdf({ pages: plain, sources, images: new Map() }));
    const after = await pathOps(await buildPdf({ pages: marked, sources, images: new Map() }));
    // rectangle, oval, arrow shaft and arrow head each add a path
    // (PDF.js may fold the stroke/fill into the path operator, so count paths)
    expect(after.paths - before.paths).toBeGreaterThanOrEqual(4);
  });

  it("copies marks with new ids when pages are cloned", () => {
    const [p] = pagesForSource("a", 1).map((p) => ({ ...p, marks: [mark("rect")] }));
    const [c] = clonePages([p]);
    expect(c.marks).toHaveLength(1);
    expect(c.marks[0].id).not.toBe(p.marks[0].id);
    expect(c.marks[0].x2).toBe(150);
  });
});
