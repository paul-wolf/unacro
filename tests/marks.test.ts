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

describe("crop in saved PDFs", () => {
  it("sets the crop box", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const sources = new Map([["a", await labeledPdf("A", 1)]]);
    const pages = pagesForSource("a", 1).map((p) => ({ ...p, crop: { x1: 40, y1: 300, x2: 260, y2: 450 } }));
    const out = await PDFDocument.load(await buildPdf({ pages, sources, images: new Map() }));
    expect(out.getPages()[0].getCropBox()).toEqual({ x: 40, y: 300, width: 220, height: 150 });
  });
});

describe("callouts", async () => {
  const { layoutCallout, leader, wrapText } = await import("../src/core/callout");
  const measure = (s: string) => s.length * 7; // monospace stand-in: 7pt per character

  it("wraps text to the box width and breaks long words", () => {
    expect(wrapText("one two three four", 7 * 9, measure)).toEqual(["one two", "three", "four"]);
    expect(wrapText("abcdefghij", 7 * 4, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("first\n\nthird", 100, measure)).toEqual(["first", "", "third"]);
  });

  it("grows the box with the text, up to a limit", () => {
    const short = layoutCallout("Hi there", { width: 0, auto: true }, measure);
    const long = layoutCallout("x ".repeat(80), { width: 0, auto: true }, measure);
    expect(short.lines).toEqual(["Hi there"]);
    expect(short.width).toBeLessThan(100);
    expect(long.width).toBe(260);
    expect(long.lines.length).toBeGreaterThan(1);
  });

  it("starts the leader line on the box edge and ends at the target", () => {
    const m = { id: "c", type: "callout" as const, x1: 100, y1: 500, x2: 400, y2: 300, color: "#e5383b", width: 2, lines: ["Hi"], boxW: 100, rotation: 0 };
    const l = leader(m)!;
    expect(l.to).toEqual([300, 200]); // target in local coords (y down from the box's top-left)
    expect(l.from[1]).toBeCloseTo(2 * 7 + 14 * 1.32); // leaves through the bottom edge, toward the target
    expect(leader({ ...m, x2: 120, y2: 490 })).toBeNull(); // target inside the box
  });

  it("draws text with the embedded font in saved PDFs, including Cyrillic", async () => {
    const { readFileSync } = await import("node:fs");
    const font = new Uint8Array(readFileSync(new URL("../public/fonts/Inter-Regular.ttf", import.meta.url)));
    const sources = new Map([["a", await labeledPdf("A", 1)]]);
    const callout = { id: "c", type: "callout" as const, x1: 60, y1: 300, x2: 200, y2: 100, color: "#e5383b", width: 2, text: "Click here — Натисніть тут", lines: ["Click here —", "Натисніть тут"], boxW: 140, rotation: 0 };
    const pages = pagesForSource("a", 1).map((p) => ({ ...p, marks: [callout] }));
    const bytes = await buildPdf({ pages, sources, images: new Map(), calloutFont: font });
    const task = pdfjs.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join(" ");
    await task.destroy();
    expect(text).toContain("Click here");
    expect(text).toContain("Натисніть тут");
    await expect(buildPdf({ pages, sources, images: new Map() })).rejects.toThrow(/font/);
  });
});
