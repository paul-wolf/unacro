// Copy PDF.js runtime assets (fonts, character maps, image decoders) into public/pdfjs
// so they are served locally. Unacro never fetches anything from the network.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const out = join(dirname(new URL(import.meta.url).pathname), "..", "public", "pdfjs");
mkdirSync(out, { recursive: true });
for (const dir of ["standard_fonts", "cmaps", "wasm"]) {
  const src = join(root, dir);
  if (existsSync(src)) cpSync(src, join(out, dir), { recursive: true });
}
console.log("Copied PDF.js assets to public/pdfjs");
