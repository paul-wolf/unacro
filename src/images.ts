// Images as documents.
//
// An opened image becomes a small PDF in memory (one page per image, or per
// frame of a multi-page TIFF), so viewing, thumbnails, rotation, signatures and
// combining all work exactly as for PDFs. The original bytes are kept so the
// image can be saved back in its own format at full resolution.

import { PDFDocument } from "pdf-lib";
import UTIF from "utif";
import { encodeBmp, IMAGE_LABEL, IMAGE_MIME, type ImageFormat } from "./core/formats";

/** Largest page side, in points, for an image page (A4 height). Bigger images are scaled down, never up. */
const MAX_PAGE_SIDE = 842;

export interface ImagePages {
  pdf: Uint8Array;
  /** Points per pixel for each page. */
  pointsPerPixel: number[];
}

function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function viaImgElement(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const c = canvasOf(img.naturalWidth, img.naturalHeight);
    c.getContext("2d")!.drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodeTiff(bytes: Uint8Array): HTMLCanvasElement[] {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(buf);
  const pages: HTMLCanvasElement[] = [];
  for (const ifd of ifds) {
    // Skip thumbnails (subfile type 1) that some TIFFs carry next to the real image.
    if (ifd.t254 && (ifd.t254[0] & 1) === 1) continue;
    UTIF.decodeImage(buf, ifd, ifds);
    if (!ifd.width || !ifd.height) continue;
    const rgba = UTIF.toRGBA8(ifd);
    const c = canvasOf(ifd.width, ifd.height);
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0);
    pages.push(c);
  }
  if (!pages.length) throw new Error("No image found in this TIFF file.");
  return pages;
}

/** Decode an image file to one canvas per page (TIFF can have several). Applies EXIF orientation. */
export async function decodeImage(bytes: Uint8Array, format: ImageFormat): Promise<HTMLCanvasElement[]> {
  if (format === "tiff") return decodeTiff(bytes);
  const blob = new Blob([bytes as BlobPart], { type: IMAGE_MIME[format] });
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const c = canvasOf(bmp.width, bmp.height);
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    return [c];
  } catch {
    try {
      return [await viaImgElement(blob)];
    } catch {
      if (format === "heic") {
        throw new Error("HEIC images can't be opened on this system yet. On macOS they work out of the box.");
      }
      throw new Error(`This ${IMAGE_LABEL[format]} image couldn't be read.`);
    }
  }
}

function toBytes(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("Couldn't encode the image."))),
      type,
      quality,
    ),
  );
}

/** Wrap decoded image pages in a PDF so the rest of Unacro can treat them as pages. */
export async function imagePagesToPdf(pages: HTMLCanvasElement[], format: ImageFormat): Promise<ImagePages> {
  const doc = await PDFDocument.create();
  const pointsPerPixel: number[] = [];
  for (const c of pages) {
    // Photos stay JPEG (small); everything else stays lossless.
    const img = format === "jpeg" || format === "heic"
      ? await doc.embedJpg(await toBytes(c, "image/jpeg", 0.92))
      : await doc.embedPng(await toBytes(c, "image/png"));
    const k = Math.min(1, MAX_PAGE_SIDE / Math.max(c.width, c.height));
    const page = doc.addPage([c.width * k, c.height * k]);
    page.drawImage(img, { x: 0, y: 0, width: c.width * k, height: c.height * k });
    pointsPerPixel.push(k);
  }
  return { pdf: await doc.save(), pointsPerPixel };
}

/** Encode a finished canvas in a writable image format. */
export async function encodeCanvas(canvas: HTMLCanvasElement, format: ImageFormat): Promise<Uint8Array> {
  if (format === "png") return toBytes(canvas, "image/png");
  if (format === "jpeg") return toBytes(canvas, "image/jpeg", 0.92);
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  if (format === "bmp") return encodeBmp(rgba, width, height);
  if (format === "tiff") {
    const copy = new Uint8Array(rgba.length);
    copy.set(rgba);
    return new Uint8Array(UTIF.encodeImage(copy.buffer, width, height, { t305: ["Unacro"] }));
  }
  throw new Error(`Unacro can't write ${IMAGE_LABEL[format]} files.`);
}
