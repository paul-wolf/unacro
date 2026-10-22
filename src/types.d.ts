declare module "utif" {
  const UTIF: {
    decode(buf: ArrayBuffer): any[];
    decodeImage(buf: ArrayBuffer, ifd: any, ifds?: any[]): void;
    toRGBA8(ifd: any): Uint8Array;
    encodeImage(rgba: ArrayBuffer, w: number, h: number, metadata?: Record<string, unknown>): ArrayBuffer;
  };
  export default UTIF;
}
