import { describe, expect, it } from "vitest";
import { detect, encodeBmp, extOf, replaceExt, saveFormatOf } from "../src/core/formats";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const text = (s: string) => new TextEncoder().encode(s);

describe("detect", () => {
  it("recognizes files by content, not just name", () => {
    expect(detect("x.bin", text("%PDF-1.7\n"))).toEqual({ kind: "pdf" });
    expect(detect("x", bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: "image", format: "jpeg" });
    expect(detect("x", bytes(0x89, 0x50, 0x4e, 0x47))).toEqual({ kind: "image", format: "png" });
    expect(detect("x", text("GIF89a......"))).toEqual({ kind: "image", format: "gif" });
    expect(detect("x", text("BM......"))).toEqual({ kind: "image", format: "bmp" });
    expect(detect("x", bytes(0x49, 0x49, 0x2a, 0))).toEqual({ kind: "image", format: "tiff" });
    expect(detect("x", bytes(0x4d, 0x4d, 0, 0x2a))).toEqual({ kind: "image", format: "tiff" });
    expect(detect("x", new Uint8Array([0, 0, 0, 24, ...text("ftypheic"), 0, 0]))).toEqual({ kind: "image", format: "heic" });
  });

  it("falls back to the extension", () => {
    expect(detect("Part.STL", text("solid part"))).toEqual({ kind: "model" });
    expect(detect("photo.HEIF", bytes(1, 2, 3))).toEqual({ kind: "image", format: "heic" });
    expect(detect("notes.txt", text("hello"))).toBeNull();
  });
});

describe("names", () => {
  it("handles extensions", () => {
    expect(extOf("/a/b/Photo.JPG")).toBe("jpg");
    expect(extOf("README")).toBe("");
    expect(replaceExt("/a/scan.tiff", "pdf")).toBe("scan.pdf");
    expect(saveFormatOf("x.jpeg")).toBe("jpeg");
    expect(saveFormatOf("x.pdf")).toBe("pdf");
    expect(saveFormatOf("x.md")).toBeNull();
  });
});

describe("encodeBmp", () => {
  it("writes a valid bottom-up 24-bit BMP with padded rows", () => {
    // 3x2: top row red, green, blue; bottom row transparent, white, black
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const bmp = encodeBmp(rgba, 3, 2);
    const v = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe("BM");
    expect(v.getUint32(2, true)).toBe(bmp.length);
    expect(v.getInt32(18, true)).toBe(3);
    expect(v.getInt32(22, true)).toBe(2);
    expect(v.getUint16(28, true)).toBe(24);
    const row = 12; // 3 px * 3 bytes = 9, padded to 12
    expect(bmp.length).toBe(54 + row * 2);
    // First stored row is the bottom row: transparent -> white, white, black (BGR)
    expect([...bmp.subarray(54, 63)]).toEqual([255, 255, 255, 255, 255, 255, 0, 0, 0]);
    // Second stored row is the top row: red, green, blue as BGR
    expect([...bmp.subarray(54 + row, 54 + row + 9)]).toEqual([0, 0, 255, 0, 255, 0, 255, 0, 0]);
  });
});
