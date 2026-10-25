// Markdown documents: render to safe HTML, find and load their images, and build
// the self-contained page that is printed to PDF.
//
// The Markdown parser and syntax highlighter are loaded only when a Markdown file
// is opened, so people who never open one don't pay for them.
//
// Safety: raw HTML inside Markdown is parsed into an inert <template> (nothing in
// it loads or runs) and reduced to an allowlist of tags and attributes. Images
// never keep their original address: local files are read by Unacro and shown
// from memory, and web images are only given their address after the user clicks
// "Load Remote Images" for that document.

import type MarkdownIt from "markdown-it";
import { decodeImage } from "./images";
import { firstHeading, resolveImageRef, splitFrontMatter, PAPER_SIZE, type ImageRef, type Paper } from "./core/mdsource";
import { extOf } from "./core/formats";
import mdCss from "./markdown.css?raw";

export { mdCss };

// ---------------------------------------------------------------- engine

let enginePromise: Promise<MarkdownIt> | null = null;

function loadEngine(): Promise<MarkdownIt> {
  enginePromise ??= Promise.all([import("markdown-it"), import("highlight.js/lib/common")]).then(([mdMod, hlMod]) => {
    const MarkdownItCtor = mdMod.default;
    const hljs = hlMod.default;
    const md: MarkdownIt = new MarkdownItCtor({
      html: true,
      linkify: true,
      typographer: false,
      highlight(code: string, lang: string) {
        const name = lang?.trim().split(/\s+/)[0];
        if (name && hljs.getLanguage(name)) {
          try {
            return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
          } catch {
            /* fall through to plain */
          }
        }
        return "";
      },
    });
    md.core.ruler.after("inline", "task-lists", (state) => {
      const tokens = state.tokens;
      for (let i = 2; i < tokens.length; i++) {
        const inline = tokens[i];
        if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
        const m = /^\[([ xX])\][ \t]/.exec(inline.content);
        const first = inline.children?.[0];
        if (!m || !first || first.type !== "text" || !first.content.startsWith(m[0])) continue;
        first.content = first.content.slice(m[0].length);
        const box = new state.Token("html_inline", "", 0);
        box.content = `<input type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
        inline.children!.unshift(box);
        tokens[i - 2].attrJoin("class", "task-list-item");
      }
    });
    return md;
  });
  return enginePromise;
}

// ---------------------------------------------------------------- sanitizing

/** Removed together with everything inside them. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template",
  "svg", "math", "link", "meta", "base", "form", "button", "textarea", "select", "option", "audio",
  "video", "canvas", "title", "head", "portal", "dialog",
]);

const GLOBAL_ATTRS = ["id", "class", "title", "lang", "dir"];
const ALLOWED: Record<string, string[]> = {
  a: ["href", "name"],
  abbr: [], b: [], bdi: [], bdo: [], blockquote: ["cite"], br: [], caption: [], center: [], cite: [], code: [],
  col: ["span"], colgroup: ["span"], dd: [], del: [], details: ["open"], dfn: [], div: ["align"], dl: [], dt: [],
  em: [], figcaption: [], figure: [], h1: ["align"], h2: ["align"], h3: ["align"], h4: ["align"], h5: ["align"],
  h6: ["align"], hr: [], i: [], img: ["src", "alt", "width", "height", "align"], input: ["type", "checked", "disabled"],
  ins: [], kbd: [], li: ["value"], mark: [], ol: ["start", "reversed", "type"], p: ["align"], pre: [], q: [], rp: [],
  rt: [], ruby: [], s: [], samp: [], section: [], small: [], span: [], strike: [], strong: [], sub: [], summary: [],
  sup: [], table: ["align"], tbody: [], td: ["colspan", "rowspan", "align"], tfoot: [], th: ["colspan", "rowspan", "align", "scope"],
  thead: [], tr: [], tt: [], u: [], ul: [], var: [], wbr: [],
};

const SAFE_STYLE = /^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i;
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function sanitizeChildren(parent: ParentNode) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const tag = el.localName;
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    const allowed = ALLOWED[tag];
    if (!allowed) {
      // Unknown tag: keep what's inside it.
      sanitizeChildren(el);
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const keep =
        (GLOBAL_ATTRS.includes(name) || allowed.includes(name) || (name === "style" && SAFE_STYLE.test(attr.value))) &&
        !(name === "href" && HAS_SCHEME.test(attr.value.trim()) && !SAFE_HREF.test(attr.value.trim())) &&
        !((name === "width" || name === "height") && !/^\d{1,5}%?$/.test(attr.value.trim()));
      if (!keep) el.removeAttribute(attr.name);
    }
    if (tag === "input") {
      if (el.getAttribute("type")?.toLowerCase() !== "checkbox") {
        el.remove();
        continue;
      }
      el.setAttribute("disabled", "");
    }
    sanitizeChildren(el);
  }
}

// ---------------------------------------------------------------- images

export interface LoadedImage {
  mime: string;
  bytes: Uint8Array;
  /** Object URL for showing it in the tab. */
  url: string;
}

function sniffImage(path: string, bytes: Uint8Array): { mime: string; decode?: "tiff" | "heic" } | null {
  const b = bytes;
  const ascii = (s: number, n: number) => String.fromCharCode(...b.subarray(s, s + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg" };
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return { mime: "image/png" };
  if (ascii(0, 4) === "GIF8") return { mime: "image/gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { mime: "image/webp" };
  if (ascii(0, 2) === "BM") return { mime: "image/bmp" };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) {
    return { mime: "image/png", decode: "tiff" };
  }
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (/^(avif|avis)$/.test(brand)) return { mime: "image/avif" };
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { mime: "image/png", decode: "heic" };
  }
  const head = new TextDecoder().decode(b.subarray(0, 2048)).trimStart().toLowerCase();
  if (extOf(path) === "svg" || head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return { mime: "image/svg+xml" };
  }
  return null;
}

async function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("Couldn't encode the image.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Make image bytes displayable: formats the web view can't show (TIFF, HEIC) become PNG. */
async function prepareImage(path: string, bytes: Uint8Array): Promise<LoadedImage> {
  const kind = sniffImage(path, bytes);
  if (!kind) throw new Error("not an image Unacro can show");
  let out = bytes;
  if (kind.decode) {
    const [canvas] = await decodeImage(bytes, kind.decode);
    out = await canvasToPng(canvas);
    canvas.width = canvas.height = 0;
  }
  const url = URL.createObjectURL(new Blob([out as BlobPart], { type: kind.mime }));
  return { mime: kind.mime, bytes: out, url };
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------------------------------------------------------------- documents

/** Reads a local file, e.g. Platform.readPath. */
export type ReadFile = (path: string) => Promise<Uint8Array>;

interface ImageSlot {
  ref: ImageRef;
  /** The address as written in the Markdown, for placeholders. */
  src: string;
  alt: string;
}

export interface ImageCounts {
  /** Local images that couldn't be read. */
  missing: number;
  /** Images on the web (loaded or not). */
  remote: number;
  /** Image references Unacro can't follow, e.g. other URL schemes. */
  unsupported: number;
}

export class MdDocument {
  /** Sanitized HTML; every image is an <img data-md-img="n"> without an address. */
  private html = "";
  private slots: ImageSlot[] = [];
  private local = new Map<string, Promise<LoadedImage | null>>();
  /** Whether the user has allowed web images for this document (this session only). */
  remoteAllowed = false;
  title: string | null = null;
  text = "";

  private constructor(private read: ReadFile, public path: string | null) {}

  static async create(read: ReadFile, path: string | null, text: string): Promise<MdDocument> {
    const doc = new MdDocument(read, path);
    await doc.update(text);
    return doc;
  }

  /** Re-render from new text (e.g. the file changed on disk). Images are read again. */
  async update(text: string) {
    const md = await loadEngine();
    const { body, title } = splitFrontMatter(text);
    const tpl = document.createElement("template");
    tpl.innerHTML = md.render(body);
    sanitizeChildren(tpl.content);
    const slots: ImageSlot[] = [];
    for (const img of tpl.content.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      img.removeAttribute("src");
      img.setAttribute("data-md-img", String(slots.length));
      slots.push({ ref: resolveImageRef(src, this.path), src, alt: img.getAttribute("alt") ?? "" });
    }
    this.disposeImages();
    this.text = text;
    this.html = tpl.innerHTML;
    this.slots = slots;
    this.title = title ?? firstHeading(body);
  }

  private loadLocal(path: string): Promise<LoadedImage | null> {
    let p = this.local.get(path);
    if (!p) {
      p = this.read(path)
        .then((bytes) => prepareImage(path, bytes))
        .catch(() => null);
      this.local.set(path, p);
    }
    return p;
  }

  /** Read every local image (once). */
  async loadImages() {
    await Promise.all(this.slots.map((s) => (s.ref.kind === "local" ? this.loadLocal(s.ref.path) : null)));
  }

  async counts(): Promise<ImageCounts> {
    await this.loadImages();
    const c: ImageCounts = { missing: 0, remote: 0, unsupported: 0 };
    for (const s of this.slots) {
      if (s.ref.kind === "remote") c.remote++;
      else if (s.ref.kind === "unsupported") c.unsupported++;
      else if (s.ref.kind === "local" && !(await this.local.get(s.ref.path))) c.missing++;
    }
    return c;
  }

  private placeholder(slot: ImageSlot, problem: "missing" | "remote" | "failed" | "unsupported"): HTMLElement {
    const ph = document.createElement("span");
    ph.className = `md-ph ${problem}`;
    const label = document.createElement("b");
    const detail = document.createElement("span");
    const ref = slot.ref;
    if (problem === "missing") {
      label.textContent = "Missing image";
      detail.textContent = slot.src;
      if (ref.kind === "local") ph.title = ref.path;
    } else if (problem === "remote" || problem === "failed") {
      label.textContent = problem === "remote" ? "Web image, not loaded" : "Web image couldn't be loaded";
      detail.textContent = ref.kind === "remote" ? ref.url : slot.src;
      if (problem === "failed") ph.classList.add("missing");
    } else {
      label.textContent = "Image not shown";
      detail.textContent = ref.kind === "unsupported" ? `${slot.src || "(no address)"}: ${ref.reason}` : slot.src;
    }
    ph.append(label, detail);
    return ph;
  }

  /**
   * The rendered document as DOM, with images filled in.
   * `forPrint` embeds local images as data URLs so the page needs nothing else.
   */
  private async build(forPrint: boolean): Promise<DocumentFragment> {
    await this.loadImages();
    const tpl = document.createElement("template");
    tpl.innerHTML = this.html;
    const frag = tpl.content;
    for (const img of [...frag.querySelectorAll<HTMLImageElement>("img[data-md-img]")]) {
      const slot = this.slots[Number(img.dataset.mdImg)];
      if (!slot) continue;
      const ref = slot.ref;
      if (ref.kind === "data") {
        img.setAttribute("src", ref.url);
      } else if (ref.kind === "local") {
        const loaded = await this.local.get(ref.path);
        if (!loaded) img.replaceWith(this.placeholder(slot, "missing"));
        else img.setAttribute("src", forPrint ? `data:${loaded.mime};base64,${toBase64(loaded.bytes)}` : loaded.url);
      } else if (ref.kind === "remote") {
        if (this.remoteAllowed) {
          img.setAttribute("referrerpolicy", "no-referrer");
          img.setAttribute("data-md-remote", img.dataset.mdImg ?? "");
          img.setAttribute("src", ref.url);
        } else {
          img.replaceWith(this.placeholder(slot, "remote"));
        }
      } else {
        img.replaceWith(this.placeholder(slot, "unsupported"));
      }
      img.removeAttribute("data-md-img");
    }
    const out = document.importNode(frag, true);
    if (!forPrint) {
      // A web image that fails to load (offline, gone) becomes a placeholder too.
      for (const img of out.querySelectorAll<HTMLImageElement>("img[data-md-remote]")) {
        const slot = this.slots[Number(img.dataset.mdRemote)];
        img.addEventListener("error", () => slot && img.replaceWith(this.placeholder(slot, "failed")), { once: true });
      }
    }
    return out;
  }

  /** The document for showing in its tab. */
  view(): Promise<DocumentFragment> {
    return this.build(false);
  }

  /** A complete, self-contained HTML page to print to PDF. */
  async printPage(paper: Paper, fallbackTitle: string): Promise<string> {
    const frag = await this.build(true);
    const holder = document.createElement("div");
    holder.append(frag);
    const { width, height } = PAPER_SIZE[paper];
    return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(this.title ?? fallbackTitle)}</title>
<style>@page { size: ${width}pt ${height}pt; } html, body { margin: 0; padding: 0; background: #fff; }</style>
<style>${mdCss}</style>
</head><body><article class="md">${holder.innerHTML}</article></body></html>`;
  }

  private disposeImages() {
    for (const p of this.local.values()) void p.then((img) => img && URL.revokeObjectURL(img.url));
    this.local.clear();
  }

  dispose() {
    this.disposeImages();
  }
}
