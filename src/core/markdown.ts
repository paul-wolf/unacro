// PDF text -> Markdown, using only text positions and sizes.
//
// PDFs don't record "heading" or "paragraph", so this infers structure:
//  - lines are built from text runs that share a baseline
//  - the most common font size is body text; noticeably larger lines are headings
//  - vertical gaps separate paragraphs
//  - bullet glyphs and "1." / "a)" prefixes become list items
//  - text repeated at the top or bottom of most pages (headers, footers, page numbers) is dropped
// Tables and multi-column layouts are not handled specially.

/** A text run in display coordinates (origin top-left, y grows downward, y = baseline). */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  /** Font size in display units. */
  size: number;
  /** Advance width in display units. */
  width: number;
}

export interface PageText {
  width: number;
  height: number;
  runs: TextRun[];
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  page: number;
}

const BULLET_RE = /^([•◦▪▫●○■□‣⁃∙·\-–—*])\s+(.*)$/u;
const NUMBERED_RE = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+(.*)$/;

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** Group runs into lines and join their text with sensible spacing. */
export function buildLines(page: PageText, pageNo: number): Line[] {
  const runs = page.runs.filter((r) => r.str.length > 0 && r.size > 0);
  runs.sort((a, b) => a.y - b.y || a.x - b.x);

  const groups: TextRun[][] = [];
  for (const r of runs) {
    const g = groups[groups.length - 1];
    if (g) {
      const ref = g[0];
      const tol = Math.max(ref.size, r.size) * 0.4;
      if (Math.abs(r.y - ref.y) <= tol) {
        g.push(r);
        continue;
      }
    }
    groups.push([r]);
  }

  const lines: Line[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd: number | null = null;
    let sizeChars = new Map<number, number>();
    for (const r of g) {
      if (prevEnd !== null) {
        const gap = r.x - prevEnd;
        const needsSpace = gap > r.size * 0.2 && !text.endsWith(" ") && !r.str.startsWith(" ");
        if (needsSpace) text += " ";
      }
      text += r.str;
      prevEnd = r.x + r.width;
      const s = round1(r.size);
      sizeChars.set(s, (sizeChars.get(s) ?? 0) + r.str.trim().length);
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    let size = 0;
    let best = -1;
    for (const [s, n] of sizeChars) {
      if (n > best || (n === best && s > size)) {
        best = n;
        size = s;
      }
    }
    lines.push({ text, x: g[0].x, y: g[0].y, size, page: pageNo });
  }
  return lines;
}

function normalizeForRepeat(text: string) {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Drop running headers/footers and bare page numbers. */
function removeFurniture(pages: Line[][]): Line[][] {
  const pageNumRe = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;
  const result = pages.map((lines) => lines.filter((l) => !pageNumRe.test(l.text)));
  if (pages.length < 3) return result;

  const edgeCounts = new Map<string, number>();
  for (const lines of result) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => normalizeForRepeat(l.text)));
    for (const key of edge) edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const repeated = new Set([...edgeCounts].filter(([, n]) => n >= threshold).map(([k]) => k));
  return result.map((lines) =>
    lines.filter((l, i) => {
      const atEdge = i < 2 || i >= lines.length - 2;
      return !(atEdge && repeated.has(normalizeForRepeat(l.text)));
    }),
  );
}

function bodySize(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(l.size, (counts.get(l.size) ?? 0) + l.text.length);
  let size = 10;
  let best = -1;
  for (const [s, n] of counts) {
    if (n > best) {
      best = n;
      size = s;
    }
  }
  return size;
}

function escapeLineStart(text: string) {
  return text.replace(/^(#{1,6}\s|>|\+\s|=+$)/, "\\$1");
}

type Block =
  | { kind: "heading"; level: number; text: string; page: number; lastY: number }
  | { kind: "para"; text: string; size: number; lastY: number; page: number; x: number }
  | { kind: "item"; marker: string; text: string; x: number; textX: number; lastY: number; page: number };

function joinText(a: string, b: string) {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

export function pagesToMarkdown(pages: PageText[]): string {
  const pageLines = removeFurniture(pages.map((p, i) => buildLines(p, i)));
  const all = pageLines.flat();
  if (all.length === 0) return "";

  const body = bodySize(all);
  const headingSizes = [...new Set(all.filter((l) => l.size >= body * 1.15 && l.text.length <= 150).map((l) => l.size))]
    .sort((a, b) => b - a)
    .slice(0, 3);
  const headingLevel = (size: number) => {
    const i = headingSizes.indexOf(size);
    return i === -1 ? 0 : i + 1;
  };

  const blocks: Block[] = [];
  for (const lines of pageLines) {
    for (const line of lines) {
      const last = blocks[blocks.length - 1];
      const level = headingLevel(line.size);

      if (level) {
        // Consecutive heading lines of the same size on the same page form one heading.
        if (last && last.kind === "heading" && last.level === level && last.page === line.page &&
            line.y - last.lastY < line.size * 1.8) {
          last.text = joinText(last.text, line.text);
          last.lastY = line.y;
        } else {
          blocks.push({ kind: "heading", level, text: line.text, page: line.page, lastY: line.y });
        }
        continue;
      }

      const bullet = BULLET_RE.exec(line.text);
      const numbered = bullet ? null : NUMBERED_RE.exec(line.text);
      if (bullet || numbered) {
        const m = (bullet ?? numbered)!;
        const marker = bullet ? "-" : m[1].replace(/[()]/g, "").replace(/\)$/, ".").replace(/([^.])$/, "$1.");
        blocks.push({ kind: "item", marker, text: m[2], x: line.x, textX: line.x + line.size, lastY: line.y, page: line.page });
        continue;
      }

      const lineGap = line.size * 1.6;
      if (last && last.kind === "item" && last.page === line.page && line.y - last.lastY < lineGap && line.x > last.x + 1) {
        last.text = joinText(last.text, line.text);
        last.lastY = line.y;
        continue;
      }

      if (last && last.kind === "para") {
        const samePageClose = last.page === line.page && line.y - last.lastY < lineGap && line.y > last.lastY;
        const continuesAcrossPage =
          last.page === line.page - 1 && !/[.!?:;"”)]$/.test(last.text) && /^[a-z(]/.test(line.text);
        if ((samePageClose || continuesAcrossPage) && Math.abs(last.size - line.size) < 0.6) {
          last.text = joinText(last.text, line.text);
          last.lastY = line.y;
          last.page = line.page;
          continue;
        }
      }
      blocks.push({ kind: "para", text: line.text, size: line.size, lastY: line.y, page: line.page, x: line.x });
    }
  }

  const out: string[] = [];
  let prev: Block | null = null;
  for (const b of blocks) {
    if (b.kind === "heading") {
      out.push(`${"#".repeat(b.level)} ${b.text}`);
    } else if (b.kind === "para") {
      out.push(escapeLineStart(b.text));
    } else {
      const indent = prev && prev.kind === "item" && b.x > prev.x + 8 ? "  " : "";
      const line = `${indent}${b.marker} ${b.text}`;
      // Keep list items in one block (no blank line between them).
      if (prev && prev.kind === "item") {
        out[out.length - 1] += `\n${line}`;
        prev = b;
        continue;
      }
      out.push(line);
    }
    prev = b;
  }
  return out.join("\n\n") + "\n";
}
