// Signature library: draw or import a signature once, reuse it everywhere.
// Stored locally (localStorage) as trimmed, transparent PNGs. Never leaves the machine.

import { h, modal, toast } from "./dom";
import { uid } from "../core/model";

export interface Signature {
  id: string;
  dataUrl: string;
  /** Pixel size of the PNG, used for the aspect ratio. */
  width: number;
  height: number;
}

const KEY = "unacro.signatures";

export function loadSignatures(): Signature[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Signature[]) : [];
  } catch {
    return [];
  }
}

function storeSignatures(list: Signature[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    toast("Couldn't save the signature for next time (storage is unavailable).", "error");
  }
}

export function addSignature(sig: Signature) {
  storeSignatures([sig, ...loadSignatures()]);
}

export function removeSignature(id: string) {
  storeSignatures(loadSignatures().filter((s) => s.id !== id));
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Crop a canvas to its non-transparent pixels (plus padding) and return a PNG signature. */
function trimToSignature(source: HTMLCanvasElement): Signature | null {
  const ctx = source.getContext("2d")!;
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { id: uid("sig"), dataUrl: out.toDataURL("image/png"), width: out.width, height: out.height };
}

/** Draw a signature with mouse, trackpad, pen or finger. */
export async function drawSignatureDialog(): Promise<Signature | null> {
  const scale = 2; // render at 2x for crisp output
  const cssW = 560, cssH = 220;
  const canvas = h("canvas", { class: "sig-pad", width: cssW * scale, height: cssH * scale, style: { width: `${cssW}px`, height: `${cssH}px` } });
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#111a3a";
  let empty = true;
  let points: { x: number; y: number; t: number }[] = [];
  let width = 2.4;

  const pos = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * cssW, y: ((e.clientY - r.top) / r.height) * cssH, t: e.timeStamp };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    points = [pos(e)];
    width = 2.4;
    const p = points[0];
    ctx.beginPath();
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    empty = false;
    hint.style.visibility = "hidden";
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!points.length) return;
    const p = pos(e);
    const last = points[points.length - 1];
    const dist = Math.hypot(p.x - last.x, p.y - last.y);
    if (dist < 0.8) return;
    // Faster strokes get thinner, like ink.
    const speed = dist / Math.max(1, p.t - last.t);
    const target = e.pressure && e.pointerType === "pen" ? 1.2 + e.pressure * 2.8 : Math.max(1.2, 3.2 - speed * 1.4);
    width = width * 0.7 + target * 0.3;
    points.push(p);
    const n = points.length;
    if (n < 3) return;
    const a = points[n - 3], b = points[n - 2], c = points[n - 1];
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.stroke();
  });
  const end = () => (points = []);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  const hint = h("div", { class: "sig-hint" }, "Sign here");
  const clear = h("button", {
    class: "btn plain small",
    onclick: () => {
      ctx.clearRect(0, 0, cssW, cssH);
      empty = true;
      hint.style.visibility = "visible";
    },
  }, "Clear");
  const body = h("div", { class: "sig-draw" }, h("div", { class: "sig-pad-wrap" }, canvas, hint, h("div", { class: "sig-line" })), h("div", { class: "sig-tools" }, clear));

  const result = await modal<"save" | "cancel">({
    title: "Draw your signature",
    body,
    wide: true,
    cancelValue: "cancel",
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Save signature", value: "save", kind: "primary" },
    ],
  });
  if (result !== "save" || empty) return null;
  return trimToSignature(canvas);
}

/** Import a scanned or photographed signature. Near-white pixels become transparent. */
export async function importSignatureImage(): Promise<Signature | null> {
  const file = await new Promise<File | null>((resolve) => {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That image couldn't be read."));
      i.src = url;
    });
    const maxW = 1600;
    const s = Math.min(1, maxW / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      if (lum > 215) d.data[i + 3] = 0;
      else if (lum > 160) d.data[i + 3] = Math.min(d.data[i + 3], Math.round(((215 - lum) / 55) * 255));
    }
    ctx.putImageData(d, 0, 0);
    const sig = trimToSignature(c);
    if (!sig) toast("That image looks blank.", "error");
    return sig;
  } finally {
    URL.revokeObjectURL(url);
  }
}
