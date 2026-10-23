// Callouts: a rounded, outlined box with text, joined to the thing it points at by
// a straight line ending in a dot.
//
// A callout lives in its own "local" frame: origin at the box's top-left corner,
// x to the right along the text, y downward, in PDF points. The frame is placed in
// the page's PDF user space by an anchor point and a rotation (the page rotation
// when it was created, so the text reads upright on screen). Everything (screen,
// saved image, saved PDF) draws in that frame, so the result looks the same.

import type { Mark } from "./model";

export const CALLOUT_FONT = "UnacroInter";
export const CALLOUT_FONT_SIZE = 14;
export const CALLOUT_PAD_X = 10;
export const CALLOUT_PAD_Y = 7;
export const CALLOUT_LINE_HEIGHT = 1.32;
export const CALLOUT_RADIUS = 8;
export const CALLOUT_MAX_AUTO_WIDTH = 260;
export const CALLOUT_MIN_WIDTH = 40;
export const CALLOUT_TEXT_COLOR = "#1f2328";

export type Measure = (text: string) => number;

export interface CalloutBox {
  width: number;
  height: number;
  lines: string[];
}

function fontSizeOf(m: Pick<Mark, "fontSize">) {
  return m.fontSize ?? CALLOUT_FONT_SIZE;
}

export function lineHeight(m: Pick<Mark, "fontSize">) {
  return fontSizeOf(m) * CALLOUT_LINE_HEIGHT;
}

/** Baseline of line `i`, from the top of the box. */
export function baseline(m: Pick<Mark, "fontSize">, i: number) {
  const lh = lineHeight(m);
  return CALLOUT_PAD_Y + i * lh + lh / 2 + fontSizeOf(m) * 0.36;
}

/** Wrap text into lines that fit `maxWidth` (text area, without padding). Long words are broken. */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (measure(candidate.trimEnd()) <= maxWidth || !line.trim()) {
        if (measure(word.trim()) > maxWidth && !/^\s+$/.test(word)) {
          // A word wider than the box: break it into pieces.
          for (const ch of word) {
            if (measure((line + ch).trimEnd()) > maxWidth && line.trim()) {
              out.push(line.trimEnd());
              line = ch.trimStart();
            } else line += ch;
          }
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Lay out a callout: auto width grows with the text up to a limit, fixed width wraps. */
export function layoutCallout(text: string, opts: { width: number; auto: boolean; fontSize?: number }, measure: Measure): CalloutBox {
  const size = opts.fontSize ?? CALLOUT_FONT_SIZE;
  const inner = (w: number) => Math.max(1, w - 2 * CALLOUT_PAD_X);
  let width = opts.width;
  if (opts.auto) {
    const natural = Math.max(...text.split("\n").map((l) => measure(l)), measure("M") * 2);
    width = Math.min(CALLOUT_MAX_AUTO_WIDTH, Math.ceil(natural) + 2 * CALLOUT_PAD_X + 2);
  }
  width = Math.max(CALLOUT_MIN_WIDTH, width);
  const lines = wrapText(text, inner(width), measure);
  const height = 2 * CALLOUT_PAD_Y + Math.max(1, lines.length) * size * CALLOUT_LINE_HEIGHT;
  return { width, height, lines };
}

/** Unit vectors of the callout's local frame, in PDF user space. */
export function frame(m: Mark) {
  const t = ((m.rotation ?? 0) * Math.PI) / 180;
  return { ux: [Math.cos(t), Math.sin(t)] as [number, number], down: [Math.sin(t), -Math.cos(t)] as [number, number] };
}

/** A user-space point in the callout's local frame. */
export function toLocal(m: Mark, x: number, y: number): [number, number] {
  const { ux, down } = frame(m);
  const dx = x - m.x1, dy = y - m.y1;
  return [dx * ux[0] + dy * ux[1], dx * down[0] + dy * down[1]];
}

export function boxHeight(m: Mark) {
  return 2 * CALLOUT_PAD_Y + Math.max(1, m.lines?.length ?? 1) * lineHeight(m);
}

/**
 * The leader line in local coordinates: from the box edge toward the target, or null
 * when the target is inside (or touching) the box.
 */
export function leader(m: Mark): { from: [number, number]; to: [number, number] } | null {
  const w = m.boxW ?? CALLOUT_MIN_WIDTH, h = boxHeight(m);
  const to = toLocal(m, m.x2, m.y2);
  const cx = w / 2, cy = h / 2;
  const dx = to[0] - cx, dy = to[1] - cy;
  if (Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2) return null;
  const t = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  return { from: [cx + dx * t, cy + dy * t], to };
}

export function dotRadius(m: Mark) {
  return 2.5 + m.width * 0.8;
}

/** SVG path of the rounded box, in local coordinates (y down). */
export function boxPath(w: number, h: number, dx = 0, dy = 0) {
  const r = Math.min(CALLOUT_RADIUS, h / 2, w / 2);
  const x = dx, y = dy;
  return `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(CALLOUT_RADIUS, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Draw a callout on a canvas whose transform is PDF user space. The font must be loaded. */
export function drawCalloutOnCanvas(ctx: CanvasRenderingContext2D, m: Mark) {
  const { ux, down } = frame(m);
  const w = m.boxW ?? CALLOUT_MIN_WIDTH, h = boxHeight(m);
  ctx.save();
  ctx.transform(ux[0], ux[1], down[0], down[1], m.x1, m.y1);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const l = leader(m);
  if (l) {
    ctx.strokeStyle = m.color;
    ctx.lineWidth = Math.max(1, m.width * 0.75);
    ctx.beginPath();
    ctx.moveTo(...l.from);
    ctx.lineTo(...l.to);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(l.to[0], l.to[1], dotRadius(m), 0, Math.PI * 2);
    ctx.fillStyle = m.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  // Soft shadow: a faint copy of the box, slightly lower.
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  roundRect(ctx, 0, 1.5, w, h);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = m.color;
  ctx.lineWidth = m.width;
  roundRect(ctx, 0, 0, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = CALLOUT_TEXT_COLOR;
  ctx.font = `${fontSizeOf(m)}px ${CALLOUT_FONT}, sans-serif`;
  ctx.textBaseline = "alphabetic";
  (m.lines ?? []).forEach((line, i) => ctx.fillText(line, CALLOUT_PAD_X, baseline(m, i)));
  ctx.restore();
}
