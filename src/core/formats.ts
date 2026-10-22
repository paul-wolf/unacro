// File types Unacro understands, and small format helpers that don't need a DOM.

export type ImageFormat = "jpeg" | "png" | "gif" | "bmp" | "tiff" | "heic";
export type FileKind = "pdf" | "image" | "model";

export interface Detected {
  kind: FileKind;
  /** Set for images. */
  format?: ImageFormat;
}

const IMAGE_EXTS: Record<string, ImageFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  jpe: "jpeg",
  jfif: "jpeg",
  png: "png",
  gif: "gif",
  bmp: "bmp",
  dib: "bmp",
  tif: "tiff",
  tiff: "tiff",
  heic: "heic",
  heif: "heic",
  hif: "heic",
};

/** Extensions shown in open dialogs and accepted on drop. */
export const PDF_EXTS = ["pdf"];
export const IMAGE_OPEN_EXTS = Object.keys(IMAGE_EXTS);
export const MODEL_EXTS = ["stl"];
export const ALL_EXTS = [...PDF_EXTS, ...IMAGE_OPEN_EXTS, ...MODEL_EXTS];

/** Image formats Unacro can write. GIF and HEIC can be opened but not saved. */
export const WRITABLE_IMAGE_FORMATS: ImageFormat[] = ["jpeg", "png", "tiff", "bmp"];
export const IMAGE_SAVE_EXT: Record<ImageFormat, string> = {
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  bmp: "bmp",
  tiff: "tiff",
  heic: "heic",
};
export const IMAGE_LABEL: Record<ImageFormat, string> = {
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  bmp: "BMP",
  tiff: "TIFF",
  heic: "HEIC",
};
export const IMAGE_MIME: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  heic: "image/heic",
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function replaceExt(name: string, ext: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return `${i > 0 ? base.slice(0, i) : base}.${ext}`;
}

/** What a path will be saved as, from its extension. */
export function saveFormatOf(path: string): "pdf" | ImageFormat | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  return IMAGE_EXTS[ext] ?? null;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0) {
  return sig.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, len: number) {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

/** Identify a file by its first bytes, falling back to the extension. */
export function detect(name: string, bytes: Uint8Array): Detected | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", format: "jpeg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", format: "png" };
  if (ascii(bytes, 0, 4) === "GIF8") return { kind: "image", format: "gif" };
  if (ascii(bytes, 0, 2) === "BM") return { kind: "image", format: "bmp" };
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return { kind: "image", format: "tiff" };
  if (ascii(bytes, 4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(bytes, 8, 4))) {
    return { kind: "image", format: "heic" };
  }
  if (ascii(bytes, 0, 1024).includes("%PDF-")) return { kind: "pdf" };
  const ext = extOf(name);
  if (ext === "stl") return { kind: "model" };
  if (ext === "pdf") return { kind: "pdf" };
  const fmt = IMAGE_EXTS[ext];
  return fmt ? { kind: "image", format: fmt } : null;
}

/** Encode RGBA pixels as a 24-bit BMP. Transparent pixels are composited over white. */
export function encodeBmp(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const out = new Uint8Array(54 + dataSize);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, 54, true); // pixel data offset
  v.setUint32(14, 40, true); // BITMAPINFOHEADER
  v.setInt32(18, width, true);
  v.setInt32(22, height, true); // positive = bottom-up rows
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, dataSize, true);
  v.setInt32(38, 2835, true); // 72 dpi
  v.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    let dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const i = src + x * 4;
      const a = rgba[i + 3] / 255;
      out[dst++] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
      out[dst++] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
      out[dst++] = Math.round(rgba[i] * a + 255 * (1 - a));
    }
  }
  return out;
}
