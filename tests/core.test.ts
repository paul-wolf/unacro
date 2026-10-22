import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPdf } from "../src/core/build";
import { movePages, pagesForSource, clonePages, type PageRef } from "../src/core/model";
import { extractPageText } from "../src/core/extract";
import { pagesToMarkdown } from "../src/core/markdown";
import { labeledPdf, reportPdf, tinyPng } from "./fixtures";

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it: any) => it.str).join("").trim());
  }
  await task.destroy();
  return out;
}

async function setup() {
  const a = await labeledPdf("A", 3);
  const b = await labeledPdf("B", 2);
  const sources = new Map([["a", a], ["b", b]]);
  return { sources, aPages: pagesForSource("a", 3), bPages: pagesForSource("b", 2) };
}

describe("buildPdf", () => {
  it("merges two documents in order", async () => {
    const { sources, aPages, bPages } = await setup();
    const bytes = await buildPdf({ pages: [...aPages, ...bPages], sources, images: new Map() });
    expect(await pageTexts(bytes)).toEqual(["A page 1", "A page 2", "A page 3", "B page 1", "B page 2"]);
  });

  it("inserts pages from another document in the middle", async () => {
    const { sources, aPages, bPages } = await setup();
    const pages = [aPages[0], bPages[1], aPages[1], aPages[2]];
    expect(await pageTexts(await buildPdf({ pages, sources, images: new Map() }))).toEqual([
      "A page 1", "B page 2", "A page 2", "A page 3",
    ]);
  });

  it("reorders, deletes and duplicates pages", async () => {
    const { sources, aPages } = await setup();
    let pages = movePages(aPages, new Set([aPages[2].id]), 0); // 3,1,2
    pages = pages.filter((p) => p.index !== 1); // 3,1
    pages = [...pages, ...clonePages([pages[0]])]; // 3,1,3
    expect(await pageTexts(await buildPdf({ pages, sources, images: new Map() }))).toEqual([
      "A page 3", "A page 1", "A page 3",
    ]);
  });

  it("applies rotation on top of existing rotation", async () => {
    const { sources, aPages } = await setup();
    const pages: PageRef[] = aPages.map((p, i) => ({ ...p, rotation: i * 90 }));
    const doc = await PDFDocument.load(await buildPdf({ pages, sources, images: new Map() }));
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 180]);
    const again = await buildPdf({
      pages: pagesForSource("x", 3).map((p) => ({ ...p, rotation: 270 })),
      sources: new Map([["x", await doc.save()]]),
      images: new Map(),
    });
    expect((await PDFDocument.load(again)).getPages().map((p) => p.getRotation().angle)).toEqual([270, 0, 90]);
  });

  it("draws signature stamps as images", async () => {
    const { sources, aPages } = await setup();
    const pages = aPages.slice(0, 1).map((p) => ({
      ...p,
      stamps: [{ id: "s1", imageId: "sig", x: 100, y: 100, width: 120, height: 60, rotation: 0 }],
    }));
    const bytes = await buildPdf({ pages, sources, images: new Map([["sig", await tinyPng()]]) });
    const doc = await PDFDocument.load(bytes);
    const res = doc.getPages()[0].node.Resources()!;
    const xobj = res.lookup(PDFName.of("XObject"), PDFDict);
    expect(xobj.keys().length).toBeGreaterThan(0);
  });

  it("keeps form fields of the base document", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const form = doc.getForm();
    form.createTextField("name").addToPage(doc.getPages()[1], { x: 10, y: 10 });
    const src = await doc.save();
    const pages = pagesForSource("f", 2).reverse();
    const out = await PDFDocument.load(await buildPdf({ pages, sources: new Map([["f", src]]), images: new Map() }));
    expect(out.getForm().getFields().map((f) => f.getName())).toEqual(["name"]);
    expect(out.getPageCount()).toBe(2);
  });

  it("refuses an empty document", async () => {
    await expect(buildPdf({ pages: [], sources: new Map(), images: new Map() })).rejects.toThrow();
  });
});

describe("markdown", () => {
  it("infers headings, paragraphs, lists and drops headers/footers", async () => {
    const bytes = await reportPdf();
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await extractPageText(await doc.getPage(i)));
    const md = pagesToMarkdown(pages);
    expect(md).toMatchInlineSnapshot(`
      "# Quarterly Report

      This report summarizes the results of the third quarter. Revenue grew steadily across all regions and costs stayed flat.

      ## Highlights

      - Revenue up 12 percent
      - Two new offices opened
      - Customer churn fell to a record low

      ## Next Steps

      We will continue to invest in the product and hire carefully. The plan for the next quarter is described below.

      1. Ship the new mobile app
      2. Expand the support team

      ## Appendix

      Figures are unaudited.
      "
    `);
  });
});
