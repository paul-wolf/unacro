// Geometry for markup shapes, shared by the on-screen overlay and by saving.
// All coordinates are PDF user space (y up), the same space marks are stored in.

import type { Mark } from "./model";
import { drawCalloutOnCanvas } from "./callout";

export const MARK_COLORS = ["#e5383b", "#f59f00", "#ffd43b", "#2f9e44", "#1c7ed6", "#7048e8", "#111111", "#ffffff"];
export const MARK_WIDTHS = [1.5, 3, 6];

export type Pt = [number, number];

/** Arrow: the shaft stops at the base of the head, so the tip stays sharp at any width. */
export function arrowGeometry(m: Mark): { shaft: [Pt, Pt]; head: [Pt, Pt, Pt] } | null {
  const dx = m.x2 - m.x1, dy = m.y2 - m.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len, uy = dy / len;
  const headLen = Math.min(len, m.width * 3.5 + 7);
  const halfW = m.width * 1.8 + 4;
  const bx = m.x2 - ux * headLen, by = m.y2 - uy * headLen;
  return {
    shaft: [[m.x1, m.y1], [bx + ux * 0.5, by + uy * 0.5]],
    head: [[m.x2, m.y2], [bx - uy * halfW, by + ux * halfW], [bx + uy * halfW, by - ux * halfW]],
  };
}

export function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Anything that can draw paths: a 2D canvas already transformed to PDF user space. */
export function drawMarkOnCanvas(ctx: CanvasRenderingContext2D, m: Mark) {
  if (m.type === "callout") return drawCalloutOnCanvas(ctx, m);
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const x = Math.min(m.x1, m.x2), y = Math.min(m.y1, m.y2);
  const w = Math.abs(m.x2 - m.x1), h = Math.abs(m.y2 - m.y1);
  if (m.type === "rect") {
    ctx.strokeRect(x, y, w, h);
  } else if (m.type === "oval") {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, 0.01), Math.max(h / 2, 0.01), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const g = arrowGeometry(m);
    if (g) {
      ctx.beginPath();
      ctx.moveTo(...g.shaft[0]);
      ctx.lineTo(...g.shaft[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(...g.head[0]);
      ctx.lineTo(...g.head[1]);
      ctx.lineTo(...g.head[2]);
      ctx.closePath();
      ctx.lineWidth = Math.min(m.width, 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
