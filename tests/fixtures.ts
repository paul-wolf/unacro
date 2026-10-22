import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** A simple PDF whose pages each say "<label> page N". */
export async function labeledPdf(label: string, count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([400, 500]);
    page.drawText(`${label} page ${i}`, { x: 50, y: 400, size: 20, font });
  }
  return doc.save();
}

/** A multi-page "report" with headings, paragraphs, bullets, and a running header/footer. */
export async function reportPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = [
    [
      ["h1", "Quarterly Report"],
      ["p", "This report summarizes the results of the third quarter. Revenue grew"],
      ["p", "steadily across all regions and costs stayed flat."],
      ["gap", ""],
      ["h2", "Highlights"],
      ["li", "• Revenue up 12 percent"],
      ["li", "• Two new offices opened"],
      ["li", "• Customer churn fell to a record low"],
    ],
    [
      ["h2", "Next Steps"],
      ["p", "We will continue to invest in the product and hire carefully. The plan for"],
      ["p", "the next quarter is described below."],
      ["gap", ""],
      ["li", "1. Ship the new mobile app"],
      ["li", "2. Expand the support team"],
    ],
    [
      ["h2", "Appendix"],
      ["p", "Figures are unaudited."],
    ],
  ];
  pages.forEach((lines, pi) => {
    const page = doc.addPage([612, 792]);
    page.drawText("ACME Corp — Confidential", { x: 72, y: 760, size: 8, font });
    page.drawText(`${pi + 1}`, { x: 300, y: 30, size: 8, font });
    let y = 700;
    for (const [kind, text] of lines) {
      if (kind === "gap") {
        y -= 14;
        continue;
      }
      const size = kind === "h1" ? 24 : kind === "h2" ? 16 : 11;
      const f = kind.startsWith("h") ? bold : font;
      if (kind.startsWith("h")) y -= 8;
      page.drawText(text, { x: 72, y, size, font: f, color: rgb(0, 0, 0) });
      y -= size * 1.35;
      if (kind.startsWith("h")) y -= 6;
    }
  });
  return doc.save();
}

/** A tiny valid PNG. */
export async function tinyPng(): Promise<Uint8Array> {
  // 2x1 RGBA PNG (red, half-transparent blue).
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQg0AD3oDfnfpf5cAAAAASUVORK5CYII=";
  return Uint8Array.from(Buffer.from(b64, "base64"));
}
