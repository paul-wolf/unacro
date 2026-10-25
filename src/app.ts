// The application: open documents (tabs), page sidebar, viewer, and all actions.

import { buildPdf } from "./core/build";
import { pagesToMarkdown } from "./core/markdown";
import { clonePages, movePages, normRotation, pagesForSource, uid, type Crop, type Mark, type MarkType, type PageRef, type Stamp } from "./core/model";

type Tool = "select" | MarkType | "crop";
import { MARK_COLORS, MARK_WIDTHS, arrowGeometry } from "./core/marks";
import {
  CALLOUT_FONT,
  CALLOUT_FONT_SIZE,
  CALLOUT_LINE_HEIGHT,
  CALLOUT_MIN_WIDTH,
  CALLOUT_PAD_X,
  CALLOUT_PAD_Y,
  CALLOUT_TEXT_COLOR,
  baseline,
  boxHeight,
  boxPath,
  dotRadius,
  frame,
  layoutCallout,
  leader,
  toLocal,
} from "./core/callout";
import { Source, Sources, cropWindow, displaySize, flattenPage, renderInto, renderTextLayer, totalRotation, viewportFor } from "./pdf";
import {
  IMAGE_LABEL,
  IMAGE_SAVE_EXT,
  WRITABLE_IMAGE_FORMATS,
  ALL_EXTS,
  detect,
  extOf,
  replaceExt,
  saveFormatOf,
  type ImageFormat,
} from "./core/formats";
import { encodeCanvas } from "./images";
import { createModelViewer, parseStl, type LoadedModel, type ModelViewer, type ViewState } from "./model3d";
import { MdDocument, mdCss, type ImageCounts } from "./mdview";
import { PAGE_MARGIN, PAPER_SIZE, joinPath, paperForLocale, type Paper } from "./core/mdsource";
import { PDFDocument } from "pdf-lib";
import { HistoryStore, kindOfPath, loadSettings, saveSettings, type Settings } from "./history";
import { LibraryView } from "./ui/library";
import { showSwitcher, isSwitcherOpen, type SwitcherItem } from "./ui/switcher";
import { splitPath, type HistoryKind } from "./core/history";
import { isMac, type OpenedFile, type Platform } from "./platform";
import { closeMenus, h, icon, isModalOpen, modal, openMenu, showPopover, toast, type MenuItem } from "./ui/dom";
import {
  addSignature,
  dataUrlToBytes,
  drawSignatureDialog,
  importSignatureImage,
  loadSignatures,
  removeSignature,
  type Signature,
} from "./ui/signatures";

interface Doc {
  id: string;
  name: string;
  path: string | null;
  pages: PageRef[];
  /** Snapshot of `pages` at the last save/open, to know whether there are unsaved changes. */
  saved: string;
  undo: PageRef[][];
  redo: PageRef[][];
  selection: Set<string>;
  anchor: string | null;
  zoom: number | "fit";
  scrollTop: number;
  /** "pages" for PDFs and images; "model" for a 3D model and "markdown" for a Markdown file, which have no pages. */
  kind: "pages" | "model" | "markdown";
  /** Set when the document was opened from an image, so Save writes an image back. */
  imageFormat: ImageFormat | null;
  model: LoadedModel | null;
  view3d: ViewState | null;
  /** A Markdown document, rendered. */
  md: MdDocument | null;
  /** The Markdown file's size and modification time when last read, to notice edits. */
  mdStamp: string | null;
  /** What happened to its images, once they've been looked at. */
  mdImages: ImageCounts | null;
  /** Whether the markup bar is shown for this document. */
  markup: boolean;
  /** Snapshot of `pages` when the document was last copied to the clipboard. */
  copied: string | null;
  /** For a new, never-saved document made from another file: where Save should start. */
  nearPath: string | null;
  /** Pinned tabs are never closed automatically. */
  pinned: boolean;
  /** When the tab was last shown (for closing the least recently used ones). */
  lastActive: number;
}

interface PageEl {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  stamps: HTMLDivElement;
  marks: SVGSVGElement;
  /** Holds the full page; shifted inside `el` when the page is cropped. */
  content: HTMLDivElement;
  key: string;
  rendered: string | null;
  visible: boolean;
}

const MOD = isMac() ? "⌘" : "Ctrl+";
const SHIFT = isMac() ? "⇧" : "Shift+";
const ALT = isMac() ? "⌥" : "Alt+";
const THUMB_W = 116;
const THUMB_H = 150;
const PAGE_GAP = 16;

const SVG_NS = "http://www.w3.org/2000/svg";
const MARKUP_KEY = "unacro.markup";
const PAPER_KEY = "unacro.paper";
/** CSS pixels per PDF point. */
const PX_PER_PT = 96 / 72;
const JPEG_QUALITY_KEY = "unacro.jpegQuality";

const snapshot = (pages: PageRef[]) => JSON.stringify(pages);
const isDirty = (d: Doc) => snapshot(d.pages) !== d.saved;

export class App {
  private sources = new Sources();
  private docs: Doc[] = [];
  private active: Doc | null = null;
  private images = new Map<string, Uint8Array>();
  private clipboard: PageRef[] = [];
  private placing: Signature | null = null;
  private selectedStamp: string | null = null;
  private selectedMark: string | null = null;
  private tool: Tool = "select";
  /** A crop rectangle being drawn, in page-content CSS px. */
  private cropDraft: { pageId: string; l: number; t: number; w: number; h: number } | null = null;
  private markColor = MARK_COLORS[0];
  private markWidth = MARK_WIDTHS[1];
  private markupBar = h("div", { class: "markup-bar", role: "toolbar", "aria-label": "Markup" });
  /** The callout whose text is being typed, and its text box. */
  private editing: { pageId: string; mark: Mark; isNew: boolean; textarea: HTMLTextAreaElement } | null = null;
  private calloutFontBytes: Promise<Uint8Array> | null = null;
  private settings: Settings = loadSettings();
  private history: HistoryStore;
  private library: LibraryView;
  /** The document shown before switching to the Library, to switch back to. */
  private lastDoc: Doc | null = null;
  /** The last plain click (press and release without moving) on a shape, to spot double-clicks. */
  private lastMarkClick: { id: string; t: number; x: number; y: number } | null = null;
  private search = { query: "", hits: [] as string[], cur: -1, running: 0 };
  private currentPageId: string | null = null;

  private pageEls = new Map<string, PageEl>();
  private thumbEls = new Map<string, { el: HTMLElement; canvas: HTMLCanvasElement; key: string; rendered: string | null }>();
  private pageObserver!: IntersectionObserver;
  private thumbObserver!: IntersectionObserver;
  private scale = 1;

  // DOM
  private root = document.getElementById("app")!;
  private toolbar = h("header", { class: "toolbar" });
  private tabs = h("nav", { class: "tabs", "aria-label": "Open documents" });
  private sidebar = h("aside", { class: "sidebar", tabindex: "0", "aria-label": "Pages" });
  private viewer = h("section", { class: "viewer", "aria-label": "Document" });
  private pagesHost = h("div", { class: "pages" });
  private modelHost = h("section", { class: "model-view", "aria-label": "3D model" });
  private modelViewer: ModelViewer | null = null;
  private modelViewerLoading: Promise<ModelViewer | null> | null = null;
  // Markdown documents are shown in a shadow root so their styles and the app's stay apart.
  private mdHost = h("section", { class: "md-view", "aria-label": "Markdown document" });
  private mdBar = h("div", { class: "bar", hidden: true });
  private mdArticle = h("article", { class: "md" });
  private mdPaper = h("div", { class: "paper" }, this.mdArticle);
  private mdScroll = h("div", { class: "scroll", tabindex: "-1" }, this.mdPaper);
  private mdShown: Doc | null = null;
  private converting = false;
  private status = h("footer", { class: "statusbar" });
  private searchInput = h("input", { class: "search-input", type: "search", placeholder: "Find", "aria-label": "Find in document" });
  private searchInfo = h("span", { class: "search-info" });
  private buttons: Record<string, HTMLButtonElement> = {};

  constructor(private platform: Platform) {
    this.history = new HistoryStore(platform, () => this.settings.historyMonths);
    this.library = new LibraryView({
      history: this.history,
      isOpen: (path) => this.docs.some((d) => d.path === path),
      open: (path) => void this.openPath(path),
      reveal: (path) => void this.platform.reveal(path).catch((e: any) => toast(`Couldn't open the folder: ${e?.message ?? e}`, "error")),
      revealLabel: isMac() ? "Show in Finder" : /Windows/.test(navigator.userAgent) ? "Show in Explorer" : "Open Folder",
      canReveal: platform.canReveal,
      copyPath: (path) => this.copyPath(path),
      openDialog: () => void this.openDialog(),
      newFromClipboard: () => void this.newFromClipboard(),
      settings: () => void this.settingsDialog(),
      months: () => this.settings.historyMonths,
    });
  }

  // ================================================================ setup

  async start() {
    for (const sig of loadSignatures()) this.images.set(sig.id, dataUrlToBytes(sig.dataUrl));
    await this.history.load();
    this.history.onChange = () => {
      if (!this.active) this.library.render();
    };
    window.addEventListener("beforeunload", () => void this.history.save());
    this.buildChrome();
    this.pageObserver = new IntersectionObserver((entries) => this.onPagesVisible(entries), {
      root: this.viewer,
      rootMargin: "600px 0px",
    });
    this.thumbObserver = new IntersectionObserver((entries) => this.onThumbsVisible(entries), {
      root: this.sidebar,
      rootMargin: "300px 0px",
    });
    new ResizeObserver(() => this.active?.zoom === "fit" && this.layoutViewer()).observe(this.viewer);
    new ResizeObserver(() => this.active?.kind === "markdown" && this.active.zoom === "fit" && this.layoutMarkdown()).observe(this.mdHost);
    // An open Markdown file follows its file on disk, so it can sit next to an editor.
    window.setInterval(() => void this.checkMarkdownFile(), 1200);
    this.viewer.addEventListener("scroll", () => this.onViewerScroll(), { passive: true });
    this.viewer.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || !this.active) return;
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false },
    );
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.platform.onFileDrop((getFiles, x, y) => void this.onFileDrop(getFiles, x, y));
    this.platform.onCloseRequested(() => this.confirmQuit());
    this.render();

    // Listen before asking for the startup files, so nothing sent in between is missed.
    await this.platform.onOpenPaths((paths) => this.openPaths(paths));
    this.openPaths(await this.platform.initialPaths().catch(() => [] as string[]));
  }

  /** Open files one after another, so the same file opened twice quickly gets one tab. */
  private openQueue: Promise<void> = Promise.resolve();
  openPaths(paths: string[]) {
    for (const p of paths) this.openQueue = this.openQueue.then(() => this.openPath(p));
  }

  private buildChrome() {
    const btn = (name: string, label: string, onclick: () => void, iconName?: string, text?: string) => {
      const b = h(
        "button",
        { class: `tool${text ? " with-text" : ""}`, title: label, "aria-label": label, onclick },
        iconName ? icon(iconName) : null,
        text ? h("span", {}, text) : null,
      );
      this.buttons[name] = b;
      return b;
    };
    const fileMenuBtn = h("button", { class: "tool with-text menu-button", onclick: (e: MouseEvent) => this.showFileMenu(e.currentTarget as HTMLElement) }, h("span", {}, "File"), icon("chevron"));
    this.toolbar.append(
      fileMenuBtn,
      btn("open", `Open… (${MOD}O)`, () => void this.openDialog(), "open"),
      btn("save", `Save (${MOD}S)`, () => void this.save(), "save"),
      h("div", { class: "sep" }),
      btn("undo", `Undo (${MOD}Z)`, () => this.undo(), "undo"),
      btn("redo", `Redo (${SHIFT}${MOD}Z)`, () => this.redo(), "redo"),
      h("div", { class: "sep" }),
      btn("insert", "Insert pages from a PDF…", () => void this.insertFromFile(), "insert", "Insert"),
      btn("rotl", `Rotate left (${MOD}L)`, () => this.rotateSelected(-90), "rotl"),
      btn("rotr", `Rotate right (${MOD}R)`, () => this.rotateSelected(90), "rotr"),
      btn("delete", "Delete selected pages (Delete)", () => this.deleteSelected(), "trash"),
      h("div", { class: "sep" }),
      btn("sign", "Add a signature", () => this.showSignMenu(this.buttons.sign), "sign", "Sign"),
      btn("markup", "Show or hide the markup tools", () => this.toggleMarkup(), "pen", "Markup"),
      btn("convert", "Open a copy in another format", () => this.showConvertMenu(this.buttons.convert), "convert", "Convert"),
      btn("md", "Markdown", () => this.showMarkdownMenu(this.buttons.md), "md", "Markdown"),
      h("div", { class: "spacer" }),
      btn("zoomout", `Zoom out (${MOD}−)`, () => this.zoomBy(1 / 1.2), "minus"),
      h("button", { class: "tool zoom-label", title: `Fit width (${MOD}0)`, onclick: () => this.setZoom("fit") }, h("span", { class: "zoom-value" }, "Fit")),
      btn("zoomin", `Zoom in (${MOD}+)`, () => this.zoomBy(1.2), "plus"),
      h("div", { class: "sep" }),
      h("label", { class: "search" }, icon("search"), this.searchInput, this.searchInfo),
    );

    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.runSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        this.searchInput.value = "";
        this.clearSearch();
        this.viewer.focus();
      }
    });
    this.searchInput.addEventListener("input", () => {
      if (!this.searchInput.value) this.clearSearch();
    });

    this.viewer.tabIndex = -1;
    this.viewer.append(this.pagesHost);
    this.sidebar.addEventListener("keydown", (e) => this.onSidebarKey(e));
    this.sidebar.addEventListener("contextmenu", (e) => {
      if (!(e.target as HTMLElement).closest(".thumb")) {
        e.preventDefault();
        this.showPagesMenu(e.clientX, e.clientY);
      }
    });
    this.tabs.addEventListener("dblclick", (e) => {
      if (e.target === this.tabs || (e.target as HTMLElement).classList?.contains("tab-strip")) void this.openDialog();
    });

    const workspace = h("main", { class: "workspace" }, this.sidebar, this.viewer, this.modelHost, this.mdHost, this.library.el);
    this.buildMarkdownView();
    this.buildMarkupBar();
    this.root.append(this.toolbar, this.tabs, this.markupBar, workspace, this.status);
  }

  // ================================================================ documents

  private newDoc(name: string, path: string | null, pages: PageRef[], clean = true, extra: Partial<Doc> = {}): Doc {
    const doc: Doc = {
      kind: "pages",
      imageFormat: null,
      model: null,
      view3d: null,
      md: null,
      mdStamp: null,
      mdImages: null,
      markup: !!extra.imageFormat,
      copied: null,
      nearPath: null,
      pinned: false,
      lastActive: Date.now(),
      id: uid("d"),
      name,
      path,
      pages,
      saved: clean ? snapshot(pages) : "",
      undo: [],
      redo: [],
      selection: new Set(),
      anchor: null,
      zoom: "fit",
      scrollTop: 0,
      ...extra,
    };
    this.docs.push(doc);
    return doc;
  }

  /** Load a PDF or image as a page source. 3D models can't become pages. */
  private async loadSource(file: OpenedFile): Promise<Source | null> {
    try {
      const kind = detect(file.name, file.bytes);
      if (!kind) throw new Error(`Unacro can't open “${file.name}”.`);
      if (kind.kind === "model") throw new Error(`“${file.name}” is a 3D model, so it can't be added as pages.`);
      const src = kind.kind === "image"
        ? await Source.loadImage(file.name, file.bytes, kind.format!)
        : kind.kind === "markdown"
          ? await Source.load(replaceExt(file.name, "pdf"), await this.markdownFileToPdf(file))
          : await Source.load(file.name, file.bytes);
      this.sources.add(src);
      return src;
    } catch (e: any) {
      toast(e?.message ?? String(e), "error");
      return null;
    }
  }

  private async openFiles(files: OpenedFile[]) {
    let last: Doc | null = null;
    for (const f of files) {
      const existing = f.path ? this.docs.find((d) => d.path === f.path) : undefined;
      if (existing) {
        last = existing;
        continue;
      }
      if (detect(f.name, f.bytes)?.kind === "markdown") {
        const doc = await this.openMarkdown(f);
        if (doc) last = doc;
        continue;
      }
      if (detect(f.name, f.bytes)?.kind === "model") {
        try {
          const model = await parseStl(f.bytes);
          last = this.newDoc(f.name, f.path, [], true, { kind: "model", model });
          if (f.path) this.history.record(f.path, "model", true);
        } catch (e: any) {
          toast(`Couldn't open “${f.name}”: ${e?.message ?? e}`, "error");
        }
        continue;
      }
      const src = await this.loadSource(f);
      if (!src) continue;
      last = this.newDoc(f.name, f.path, pagesForSource(src.id, src.pageCount), true, {
        imageFormat: src.original?.format ?? null,
      });
      if (f.path) {
        this.history.record(f.path, src.original ? "image" : "pdf", true);
        void this.saveThumb(last);
      }
    }
    if (last) {
      this.activate(last);
      this.enforceTabLimit();
    }
  }

  async openDialog() {
    try {
      await this.openFiles(await this.platform.pickFiles(true));
    } catch (e: any) {
      toast(`Couldn't open: ${e?.message ?? e}`, "error");
    }
  }

  async openPath(path: string) {
    const open = this.docs.find((d) => d.path === path);
    if (open) return this.activate(open);
    try {
      await this.openFiles([await this.platform.readPath(path)]);
    } catch (e: any) {
      toast(`Couldn't open ${path}: ${e?.message ?? e}`, "error");
      if (this.history.get(path)) void this.history.refreshExistence(true).then(() => !this.active && this.library.render());
    }
  }

  /** Open the image on the clipboard (e.g. a screenshot) as a new, unsaved image. */
  async newFromClipboard() {
    let png: Uint8Array | null;
    try {
      png = await this.platform.readClipboardImage();
    } catch (e: any) {
      toast(`Couldn't read the clipboard: ${e?.message ?? e}`, "error");
      return;
    }
    if (!png) return toast("There's no image on the clipboard. Take a screenshot to the clipboard first.");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `Screenshot ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
    try {
      const src = await Source.loadImage(name, png, "png");
      this.sources.add(src);
      this.activate(this.newDoc(name, null, pagesForSource(src.id, src.pageCount), false, { imageFormat: "png" }));
    } catch (e: any) {
      toast(e?.message ?? String(e), "error");
    }
  }

  /** Pick several PDFs or images and combine them into a new, unsaved PDF. */
  async combineFromFiles() {
    const files = await this.platform.pickFiles(true, "pages").catch((e) => {
      toast(String(e?.message ?? e), "error");
      return [] as OpenedFile[];
    });
    if (!files.length) return;
    const pages: PageRef[] = [];
    for (const f of files) {
      const src = await this.loadSource(f);
      if (src) pages.push(...pagesForSource(src.id, src.pageCount));
    }
    if (!pages.length) return;
    const doc = this.newDoc("Combined.pdf", null, pages, false);
    this.activate(doc);
    toast(`Combined ${files.length} file${files.length === 1 ? "" : "s"}. Save to choose where it goes.`);
  }

  async combineOpenTabs() {
    const docs = this.docs.filter((d) => d.kind !== "model");
    if (docs.length < 2) return;
    const pages: PageRef[] = [];
    for (const d of docs) {
      if (d.kind === "pages") {
        pages.push(...clonePages(d.pages));
        continue;
      }
      try {
        const src = await Source.load(replaceExt(d.name, "pdf"), await this.markdownToPdf(d.md!, d.name));
        this.sources.add(src);
        pages.push(...pagesForSource(src.id, src.pageCount));
      } catch (e: any) {
        toast(`Couldn't add “${d.name}”: ${e?.message ?? e}`, "error");
      }
    }
    if (pages.length) this.activate(this.newDoc("Combined.pdf", null, pages, false));
  }

  private activate(doc: Doc | null) {
    this.finishEditing();
    if (doc) {
      doc.lastActive = Date.now();
      // Count viewing a file as using it, at most once a minute per file.
      const h = doc.path ? this.history.get(doc.path) : undefined;
      if (doc.path && (!h || Date.now() - h.last > 60_000)) this.history.record(doc.path, this.historyKind(doc), false);
    } else if (this.active) {
      this.lastDoc = this.active;
    }
    if (this.active && this.active !== doc) {
      this.active.scrollTop = this.active.kind === "markdown" ? this.mdScroll.scrollTop : this.viewer.scrollTop;
      if (this.active.kind === "model") this.active.view3d = this.modelViewer?.getView() ?? null;
      this.modelShown = null;
      this.mdShown = null;
    }
    this.active = doc;
    this.selectedStamp = null;
    this.selectedMark = null;
    this.cropDraft = null;
    for (const b of this.pagesHost.querySelectorAll(".crop-box")) b.remove();
    this.placing = null;
    this.clearSearch(false);
    this.render(true);
    if (doc && doc.kind !== "markdown") {
      requestAnimationFrame(() => (this.viewer.scrollTop = doc.scrollTop));
    }
  }

  async closeDoc(doc: Doc): Promise<boolean> {
    // A never-saved document (e.g. a pasted screenshot) whose current state is on
    // the clipboard closes without asking: the clipboard already has the work.
    const copiedAsIs = !doc.path && doc.copied === snapshot(doc.pages);
    if (isDirty(doc) && !copiedAsIs) {
      this.activate(doc);
      const choice = await modal<"save" | "discard" | "cancel">({
        title: `Save changes to “${doc.name}”?`,
        body: "Your changes will be lost if you don't save them.",
        cancelValue: "cancel",
        buttons: [
          { label: "Don't Save", value: "discard", kind: "danger" },
          { label: "Cancel", value: "cancel" },
          { label: "Save", value: "save", kind: "primary" },
        ],
      });
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.save(doc))) return false;
    }
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    if (doc.md) {
      if (this.mdShown === doc) this.mdShown = null;
      doc.md.dispose();
    }
    if (doc.model) {
      if (this.modelShown === doc) this.modelShown = null;
      const geometry = doc.model.geometry;
      setTimeout(() => geometry.dispose()); // after the viewer has switched away from it
    }
    if (this.active === doc) this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    else this.render();
    this.collectSources();
    return true;
  }

  private async closeOthers(keep: Doc) {
    for (const d of [...this.docs]) if (d !== keep && !(await this.closeDoc(d))) return;
  }

  /** Close every tab (asking about unsaved changes as usual) and show the Library. */
  async closeAll() {
    for (const d of [...this.docs]) if (!(await this.closeDoc(d))) return;
    this.showLibrary();
  }

  private async confirmQuit(): Promise<boolean> {
    for (const d of [...this.docs]) {
      if (!(await this.closeDoc(d))) return false;
    }
    return true;
  }

  private collectSources() {
    const used = new Set<string>();
    const mark = (pages: PageRef[]) => pages.forEach((p) => used.add(p.sourceId));
    for (const d of this.docs) {
      mark(d.pages);
      d.undo.forEach(mark);
      d.redo.forEach(mark);
    }
    mark(this.clipboard);
    this.sources.collect(used);
  }

  // ================================================================ saving

  /** Write the document to `path` in the format its extension asks for. */
  private async writeTo(doc: Doc, path: string) {
    const format = saveFormatOf(path);
    if (format === "pdf" || format === null) {
      const hasCallouts = doc.pages.some((p) => p.marks.some((m) => m.type === "callout"));
      const bytes = await buildPdf({
        pages: doc.pages,
        sources: this.sources.bytesMap(),
        images: this.images,
        calloutFont: hasCallouts ? await this.calloutFont() : undefined,
      });
      await this.platform.write(path, bytes);
      return;
    }
    const problem = this.imageSaveProblem(doc, format);
    if (problem) throw new Error(problem);
    // An untouched image saved in its own format is written byte for byte: no
    // re-compression, and its metadata (EXIF) survives.
    const ref = doc.pages[0];
    const original = this.sources.get(ref.sourceId).original;
    if (original && original.format === format && original.pointsPerPixel.length === 1 && !ref.rotation && !ref.stamps.length && !ref.marks.length && !ref.crop) {
      await this.platform.write(path, original.bytes);
      return;
    }
    const keepsAlpha = format === "png" || format === "tiff";
    const canvas = await flattenPage(this.sources, ref, this.images, !keepsAlpha);
    try {
      await this.platform.write(path, await encodeCanvas(canvas, format, this.jpegQuality()));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /** Why the document can't be written as this image format, or null if it can. */
  private imageSaveProblem(doc: Doc, format: ImageFormat): string | null {
    if (!WRITABLE_IMAGE_FORMATS.includes(format)) {
      return `Unacro can open ${IMAGE_LABEL[format]} images but can't save them, so choose another format.`;
    }
    if (doc.pages.length !== 1) return "This document has more than one page, so it needs to be saved as a PDF.";
    return null;
  }

  /** The name a save dialog suggests: the file's own name if it can be written as is. */
  private suggestedName(doc: Doc): string {
    const fmt = saveFormatOf(doc.name);
    if (!doc.imageFormat || fmt === "pdf") return fmt === "pdf" ? doc.name : replaceExt(doc.name, "pdf");
    if (doc.pages.length !== 1) return replaceExt(doc.name, "pdf");
    if (fmt && !WRITABLE_IMAGE_FORMATS.includes(fmt)) return replaceExt(doc.name, fmt === "heic" ? "jpg" : "png");
    return doc.name;
  }

  private saveKind(doc: Doc) {
    return doc.imageFormat && doc.pages.length === 1 ? "image" : "pdf";
  }

  /** Save to the document's own file, or ask where if it has none. Returns false if cancelled or failed. */
  async save(doc = this.active): Promise<boolean> {
    if (doc?.kind === "markdown") {
      toast("Unacro shows Markdown but doesn't change it. To make a PDF, use Convert → PDF.");
      return false;
    }
    if (!doc || doc.kind !== "pages") return false;
    if (!doc.path || doc.path.startsWith("download:")) return this.saveAs(doc);
    const format = saveFormatOf(doc.path);
    if (format && format !== "pdf") {
      if (!isDirty(doc)) {
        this.savedToast("No changes to save", doc.path);
        return true;
      }
      const problem = this.imageSaveProblem(doc, format);
      if (problem) {
        toast(problem);
        return this.saveAs(doc);
      }
    }
    try {
      await this.writeTo(doc, doc.path);
      doc.saved = snapshot(doc.pages);
      this.render();
      this.history.record(doc.path, this.historyKind(doc), false);
      void this.saveThumb(doc);
      this.savedToast(`Saved ${doc.name}`, doc.path);
      return true;
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
      return false;
    }
  }

  /** Save to a new file; the document now lives there. */
  async saveAs(doc = this.active): Promise<boolean> {
    if (doc?.kind === "markdown") {
      void this.exportMarkdownPdf(doc);
      return false;
    }
    if (!doc || doc.kind !== "pages") return false;
    const path = await this.platform.pickSavePath(this.suggestedName(doc), this.saveKind(doc), doc.path ?? doc.nearPath);
    if (!path) return false;
    try {
      await this.writeTo(doc, path);
      const format = saveFormatOf(path);
      doc.path = path;
      doc.name = this.platform.baseName(path);
      doc.imageFormat = format && format !== "pdf" ? format : null;
      doc.saved = snapshot(doc.pages);
      doc.nearPath = null;
      this.history.record(path, this.historyKind(doc), true);
      void this.saveThumb(doc);
      this.render();
      this.savedToast(`Saved as ${doc.name}`, path);
      return true;
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
      return false;
    }
  }

  /** Write the current state elsewhere; the open document keeps pointing at its file. */
  async saveCopy(doc = this.active, asPdf = false) {
    if (doc?.kind === "markdown") return void this.exportMarkdownPdf(doc);
    if (!doc || doc.kind !== "pages") return;
    const suggested = asPdf ? replaceExt(doc.name, "pdf") : this.suggestedName(doc);
    const dot = suggested.lastIndexOf(".");
    const name = asPdf ? suggested : `${suggested.slice(0, dot)} copy${suggested.slice(dot)}`;
    const path = await this.platform.pickSavePath(name, asPdf ? "pdf" : this.saveKind(doc), doc.path ?? doc.nearPath);
    if (!path) return;
    try {
      await this.writeTo(doc, path);
      this.history.record(path, kindOfPath(path), false);
      this.savedToast(`Saved a copy as ${this.platform.baseName(path)}`, path);
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
    }
  }

  // ================================================================ markdown

  private async markdownFor(doc: Doc): Promise<string> {
    if (doc.kind !== "pages") return "";
    const texts = await Promise.all(doc.pages.map((p) => this.sources.get(p.sourceId).pageText(p.index, p.rotation)));
    return pagesToMarkdown(texts);
  }

  async exportMarkdown() {
    const doc = this.active;
    if (!doc) return;
    const name = replaceExt(doc.name, "md");
    const path = await this.platform.pickSavePath(name, "md", doc.path ?? doc.nearPath);
    if (!path) return;
    try {
      const md = await this.markdownFor(doc);
      await this.platform.write(path, new TextEncoder().encode(md));
      this.savedToast(md.trim() ? `Exported ${this.platform.baseName(path)}` : "Exported, but this PDF has no text (it may be a scan).", path);
    } catch (e: any) {
      toast(`Couldn't export: ${e?.message ?? e}`, "error");
    }
  }

  async copyMarkdown() {
    const doc = this.active;
    if (!doc) return;
    try {
      const md = await this.markdownFor(doc);
      await this.platform.writeClipboardText(md);
      toast(md.trim() ? "Markdown copied to the clipboard" : "This PDF has no text to copy (it may be a scan).");
    } catch (e: any) {
      toast(`Couldn't copy: ${e?.message ?? e}`, "error");
    }
  }

  // ================================================================ page editing

  private commit(doc: Doc, pages: PageRef[]) {
    doc.undo.push(doc.pages);
    if (doc.undo.length > 200) doc.undo.shift();
    doc.redo = [];
    doc.pages = pages;
    const ids = new Set(pages.map((p) => p.id));
    for (const id of doc.selection) if (!ids.has(id)) doc.selection.delete(id);
    this.render();
  }

  undo() {
    if (this.editing) return this.finishEditing();
    const d = this.active;
    if (!d?.undo.length) return;
    d.redo.push(d.pages);
    d.pages = d.undo.pop()!;
    this.selectedStamp = null;
    this.selectedMark = null;
    this.clearCropDraft();
    this.render();
  }

  redo() {
    if (this.editing) return this.finishEditing();
    const d = this.active;
    if (!d?.redo.length) return;
    d.undo.push(d.pages);
    d.pages = d.redo.pop()!;
    this.selectedStamp = null;
    this.selectedMark = null;
    this.clearCropDraft();
    this.render();
  }

  /** Selected pages, or the current page if nothing is selected. */
  private targetIds(doc: Doc): Set<string> {
    if (doc.selection.size) return doc.selection;
    return new Set(this.currentPageId ? [this.currentPageId] : []);
  }

  rotateSelected(delta: number) {
    const d = this.active;
    if (!d) return;
    const ids = this.targetIds(d);
    if (!ids.size) return;
    this.commit(d, d.pages.map((p) => (ids.has(p.id) ? { ...p, rotation: normRotation(p.rotation + delta) } : p)));
  }

  deleteSelected() {
    const d = this.active;
    if (!d || !d.selection.size) {
      if (d) toast("Select pages in the sidebar first.");
      return;
    }
    const remaining = d.pages.filter((p) => !d.selection.has(p.id));
    if (!remaining.length) {
      toast("A document needs at least one page.", "error");
      return;
    }
    const n = d.pages.length - remaining.length;
    const firstIdx = d.pages.findIndex((p) => d.selection.has(p.id));
    d.selection.clear();
    this.commit(d, remaining);
    const next = remaining[Math.min(firstIdx, remaining.length - 1)];
    d.selection.add(next.id);
    d.anchor = next.id;
    this.render();
    toast(`Deleted ${n} page${n === 1 ? "" : "s"}. ${MOD}Z to undo.`);
  }

  /** Insert position: after the last selected page, else at the end. */
  private insertIndex(d: Doc) {
    let idx = -1;
    d.pages.forEach((p, i) => d.selection.has(p.id) && (idx = i));
    return idx === -1 ? d.pages.length : idx + 1;
  }

  private insertPages(d: Doc, pages: PageRef[], at: number) {
    const next = [...d.pages.slice(0, at), ...pages, ...d.pages.slice(at)];
    this.commit(d, next);
    d.selection = new Set(pages.map((p) => p.id));
    d.anchor = pages[0]?.id ?? null;
    this.render();
    requestAnimationFrame(() => this.scrollToPage(pages[0].id));
  }

  async insertFromFile(at?: number) {
    const d = this.active;
    if (!d || d.kind !== "pages") return this.openDialog();
    const files = await this.platform.pickFiles(true, "pages").catch(() => [] as OpenedFile[]);
    await this.insertFiles(d, files, at ?? this.insertIndex(d));
  }

  private async insertFiles(d: Doc, files: OpenedFile[], at: number) {
    const pages: PageRef[] = [];
    for (const f of files) {
      const src = await this.loadSource(f);
      if (src) pages.push(...pagesForSource(src.id, src.pageCount));
    }
    if (!pages.length) return;
    this.insertPages(d, pages, at);
    toast(`Inserted ${pages.length} page${pages.length === 1 ? "" : "s"}`);
  }

  copyPages() {
    const d = this.active;
    if (!d || !d.selection.size) return;
    this.clipboard = d.pages.filter((p) => d.selection.has(p.id));
    toast(`Copied ${this.clipboard.length} page${this.clipboard.length === 1 ? "" : "s"}`);
  }

  pastePages() {
    const d = this.active;
    if (!d || d.kind !== "pages" || !this.clipboard.length) return;
    this.insertPages(d, clonePages(this.clipboard), this.insertIndex(d));
  }

  extractSelection() {
    const d = this.active;
    if (!d || !d.selection.size) return;
    const pages = clonePages(d.pages.filter((p) => d.selection.has(p.id)));
    const base = d.name.replace(/\.[^.]+$/, "");
    this.activate(this.newDoc(`${base} (pages).pdf`, null, pages, false));
  }

  // ================================================================ selection

  private selectPage(d: Doc, id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) {
    const toggle = isMac() ? e.metaKey : e.ctrlKey;
    if (e.shiftKey && d.anchor) {
      const a = d.pages.findIndex((p) => p.id === d.anchor);
      const b = d.pages.findIndex((p) => p.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!toggle) d.selection.clear();
      for (let i = lo; i <= hi; i++) d.selection.add(d.pages[i].id);
    } else if (toggle) {
      if (d.selection.has(id)) d.selection.delete(id);
      else d.selection.add(id);
      d.anchor = id;
    } else {
      d.selection = new Set([id]);
      d.anchor = id;
    }
    this.renderSelection();
  }

  // ================================================================ signatures

  private showSignMenu(anchor: HTMLElement) {
    if (this.active?.kind !== "pages") return;
    const sigs = loadSignatures();
    const r = anchor.getBoundingClientRect();
    const panel = h("div", { class: "menu sign-menu", role: "menu" });
    if (sigs.length) {
      const grid = h("div", { class: "sig-grid" });
      for (const s of sigs) {
        const item = h(
          "div",
          { class: "sig-item" },
          h("button", { class: "sig-pick", title: "Place this signature", onclick: () => { closeMenus(); this.startPlacing(s); } }, h("img", { src: s.dataUrl, alt: "Saved signature" })),
          h("button", {
            class: "sig-remove",
            title: "Remove from saved signatures",
            "aria-label": "Remove signature",
            onclick: async () => {
              closeMenus();
              const ok = await modal({
                title: "Remove this signature?",
                body: "It will no longer be offered here. Documents you've already signed are not affected.",
                cancelValue: false,
                buttons: [{ label: "Cancel", value: false }, { label: "Remove", value: true, kind: "danger" }],
              });
              if (ok) removeSignature(s.id);
            },
          }, icon("x")),
        );
        grid.append(item);
      }
      panel.append(h("div", { class: "menu-heading" }, "Click a signature, then click on the page"), grid, h("div", { class: "menu-sep" }));
    }
    const add = async (fn: () => Promise<Signature | null>) => {
      closeMenus();
      const sig = await fn();
      if (!sig) return;
      addSignature(sig);
      this.images.set(sig.id, dataUrlToBytes(sig.dataUrl));
      this.startPlacing(sig);
    };
    panel.append(
      h("button", { class: "menu-item", onclick: () => add(drawSignatureDialog) }, h("span", { class: "menu-label" }, "Draw a new signature…")),
      h("button", { class: "menu-item", onclick: () => add(importSignatureImage) }, h("span", { class: "menu-label" }, "Import from an image…")),
    );
    showPopover(panel, r.left, r.bottom + 4);
  }

  private startPlacing(sig: Signature) {
    this.images.set(sig.id, dataUrlToBytes(sig.dataUrl));
    this.placing = sig;
    this.selectedStamp = null;
    this.root.classList.add("placing");
    toast("Click on a page to place the signature. Esc to cancel.");
  }

  private stopPlacing() {
    this.placing = null;
    this.root.classList.remove("placing");
  }

  private placeAt(ref: PageRef, cssX: number, cssY: number) {
    const d = this.active;
    const sig = this.placing;
    if (!d || !sig) return;
    const size = displaySize(this.sources, ref);
    let w = Math.min(200, size.width * 0.3);
    let hgt = (w * sig.height) / sig.width;
    if (hgt > 80) {
      w = (w * 80) / hgt;
      hgt = 80;
    }
    const W = w * this.scale, H = hgt * this.scale;
    const L = cssX - W / 2, T = cssY - H / 2;
    const vp = viewportFor(this.sources, ref, this.scale);
    const [x, y] = vp.convertToPdfPoint(L, T + H);
    const stamp: Stamp = { id: uid("s"), imageId: sig.id, x, y, width: w, height: hgt, rotation: totalRotation(this.sources, ref) };
    this.stopPlacing();
    this.commit(d, d.pages.map((p) => (p.id === ref.id ? { ...p, stamps: [...p.stamps, stamp] } : p)));
    this.selectedStamp = stamp.id;
    this.renderStampsFor(ref.id);
  }

  private deleteStamp(stampId: string) {
    const d = this.active;
    if (!d) return;
    this.selectedStamp = null;
    this.commit(d, d.pages.map((p) => (p.stamps.some((s) => s.id === stampId) ? { ...p, stamps: p.stamps.filter((s) => s.id !== stampId) } : p)));
  }

  // ================================================================ zoom

  private fitScale(): number {
    const d = this.active;
    if (!d || !d.pages.length) return 1;
    const avail = Math.max(200, this.viewer.clientWidth - 48);
    const widest = Math.max(...d.pages.map((p) => displaySize(this.sources, p).width));
    // Images aren't enlarged beyond their own pixel size; documents stop at 175%.
    const ppp = d.pages.map((p) => this.sources.get(p.sourceId).original?.pointsPerPixel[p.index]);
    const max = ppp.every((k) => k) ? 1 / Math.max(...(ppp as number[])) : 1.75;
    return Math.min(avail / widest, max);
  }

  setZoom(z: number | "fit") {
    const d = this.active;
    if (!d) return;
    if (d.kind === "model") {
      if (z === "fit") this.modelViewer?.resetView();
      return;
    }
    if (d.kind === "markdown") {
      d.zoom = z === "fit" ? "fit" : Math.min(4, Math.max(0.3, z));
      this.layoutMarkdown();
      return;
    }
    // Keep the current page in place while zooming.
    const anchorId = this.currentPageId;
    const anchorEl = anchorId ? this.pageEls.get(anchorId)?.el : null;
    const offset = anchorEl ? (this.viewer.scrollTop - anchorEl.offsetTop) / Math.max(1, anchorEl.offsetHeight) : 0;
    d.zoom = z === "fit" ? "fit" : Math.min(6, Math.max(0.2, z));
    this.layoutViewer();
    if (anchorEl) this.viewer.scrollTop = anchorEl.offsetTop + offset * anchorEl.offsetHeight;
  }

  zoomBy(f: number) {
    if (!this.active) return;
    if (this.active.kind === "model") return this.modelViewer?.zoom(f);
    if (this.active.kind === "markdown") return this.setZoom(this.mdScale * f);
    this.setZoom(this.scale * f);
  }

  // ================================================================ search

  private clearSearch(rerender = true) {
    this.search = { query: "", hits: [], cur: -1, running: this.search.running + 1 };
    this.searchInfo.textContent = "";
    if (rerender) for (const pe of this.pageEls.values()) this.highlightText(pe.text);
  }

  private async runSearch(dir: 1 | -1) {
    const d = this.active;
    const q = this.searchInput.value.trim().toLowerCase();
    if (!d || !q) return;
    if (q !== this.search.query) {
      const token = ++this.search.running;
      this.searchInfo.textContent = "…";
      const hits: string[] = [];
      for (const p of d.pages) {
        const text = (await this.sources.get(p.sourceId).text(p.index)).toLowerCase().replace(/\s+/g, " ");
        if (token !== this.search.running) return;
        if (text.includes(q)) hits.push(p.id);
      }
      this.search = { query: q, hits, cur: -1, running: token };
      for (const pe of this.pageEls.values()) this.highlightText(pe.text);
    }
    const { hits } = this.search;
    if (!hits.length) {
      this.searchInfo.textContent = "No matches";
      return;
    }
    // Start from the page currently in view.
    if (this.search.cur === -1) {
      const curIdx = d.pages.findIndex((p) => p.id === this.currentPageId);
      const ahead = hits.findIndex((id) => d.pages.findIndex((p) => p.id === id) >= curIdx);
      this.search.cur = dir === 1 ? (ahead === -1 ? 0 : ahead) : (ahead <= 0 ? hits.length - 1 : ahead - 1);
    } else {
      this.search.cur = (this.search.cur + dir + hits.length) % hits.length;
    }
    this.searchInfo.textContent = `${this.search.cur + 1} of ${hits.length} pages`;
    this.scrollToPage(hits[this.search.cur]);
  }

  private highlightText(layer: HTMLElement) {
    const q = this.search.query;
    for (const span of layer.querySelectorAll("span")) {
      const t = span.textContent?.toLowerCase() ?? "";
      span.classList.toggle("hit", !!q && t.length > 0 && (t.includes(q) || (q.includes(t.trim()) && t.trim().length > 2)));
    }
  }

  // ================================================================ rendering

  private render(full = false) {
    const d = this.active;
    this.root.classList.toggle("has-doc", !!d);
    this.root.classList.toggle("model-doc", d?.kind === "model");
    this.root.classList.toggle("md-doc", d?.kind === "markdown");
    this.root.classList.toggle("markup-on", d?.kind === "pages" && d.markup);
    this.renderMarkupBar();
    this.renderTabs();
    this.renderToolbarState();
    this.renderStatus();
    this.renderTitle();
    if (!d || d.kind !== "pages") {
      if (d?.kind === "model") void this.showModel(d);
      if (d?.kind === "markdown") void this.showMarkdown(d);
      this.library.render();
      for (const pe of this.pageEls.values()) this.pageObserver.unobserve(pe.el);
      this.pageEls.clear();
      this.pagesHost.replaceChildren();
      this.thumbEls.clear();
      this.sidebar.replaceChildren();
      return;
    }
    if (full) {
      for (const pe of this.pageEls.values()) this.pageObserver.unobserve(pe.el);
      this.pageEls.clear();
      this.pagesHost.replaceChildren();
      for (const t of this.thumbEls.values()) this.thumbObserver.unobserve(t.el);
      this.thumbEls.clear();
      this.sidebar.replaceChildren();
    }
    this.renderSidebar();
    this.layoutViewer();
  }

  private async ensureModelViewer(): Promise<ModelViewer | null> {
    if (this.modelViewer) return this.modelViewer;
    this.modelViewerLoading ??= createModelViewer(this.modelHost)
      .then((v) => (this.modelViewer = v))
      .catch((e) => {
        this.modelViewerLoading = null;
        this.modelHost.replaceChildren(h("p", { class: "model-error" }, `3D viewing isn't available here: ${e?.message ?? e}`));
        return null;
      });
    return this.modelViewerLoading;
  }

  private modelShown: Doc | null = null;
  private async showModel(d: Doc) {
    const viewer = await this.ensureModelViewer();
    if (!viewer || this.active !== d || !d.model || this.modelShown === d) return;
    this.modelShown = d;
    viewer.show(d.model, d.view3d);
  }

  private renderTitle() {
    const d = this.active;
    (window as any).__unacroDirty = this.docs.some(isDirty);
    if (!d) return this.platform.setTitle("Library — Unacro");
    const where = d.path ? this.platform.displayPath(d.path) : "not saved yet";
    this.platform.setTitle(`${isDirty(d) ? "● " : ""}${d.name} — ${where}`);
  }

  private renderToolbarState() {
    const d = this.active;
    const pages = d?.kind === "pages";
    for (const k of ["save", "insert", "rotl", "rotr", "delete", "sign", "md", "markup", "convert"]) this.buttons[k].disabled = !pages;
    if (d?.kind === "markdown") this.buttons.convert.disabled = this.converting;
    this.buttons.markup.classList.toggle("active", !!(pages && d?.markup));
    this.buttons.markup.setAttribute("aria-pressed", String(!!(pages && d?.markup)));
    for (const k of ["zoomin", "zoomout"]) this.buttons[k].disabled = !d;
    this.buttons.undo.disabled = !d?.undo.length;
    this.buttons.redo.disabled = !d?.redo.length;
    this.buttons.delete.disabled = !d?.selection.size;
    this.searchInput.disabled = !pages;
    const zl = this.toolbar.querySelector(".zoom-value");
    if (zl) zl.textContent = !d ? "–" : d.kind === "model" || d.zoom === "fit" ? "Fit" : `${Math.round((d.kind === "markdown" ? this.mdScale : this.scale) * 100)}%`;
  }

  private renderTabs() {
    // Pinned tabs first.
    const ordered = [...this.docs.filter((d) => d.pinned), ...this.docs.filter((d) => !d.pinned)];
    const libraryTab = h(
      "div",
      {
        class: `tab library-tab${this.active ? "" : " active"}`,
        role: "tab",
        "aria-selected": String(!this.active),
        title: `Library: every file you've opened (${SHIFT}${MOD}H)`,
        onmousedown: (e: MouseEvent) => e.button === 0 && this.showLibrary(),
      },
      icon("library"),
      h("span", { class: "tab-name" }, "Library"),
    );
    const items = ordered.map((d) => {
      const dirty = isDirty(d);
      const tab = h(
        "div",
        {
          class: `tab${d === this.active ? " active" : ""}${dirty ? " dirty" : ""}${d.pinned ? " pinned" : ""}`,
          role: "tab",
          "aria-selected": String(d === this.active),
          title: d.path ? this.platform.displayPath(d.path) : `${d.name} (not saved yet)`,
          dataset: { doc: d.id },
          onmousedown: (e: MouseEvent) => {
            if (e.button === 1) {
              e.preventDefault();
              void this.closeDoc(d);
            } else if (e.button === 0 && d !== this.active) this.activate(d);
          },
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            this.showTabMenu(d, e.clientX, e.clientY);
          },
        },
        d.pinned ? h("span", { class: "tab-pin", title: "Pinned: never closed automatically" }, icon("pin")) : null,
        h("span", { class: "tab-name" }, d.name),
        h("span", { class: "tab-dot", "aria-label": dirty ? "Unsaved changes" : undefined }),
        h("button", {
          class: "tab-close",
          title: `Close (${MOD}W)`,
          "aria-label": `Close ${d.name}`,
          onmousedown: (e: MouseEvent) => e.stopPropagation(),
          onclick: () => void this.closeDoc(d),
        }, icon("x")),
      );
      return tab;
    });
    const listBtn = this.docs.length > 1
      ? h("button", { class: "tab-list", title: "All open documents", "aria-label": "All open documents", onclick: (e: MouseEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(
            [
              ...[...this.docs].sort((a, b) => b.lastActive - a.lastActive).map((d) => ({ label: `${isDirty(d) ? "● " : ""}${d.pinned ? "📌 " : ""}${d.name}`, action: () => this.activate(d) })),
              { separator: true, label: "" },
              { label: "Go to File…", shortcut: `${MOD}P`, action: () => this.quickSwitch() },
            ],
            r.left - 200,
            r.bottom + 4,
          );
        } }, icon("chevron"))
      : null;
    // The Library tab stays put at the left; only the document tabs scroll.
    const strip = h("div", { class: "tab-strip" }, ...items);
    this.tabs.replaceChildren(libraryTab, strip, ...(listBtn ? [listBtn] : []));
    const activeTab = strip.querySelector(".tab.active");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderStatus() {
    const d = this.active;
    if (!d) {
      const n = this.history.size;
      this.status.replaceChildren(
        h("span", { class: "muted" }, `Library: ${n} file${n === 1 ? "" : "s"}`),
        h("span", { class: "spacer" }),
        h("span", { class: "muted" }, `${this.docs.length} open · ${MOD}P to go to any file`),
      );
      return;
    }
    const idx = d.pages.findIndex((p) => p.id === this.currentPageId);
    const pathEl = d.path
      ? h("button", {
          class: "path",
          title: this.platform.canReveal ? "Open containing folder" : this.platform.displayPath(d.path),
          onclick: () => this.platform.canReveal && this.revealDoc(d),
        }, this.platform.canReveal ? icon("folder") : null, h("span", { class: "path-text" }, h("bdi", {}, this.platform.displayPath(d.path))))
      : h("span", { class: "path muted" }, "No file location yet. Save will ask where.");
    const parts: Node[] = [pathEl];
    if (d.path && !d.path.startsWith("download:")) {
      parts.push(h("button", { class: "copy-path", title: "Copy path", "aria-label": "Copy path", onclick: () => this.copyPath(d.path!) }, icon("copy")));
    }
    parts.push(h("span", { class: "spacer" }));
    if (d.kind === "markdown") {
      const c = d.mdImages;
      if (c?.missing) parts.push(h("span", { class: "warn" }, `${c.missing} missing image${c.missing === 1 ? "" : "s"}`));
      if (c?.remote && !d.md?.remoteAllowed) parts.push(h("span", {}, `${c.remote} web image${c.remote === 1 ? "" : "s"} not loaded`));
      if (c?.unsupported) parts.push(h("span", {}, `${c.unsupported} image${c.unsupported === 1 ? "" : "s"} not shown`));
      parts.push(h("span", { class: "muted", title: "Unacro shows Markdown read-only and updates it when the file changes. Convert → PDF makes a PDF on this paper size." }, this.paperLabel()));
      this.status.replaceChildren(...parts);
      return;
    }
    if (d.kind === "model" && d.model) {
      const { size, triangles } = d.model.info;
      const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
      parts.push(
        h("span", { title: "Bounding box in the file's units (usually millimetres)" }, `${size.map(fmt).join(" × ")}`),
        h("span", {}, `${triangles.toLocaleString()} triangles`),
        h("span", { class: "muted" }, "Drag to rotate · right-drag to pan · scroll to zoom"),
      );
      this.status.replaceChildren(...parts);
      return;
    }
    if (d.selection.size > 1) parts.push(h("span", {}, `${d.selection.size} pages selected`));
    parts.push(h("span", { class: "page-pos" }, `Page ${idx + 1 || 1} of ${d.pages.length}`));
    this.status.replaceChildren(...parts);
  }

  // ------------------------------------------------------------ sidebar

  private renderSidebar() {
    const d = this.active!;
    const keep = new Set<string>();
    const els: HTMLElement[] = [];
    d.pages.forEach((ref, i) => {
      const key = `${ref.sourceId}:${ref.index}:${ref.rotation}:${JSON.stringify(ref.crop ?? null)}`;
      let t = this.thumbEls.get(ref.id);
      if (!t || t.key !== key) {
        if (t) this.thumbObserver.unobserve(t.el);
        const canvas = h("canvas", { class: "thumb-canvas" });
        const el = h("div", { class: "thumb", dataset: { id: ref.id } }, h("div", { class: "thumb-frame" }, h("div", { class: "thumb-content" }, canvas)), h("div", { class: "thumb-num" }));
        el.addEventListener("pointerdown", (e) => this.onThumbPointerDown(e, ref.id));
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (!d.selection.has(ref.id)) this.selectPage(d, ref.id, { shiftKey: false, metaKey: false, ctrlKey: false });
          this.showPagesMenu(e.clientX, e.clientY);
        });
        t = { el, canvas, key, rendered: null };
        this.thumbEls.set(ref.id, t);
        this.thumbObserver.observe(el);
      }
      const size = displaySize(this.sources, ref);
      const s = Math.min(THUMB_W / size.width, THUMB_H / size.height);
      const frame = t.el.firstElementChild as HTMLElement;
      frame.style.width = `${Math.round(size.width * s)}px`;
      frame.style.height = `${Math.round(size.height * s)}px`;
      this.placeContent(ref, frame.firstElementChild as HTMLElement, s);
      (t.el.lastElementChild as HTMLElement).textContent = String(i + 1);
      this.renderThumbMarks(ref);
      keep.add(ref.id);
      els.push(t.el);
    });
    for (const [id, t] of this.thumbEls) {
      if (!keep.has(id)) {
        this.thumbObserver.unobserve(t.el);
        this.thumbEls.delete(id);
      }
    }
    // Reorder DOM only where needed.
    els.forEach((el, i) => {
      if (this.sidebar.children[i] !== el) this.sidebar.insertBefore(el, this.sidebar.children[i] ?? null);
    });
    while (this.sidebar.children.length > els.length) this.sidebar.lastElementChild!.remove();
    this.renderSelection();
  }

  private renderSelection() {
    const d = this.active;
    if (!d) return;
    for (const [id, t] of this.thumbEls) {
      t.el.classList.toggle("selected", d.selection.has(id));
      t.el.classList.toggle("current", id === this.currentPageId);
    }
    this.renderToolbarState();
    this.renderStatus();
  }

  private onThumbsVisible(entries: IntersectionObserverEntry[]) {
    const d = this.active;
    if (!d) return;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = (e.target as HTMLElement).dataset.id!;
      const t = this.thumbEls.get(id);
      const ref = d.pages.find((p) => p.id === id);
      if (!t || !ref || t.rendered === t.key) continue;
      const size = displaySize(this.sources, ref);
      const s = Math.min(THUMB_W / size.width, THUMB_H / size.height);
      t.rendered = t.key;
      void renderInto(this.sources, ref, s, t.canvas, () => this.thumbEls.get(id) === t).catch(() => (t.rendered = null));
    }
  }

  // ------------------------------------------------------------ viewer

  private layoutViewer() {
    const d = this.active;
    if (!d) return;
    this.scale = d.zoom === "fit" ? this.fitScale() : d.zoom;
    const keep = new Set<string>();
    const els: HTMLElement[] = [];
    for (const ref of d.pages) {
      const key = `${ref.sourceId}:${ref.index}:${ref.rotation}:${this.scale.toFixed(4)}:${JSON.stringify(ref.crop ?? null)}`;
      let pe = this.pageEls.get(ref.id);
      if (!pe) {
        const canvas = h("canvas", { class: "page-canvas" });
        const text = h("div", { class: "textLayer" });
        const stamps = h("div", { class: "stamps" });
        const marks = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
        marks.classList.add("marks");
        const content = h("div", { class: "page-content" }, canvas, text, marks, stamps);
        const el = h("div", { class: "page", dataset: { id: ref.id } }, content);
        el.addEventListener("pointerdown", (e) => this.onPagePointerDown(e, ref.id));
        el.addEventListener("dblclick", (e) => this.onPageDoubleClick(e, ref.id));
        pe = { el, canvas, text, stamps, marks, content, key: "", rendered: null, visible: false };
        this.pageEls.set(ref.id, pe);
        this.pageObserver.observe(el);
      }
      if (pe.key !== key) {
        pe.key = key;
        const size = displaySize(this.sources, ref);
        pe.el.style.width = `${Math.floor(size.width * this.scale)}px`;
        pe.el.style.height = `${Math.floor(size.height * this.scale)}px`;
        this.placeContent(ref, pe.content, this.scale);
        if (pe.visible) void this.renderPage(ref.id);
      }
      keep.add(ref.id);
      els.push(pe.el);
    }
    for (const [id, pe] of this.pageEls) {
      if (!keep.has(id)) {
        this.pageObserver.unobserve(pe.el);
        this.pageEls.delete(id);
      }
    }
    els.forEach((el, i) => {
      if (this.pagesHost.children[i] !== el) this.pagesHost.insertBefore(el, this.pagesHost.children[i] ?? null);
    });
    while (this.pagesHost.children.length > els.length) this.pagesHost.lastElementChild!.remove();
    this.pagesHost.style.gap = `${PAGE_GAP}px`;
    for (const ref of d.pages) this.renderStampsFor(ref.id);
    this.renderToolbarState();
    if (!this.currentPageId || !keep.has(this.currentPageId)) {
      this.currentPageId = d.pages[0]?.id ?? null;
    }
    this.onViewerScroll();
  }

  /** Size the full-page layer and shift it so only the cropped window shows. */
  private placeContent(ref: PageRef, content: HTMLElement, scale: number) {
    const full = viewportFor(this.sources, ref, scale);
    const win = cropWindow(this.sources, ref, scale);
    content.style.width = `${full.width}px`;
    content.style.height = `${full.height}px`;
    content.style.left = `${-(win?.left ?? 0)}px`;
    content.style.top = `${-(win?.top ?? 0)}px`;
  }

  private onPagesVisible(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.id!;
      const pe = this.pageEls.get(id);
      if (!pe) continue;
      pe.visible = e.isIntersecting;
      if (e.isIntersecting) void this.renderPage(id);
      else if (pe.rendered) {
        // Free memory for pages far off screen.
        pe.canvas.width = 0;
        pe.canvas.height = 0;
        pe.text.replaceChildren();
        pe.rendered = null;
      }
    }
  }

  private async renderPage(id: string) {
    const d = this.active;
    const pe = this.pageEls.get(id);
    const ref = d?.pages.find((p) => p.id === id);
    if (!d || !pe || !ref || pe.rendered === pe.key) return;
    const key = pe.key;
    pe.rendered = key;
    const scale = this.scale;
    try {
      await renderInto(this.sources, ref, scale, pe.canvas, () => pe.key === key && this.pageEls.get(id) === pe);
      if (pe.key !== key) return;
      pe.canvas.style.width = "100%";
      pe.canvas.style.height = "100%";
      await renderTextLayer(this.sources, ref, scale, pe.text);
      this.highlightText(pe.text);
    } catch (e) {
      console.error(e);
      if (pe.rendered === key) pe.rendered = null;
    }
  }

  private onViewerScroll() {
    const d = this.active;
    if (!d) return;
    const mid = this.viewer.scrollTop + this.viewer.clientHeight * 0.35;
    let current: string | null = null;
    for (const ref of d.pages) {
      const pe = this.pageEls.get(ref.id);
      if (!pe) continue;
      if (pe.el.offsetTop <= mid) current = ref.id;
      else break;
    }
    current ??= d.pages[0]?.id ?? null;
    if (current !== this.currentPageId) {
      this.currentPageId = current;
      this.renderSelection();
      const t = current ? this.thumbEls.get(current) : null;
      t?.el.scrollIntoView({ block: "nearest" });
    }
  }

  private scrollToPage(id: string) {
    const pe = this.pageEls.get(id);
    if (!pe) return;
    this.viewer.scrollTo({ top: pe.el.offsetTop - 12 });
  }

  // ------------------------------------------------------------ stamps on pages

  private renderStampsFor(pageId: string) {
    const d = this.active;
    const pe = this.pageEls.get(pageId);
    const ref = d?.pages.find((p) => p.id === pageId);
    if (!d || !pe || !ref) return;
    const vp = viewportFor(this.sources, ref, this.scale);
    const R = totalRotation(this.sources, ref);
    const nodes = ref.stamps.map((s) => {
      const t = (s.rotation * Math.PI) / 180;
      const [L, T] = vp.convertToViewportPoint(s.x - s.height * Math.sin(t), s.y + s.height * Math.cos(t));
      const d2 = (R - s.rotation + 360) % 360;
      const editable = d2 === 0;
      const img = h("img", { src: this.imageUrl(s.imageId), alt: "Signature", draggable: "false" });
      const el = h(
        "div",
        {
          class: `stamp${this.selectedStamp === s.id ? " selected" : ""}${editable ? "" : " locked"}`,
          dataset: { stamp: s.id },
          style: {
            left: `${L}px`,
            top: `${T}px`,
            width: `${s.width * this.scale}px`,
            height: `${s.height * this.scale}px`,
            transform: d2 ? `rotate(${d2}deg)` : "",
          },
        },
        img,
      );
      if (this.selectedStamp === s.id) {
        el.append(
          h("button", { class: "stamp-delete", title: "Remove (Delete)", "aria-label": "Remove signature", onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: () => this.deleteStamp(s.id) }, icon("x")),
        );
        if (editable) el.append(h("div", { class: "stamp-resize", title: "Drag to resize" }));
      }
      el.addEventListener("pointerdown", (e) => this.onStampPointerDown(e, ref, s, editable));
      return el;
    });
    pe.stamps.replaceChildren(...nodes);
    this.renderMarksFor(pageId);
  }

  private imageUrls = new Map<string, string>();
  private imageUrl(id: string) {
    let u = this.imageUrls.get(id);
    if (!u) {
      const bytes = this.images.get(id);
      u = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })) : "";
      this.imageUrls.set(id, u);
    }
    return u;
  }

  private onStampPointerDown(e: PointerEvent, ref: PageRef, s: Stamp, editable: boolean) {
    if (this.placing || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const d = this.active!;
    if (this.selectedMark) this.selectMark(null);
    if (this.selectedStamp !== s.id) {
      this.selectedStamp = s.id;
      this.renderStampsFor(ref.id);
    }
    if (!editable) return;
    const el = this.pageEls.get(ref.id)!.stamps.querySelector<HTMLElement>(`[data-stamp="${s.id}"]`)!;
    const resizing = (e.target as HTMLElement).classList.contains("stamp-resize");
    const startX = e.clientX, startY = e.clientY;
    const L0 = parseFloat(el.style.left), T0 = parseFloat(el.style.top);
    const W0 = parseFloat(el.style.width), H0 = parseFloat(el.style.height);
    let L = L0, T = T0, W = W0, H = H0;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (resizing) {
        W = Math.max(20, W0 + dx);
        H = (W * H0) / W0;
      } else {
        L = L0 + dx;
        T = T0 + dy;
      }
      Object.assign(el.style, { left: `${L}px`, top: `${T}px`, width: `${W}px`, height: `${H}px` });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (!moved) return;
      const vp = viewportFor(this.sources, ref, this.scale);
      const [x, y] = vp.convertToPdfPoint(L, T + H);
      const next: Stamp = { ...s, x, y, width: W / this.scale, height: H / this.scale };
      this.commit(d, d.pages.map((p) => (p.id === ref.id ? { ...p, stamps: p.stamps.map((st) => (st.id === s.id ? next : st)) } : p)));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  private onPagePointerDown(e: PointerEvent, pageId: string) {
    const d = this.active;
    const ref = d?.pages.find((p) => p.id === pageId);
    if (!d || !ref) return;
    if (this.placing && e.button === 0) {
      e.preventDefault();
      this.placeAt(ref, ...this.pointIn(e, ref.id));
      return;
    }
    if (e.button === 0 && this.tool === "crop" && d.markup) {
      e.preventDefault();
      this.cropPointer(e, ref);
      return;
    }
    if (this.editing) {
      // Clicking anywhere else finishes typing (and does nothing else).
      if (!(e.target as Element).closest(".callout-editor")) this.finishEditing();
      return;
    }
    if (e.button === 0 && this.tool === "callout" && d.markup) {
      e.preventDefault();
      this.createCallout(e, ref);
      return;
    }
    if (e.button === 0 && this.tool !== "select" && d.markup) {
      e.preventDefault();
      this.drawMark(e, ref);
      return;
    }
    const target = e.target as Element;
    const markId = target.closest<SVGElement>("[data-mark]")?.dataset.mark;
    if (e.button === 0 && markId) {
      e.preventDefault();
      // Pressing again on a callout just after a plain click on it is a double-click: edit its text.
      const last = this.lastMarkClick;
      const mark = ref.marks.find((m) => m.id === markId);
      if (mark?.type === "callout" && last?.id === markId && performance.now() - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) {
        this.lastMarkClick = null;
        this.startEditing(ref.id, mark, false);
        return;
      }
      const handle = target.closest<SVGElement>("[data-handle]")?.dataset.handle;
      this.dragMark(e, ref, markId, handle === undefined ? null : Number(handle));
      return;
    }
    if (this.selectedMark) this.selectMark(null);
    if (this.selectedStamp) {
      const prev = d.pages.find((p) => p.stamps.some((s) => s.id === this.selectedStamp));
      this.selectedStamp = null;
      if (prev) this.renderStampsFor(prev.id);
    }
  }

  // ------------------------------------------------------------ sidebar drag & drop

  private onThumbPointerDown(e: PointerEvent, id: string) {
    const d = this.active;
    if (!d || e.button !== 0) return;
    this.sidebar.focus({ preventScroll: true });
    const additive = e.shiftKey || (isMac() ? e.metaKey : e.ctrlKey);
    const wasSelected = d.selection.has(id);
    if (!wasSelected || additive) this.selectPage(d, id, e);
    this.scrollToPage(id);

    const startY = e.clientY, startX = e.clientX;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    const marker = h("div", { class: "drop-marker" });
    let dropIndex = -1;
    let dropTab: Doc | null = null;
    let scrollTimer = 0;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < 6) return;
        dragging = true;
        if (!d.selection.has(id)) this.selectPage(d, id, { shiftKey: false, metaKey: false, ctrlKey: false });
        const n = d.selection.size;
        ghost = h("div", { class: "drag-ghost" }, `${n} page${n === 1 ? "" : "s"}`);
        document.body.append(ghost);
        this.root.classList.add("dragging-pages");
      }
      ghost!.style.left = `${ev.clientX + 12}px`;
      ghost!.style.top = `${ev.clientY + 8}px`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const tabEl = over?.closest<HTMLElement>(".tab");
      this.tabs.querySelectorAll(".tab.drop-target").forEach((t) => t.classList.remove("drop-target"));
      dropTab = null;
      if (tabEl && tabEl.dataset.doc !== d.id && this.docs.find((x) => x.id === tabEl.dataset.doc)?.kind === "pages") {
        dropTab = this.docs.find((x) => x.id === tabEl.dataset.doc) ?? null;
        tabEl.classList.add("drop-target");
        marker.remove();
        dropIndex = -1;
        return;
      }
      const sb = this.sidebar.getBoundingClientRect();
      if (ev.clientX < sb.left || ev.clientX > sb.right) {
        marker.remove();
        dropIndex = -1;
        return;
      }
      dropIndex = this.sidebarIndexAt(ev.clientY);
      const ref = this.sidebar.children[dropIndex] as HTMLElement | undefined;
      if (ref) this.sidebar.insertBefore(marker, ref);
      else this.sidebar.append(marker);
      // Auto-scroll near the edges.
      clearInterval(scrollTimer);
      const edge = 40;
      const dir = ev.clientY < sb.top + edge ? -1 : ev.clientY > sb.bottom - edge ? 1 : 0;
      if (dir) scrollTimer = window.setInterval(() => (this.sidebar.scrollTop += dir * 12), 16);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      clearInterval(scrollTimer);
      marker.remove();
      ghost?.remove();
      this.root.classList.remove("dragging-pages");
      this.tabs.querySelectorAll(".tab.drop-target").forEach((t) => t.classList.remove("drop-target"));
      if (!dragging) {
        if (wasSelected && !additive) this.selectPage(d, id, { shiftKey: false, metaKey: false, ctrlKey: false });
        return;
      }
      if (dropTab) {
        const pages = clonePages(d.pages.filter((p) => d.selection.has(p.id)));
        const target = dropTab;
        target.undo.push(target.pages);
        target.redo = [];
        target.pages = [...target.pages, ...pages];
        this.render();
        toast(`Copied ${pages.length} page${pages.length === 1 ? "" : "s"} to the end of ${target.name}`);
        return;
      }
      if (dropIndex >= 0) {
        const next = movePages(d.pages, d.selection, dropIndex);
        if (next.some((p, i) => p !== d.pages[i])) this.commit(d, next);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Index (in the page list) where something dropped at clientY should go. */
  private sidebarIndexAt(clientY: number): number {
    const thumbs = [...this.sidebar.querySelectorAll<HTMLElement>(".thumb")];
    for (let i = 0; i < thumbs.length; i++) {
      const r = thumbs[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return thumbs.length;
  }

  private async onFileDrop(getFiles: () => Promise<OpenedFile[]>, x: number, y: number) {
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    const intoSidebar = this.active?.kind === "pages" && !!target?.closest(".sidebar");
    const at = intoSidebar ? this.sidebarIndexAt(y) : 0;
    const files = await getFiles();
    if (!files.length) return toast("Unacro opens PDFs, images (JPEG, PNG, GIF, HEIC, TIFF, BMP), Markdown files and STL models.", "error");
    if (intoSidebar && this.active) await this.insertFiles(this.active, files, at);
    else await this.openFiles(files);
  }

  // ================================================================ menus

  private showFileMenu(anchor: HTMLElement) {
    const d = this.active;
    const pages = d?.kind === "pages";
    const r = anchor.getBoundingClientRect();
    const recent = this.history.list().sort((a, b) => b.last - a.last).slice(0, 15);
    const items: MenuItem[] = [
      { label: "New from Clipboard", shortcut: `${MOD}N`, action: () => void this.newFromClipboard() },
      { label: "Open…", shortcut: `${MOD}O`, action: () => void this.openDialog() },
      {
        label: "Open Recent",
        disabled: !recent.length,
        submenu: [
          ...recent.map((e) => ({ label: e.path, action: () => void this.openPath(e.path) })),
          { separator: true, label: "" },
          { label: "Show Library", shortcut: `${SHIFT}${MOD}H`, action: () => this.showLibrary() },
        ],
      },
      { label: "Go to File…", shortcut: `${MOD}P`, action: () => this.quickSwitch() },
      { label: "Combine Files into New PDF…", action: () => void this.combineFromFiles() },
      { label: "Combine All Open Tabs", disabled: this.docs.filter((x) => x.kind !== "model").length < 2, action: () => void this.combineOpenTabs() },
      { separator: true, label: "" },
      { label: "Save", shortcut: `${MOD}S`, disabled: !pages, action: () => void this.save() },
      { label: "Save As…", shortcut: `${SHIFT}${MOD}S`, disabled: !pages, action: () => void this.saveAs() },
      { label: "Save a Copy…", disabled: !pages, action: () => void this.saveCopy() },
      ...(d?.imageFormat ? [{ label: "Export as PDF…", action: () => void this.saveCopy(d, true) }] : []),
      ...(d?.kind === "markdown" ? [{ label: "Export as PDF…", disabled: this.converting, action: () => void this.exportMarkdownPdf(d) }] : []),
      { label: "Convert", disabled: !pages && d?.kind !== "markdown", submenu: this.convertMenuItems() },
      { separator: true, label: "" },
      { label: "Export as Markdown…", disabled: !pages || !!d?.imageFormat, action: () => void this.exportMarkdown() },
      { separator: true, label: "" },
      ...(this.platform.canReveal ? [{ label: "Open Containing Folder", disabled: !d?.path, action: () => d && this.revealDoc(d) }] : []),
      { label: "Copy Path", disabled: !d?.path, action: () => d?.path && this.copyPath(d.path) },
      { label: "Close", shortcut: `${MOD}W`, disabled: !d, action: () => d && void this.closeDoc(d) },
      { label: "Close All", shortcut: `${ALT}${MOD}W`, disabled: !this.docs.length, action: () => void this.closeAll() },
      { separator: true, label: "" },
      { label: "Settings…", shortcut: `${MOD},`, action: () => void this.settingsDialog() },
    ];
    openMenu(items, r.left, r.bottom + 4);
  }

  private showMarkdownMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    openMenu(
      [
        { label: "Export as Markdown…", action: () => void this.exportMarkdown() },
        { label: "Copy as Markdown", action: () => void this.copyMarkdown() },
      ],
      r.left,
      r.bottom + 4,
    );
  }

  /** "Saved" toast with a button that opens the file's folder in the system file manager. */
  private savedToast(message: string, path: string) {
    const real = this.platform.canReveal && !path.startsWith("download:") && !path.startsWith("handle:");
    if (!real) return toast(message);
    const shown = this.platform.displayPath(path);
    const i = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
    const label = isMac() ? "Show in Finder" : /Windows/.test(navigator.userAgent) ? "Show in Explorer" : "Open Folder";
    toast(message, "info", {
      detail: i > 0 ? shown.slice(0, i) : shown,
      actions: [
        { label, run: () => this.platform.reveal(path).catch((e: any) => toast(`Couldn't open the folder: ${e?.message ?? e}`, "error")) },
        { label: "Copy Path", run: () => this.copyPath(path) },
      ],
    });
  }

  private copyPath(path: string) {
    this.platform.writeClipboardText(this.platform.displayPath(path)).then(
      () => toast("Path copied"),
      (e) => toast(`Couldn't copy: ${e?.message ?? e}`, "error"),
    );
  }

  /** Open the file manager on the folder that holds the document, with the file selected. */
  private revealDoc(d: Doc) {
    if (!d.path) return;
    this.platform.reveal(d.path).catch((e: any) => toast(`Couldn't open the folder: ${e?.message ?? e}`, "error"));
  }

  private showTabMenu(d: Doc, x: number, y: number) {
    openMenu(
      [
        ...(this.platform.canReveal
          ? [{ label: d.path ? "Open Containing Folder" : "Open Containing Folder (not saved yet)", disabled: !d.path, action: () => this.revealDoc(d) }]
          : []),
        { label: "Copy Path", disabled: !d.path, action: () => d.path && this.copyPath(d.path) },
        { separator: true, label: "" },
        { label: d.pinned ? "Unpin Tab" : "Pin Tab", action: () => this.togglePin(d) },
        { separator: true, label: "" },
        { label: "Close", action: () => void this.closeDoc(d) },
        { label: "Close Other Tabs", disabled: this.docs.length < 2, action: () => void this.closeOthers(d) },
        { label: "Close All Tabs", shortcut: `${ALT}${MOD}W`, action: () => void this.closeAll() },
      ],
      x,
      y,
    );
  }

  private showPagesMenu(x: number, y: number) {
    const d = this.active;
    if (!d) return;
    const n = d.selection.size;
    const sel = n > 0;
    openMenu(
      [
        { label: "Rotate Left", shortcut: `${MOD}L`, disabled: !sel, action: () => this.rotateSelected(-90) },
        { label: "Rotate Right", shortcut: `${MOD}R`, disabled: !sel, action: () => this.rotateSelected(90) },
        { separator: true, label: "" },
        { label: "Copy Pages", shortcut: `${MOD}C`, disabled: !sel, action: () => this.copyPages() },
        { label: "Paste Pages", shortcut: `${MOD}V`, disabled: !this.clipboard.length, action: () => this.pastePages() },
        { label: "Insert Pages from PDF…", action: () => void this.insertFromFile() },
        { label: n > 1 ? `Open ${n} Pages as New Document` : "Open Page as New Document", disabled: !sel, action: () => this.extractSelection() },
        { separator: true, label: "" },
        { label: "Remove Crop", disabled: !d.pages.some((p) => d.selection.has(p.id) && p.crop), action: () => this.removeCrop() },
        { separator: true, label: "" },
        { label: n > 1 ? `Delete ${n} Pages` : "Delete Page", shortcut: "Del", disabled: !sel, action: () => this.deleteSelected() },
      ],
      x,
      y,
    );
  }

  // ================================================================ keyboard

  private onSidebarKey(e: KeyboardEvent) {
    const d = this.active;
    if (!d || isModalOpen()) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      d.selection = new Set(d.pages.map((p) => p.id));
      this.renderSelection();
    } else if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this.copyPages();
    } else if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      this.pastePages();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = d.pages.findIndex((p) => p.id === (d.anchor ?? this.currentPageId));
      const j = Math.max(0, Math.min(d.pages.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      const id = d.pages[j].id;
      if (e.shiftKey) {
        d.selection.add(id);
        d.anchor = id;
        this.renderSelection();
      } else this.selectPage(d, id, { shiftKey: false, metaKey: false, ctrlKey: false });
      this.scrollToPage(id);
      this.thumbEls.get(id)?.el.scrollIntoView({ block: "nearest" });
    }
  }

  private onKey(e: KeyboardEvent) {
    if (isModalOpen() || isSwitcherOpen()) return;
    if (this.editing && e.target === this.editing.textarea) {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (e.key === "Escape" || (e.key === "Enter" && mod)) {
        e.preventDefault();
        this.finishEditing();
      }
      return;
    }
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    // With Option held, macOS changes e.key (⌥W types "∑"), so use the physical key for letters.
    const k = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

    if (e.key === "Escape") {
      closeMenus();
      if (this.placing) this.stopPlacing();
      else if (this.cropDraft) this.clearCropDraft();
      else if (this.tool !== "select") this.setTool("select");
      else if (this.selectedMark) this.selectMark(null);
      else if (this.selectedStamp) {
        const id = this.selectedStamp;
        this.selectedStamp = null;
        const p = this.active?.pages.find((pg) => pg.stamps.some((s) => s.id === id));
        if (p) this.renderStampsFor(p.id);
      }
      return;
    }
    if (mod) {
      const act: Record<string, () => void> = {
        o: () => void this.openDialog(),
        p: () => this.quickSwitch(),
        ",": () => void this.settingsDialog(),
        h: () => e.shiftKey && this.toggleLibrary(),
        n: () => void this.newFromClipboard(),
        s: () => void (e.shiftKey ? this.saveAs() : this.save()),
        w: () => (e.altKey ? void this.closeAll() : this.active && void this.closeDoc(this.active)),
        f: () => {
          if (!this.active) return this.library.focusSearch();
          this.searchInput.focus();
          this.searchInput.select();
        },
        z: () => (e.shiftKey ? this.redo() : this.undo()),
        y: () => this.redo(),
        "=": () => this.zoomBy(1.2),
        "+": () => this.zoomBy(1.2),
        "-": () => this.zoomBy(1 / 1.2),
        "0": () => this.setZoom("fit"),
        r: () => this.rotateSelected(e.shiftKey ? -90 : 90),
        l: () => this.rotateSelected(-90),
      };
      if (k === "tab" || e.key === "PageDown" || e.key === "PageUp") {
        if (this.docs.length > 1 && this.active) {
          e.preventDefault();
          const back = e.shiftKey || e.key === "PageUp";
          const i = this.docs.indexOf(this.active);
          this.activate(this.docs[(i + (back ? -1 : 1) + this.docs.length) % this.docs.length]);
        }
        return;
      }
      if (inInput && (k === "z" || k === "y")) return; // let text fields undo themselves
      if (k === "c" && !e.shiftKey && !e.altKey) {
        // The sidebar copies pages itself; selected text copies as text.
        const text = window.getSelection();
        if (e.defaultPrevented || inInput || (text && !text.isCollapsed && text.toString().trim())) return;
        if (this.active?.kind === "pages") {
          e.preventDefault();
          void this.copyImage();
        }
        return;
      }
      const fn = act[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }
    if (inInput) return;
    if (e.key === "Enter" && this.cropDraft) {
      e.preventDefault();
      this.applyCrop();
      return;
    }
    if (this.active?.kind === "pages" && this.active.markup && !e.altKey && !e.shiftKey) {
      const tools: Record<string, Tool> = { v: "select", r: "rect", o: "oval", a: "arrow", t: "callout", c: "crop" };
      if (tools[k]) {
        e.preventDefault();
        this.setTool(tools[k]);
        return;
      }
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedMark) {
        e.preventDefault();
        this.deleteMark(this.selectedMark);
      } else if (this.selectedStamp) {
        e.preventDefault();
        this.deleteStamp(this.selectedStamp);
      } else if (document.activeElement === this.sidebar && this.active?.selection.size) {
        e.preventDefault();
        this.deleteSelected();
      }
    }
  }

  // ================================================================ markdown documents

  private buildMarkdownView() {
    const shadow = this.mdHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `${mdCss}
:host { display: block; }
.scroll { position: absolute; inset: 0; overflow: auto; outline: none; background: var(--viewer); }
.wrap { min-height: 100%; }
.paper { box-sizing: border-box; margin: 24px auto 40px; background: #fff; box-shadow: var(--page-shadow); }
.bar {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 9px 16px; background: var(--chrome); border-bottom: 1px solid var(--line);
  color: var(--text); font: 13px/1.4 var(--font);
}
.bar[hidden] { display: none; }
.bar span { flex: 1 1 280px; }
.bar button {
  font: inherit; padding: 4px 12px; border-radius: var(--radius); cursor: pointer;
  border: 1px solid var(--line); background: var(--menu-bg); color: var(--text);
}
.bar button:hover { border-color: var(--accent); }
`;
    this.mdScroll.prepend(this.mdBar);
    shadow.append(style, this.mdScroll);
    this.mdArticle.addEventListener("click", (e) => this.onMarkdownClick(e));
  }

  /** Links in a Markdown document: web and mail links open in the default app, links to files open in Unacro. */
  private onMarkdownClick(e: MouseEvent) {
    const a = (e.target as Element).closest?.("a");
    if (!a) return;
    e.preventDefault(); // never navigate the app itself
    const href = a.getAttribute("href")?.trim() ?? "";
    if (!href) return;
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = this.mdArticle.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: "start" });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      void this.platform.openUrl(href).catch((err: any) => toast(`Couldn't open the link: ${err?.message ?? err}`, "error"));
      return;
    }
    const d = this.active;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || !d?.path) return;
    let rel = href.split(/[?#]/)[0];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* keep as written */
    }
    const dir = d.path.slice(0, Math.max(d.path.lastIndexOf("/"), d.path.lastIndexOf("\\")));
    const path = rel.startsWith("/") ? rel : joinPath(dir, rel);
    if (ALL_EXTS.includes(extOf(path))) void this.openPath(path);
    else if (this.platform.canReveal) void this.platform.reveal(path).catch(() => toast(`Couldn't find ${path}`, "error"));
  }

  private async openMarkdown(f: OpenedFile): Promise<Doc | null> {
    try {
      const text = new TextDecoder().decode(f.bytes);
      const md = await MdDocument.create(this.readBytes, f.path, text);
      const doc = this.newDoc(f.name, f.path, [], true, {
        kind: "markdown",
        md,
        mdStamp: f.path ? await this.platform.fileStamp(f.path) : null,
      });
      if (f.path) this.history.record(f.path, "markdown", true);
      return doc;
    } catch (e: any) {
      toast(`Couldn't open “${f.name}”: ${e?.message ?? e}`, "error");
      return null;
    }
  }

  private readBytes = async (path: string) => (await this.platform.readPath(path)).bytes;

  /** Show a Markdown document in the view (again, if `force`), keeping its scroll position. */
  private async showMarkdown(d: Doc, force = false) {
    if (!d.md || (this.mdShown === d && !force)) return;
    this.mdShown = d;
    const keep = force ? this.mdScroll.scrollTop : d.scrollTop;
    const frag = await d.md.view();
    if (this.active !== d || this.mdShown !== d) return;
    this.mdArticle.replaceChildren(frag);
    this.layoutMarkdown();
    this.mdScroll.scrollTop = keep;
    d.mdImages = await d.md.counts();
    if (this.active !== d) return;
    this.renderMarkdownBar(d);
    this.renderStatus();
  }

  private renderMarkdownBar(d: Doc) {
    const remote = d.mdImages?.remote ?? 0;
    this.mdBar.hidden = !remote || !!d.md?.remoteAllowed;
    if (this.mdBar.hidden) return this.mdBar.replaceChildren();
    this.mdBar.replaceChildren(
      h(
        "span",
        {},
        `This document has ${remote === 1 ? "an image" : `${remote} images`} from the web. ` +
          "Unacro doesn't load them unless you ask, so nothing is sent anywhere until then.",
      ),
      h("button", { onclick: () => void this.loadRemoteImages(d) }, "Load Remote Images"),
    );
  }

  private async loadRemoteImages(d: Doc) {
    if (!d.md) return;
    d.md.remoteAllowed = true;
    if (this.active === d) await this.showMarkdown(d, true);
  }

  private mdScale = 1;

  private layoutMarkdown() {
    const d = this.active;
    if (d?.kind !== "markdown") return;
    const { width } = PAPER_SIZE[this.paper()];
    const paperW = width * PX_PER_PT;
    const pad = PAGE_MARGIN * PX_PER_PT;
    const avail = this.mdHost.clientWidth - 48;
    this.mdScale = d.zoom === "fit" ? Math.max(0.3, Math.min(1.25, avail / paperW)) : d.zoom;
    this.mdPaper.style.width = `${paperW}px`;
    this.mdPaper.style.padding = `${pad}px`;
    (this.mdPaper.style as any).zoom = String(this.mdScale);
    this.renderToolbarState();
  }

  /** Reload the active Markdown document if its file changed on disk. */
  private checkingMd = false;
  private async checkMarkdownFile() {
    const d = this.active;
    if (d?.kind !== "markdown" || !d.path || !d.md || this.checkingMd || document.hidden) return;
    this.checkingMd = true;
    try {
      const stamp = await this.platform.fileStamp(d.path);
      if (!stamp || stamp === d.mdStamp) return;
      const text = new TextDecoder().decode((await this.platform.readPath(d.path)).bytes);
      d.mdStamp = stamp;
      if (text === d.md.text) return;
      await d.md.update(text);
      if (this.active === d) await this.showMarkdown(d, true);
    } catch {
      /* the file is being saved or was moved; try again next time */
    } finally {
      this.checkingMd = false;
    }
  }

  private paper(): Paper {
    try {
      const p = localStorage.getItem(PAPER_KEY);
      if (p === "a4" || p === "letter") return p;
    } catch {
      /* default */
    }
    return paperForLocale(navigator.language);
  }

  private paperLabel(p = this.paper()) {
    return p === "a4" ? "A4" : "US Letter";
  }

  private setPaper(p: Paper) {
    try {
      localStorage.setItem(PAPER_KEY, p);
    } catch {
      /* this session only */
    }
    this.layoutMarkdown();
    this.renderStatus();
  }

  /** Make a PDF from a Markdown document. */
  private async markdownToPdf(md: MdDocument, name: string): Promise<Uint8Array> {
    if (!this.platform.htmlToPdf) throw new Error("Making PDFs from Markdown needs the Unacro desktop app.");
    const base = name.replace(/\.[^.]+$/, "");
    const paper = this.paper();
    const raw = await this.platform.htmlToPdf(await md.printPage(paper, base), paper);
    // Give the PDF a proper title (the system print sets none or a generic one).
    try {
      const pdf = await PDFDocument.load(raw, { updateMetadata: false });
      pdf.setTitle(md.title ?? base);
      pdf.setCreator("Unacro");
      return await pdf.save();
    } catch {
      return raw;
    }
  }

  /** A Markdown file (being combined or inserted) as PDF bytes. Uses the open tab's settings if it's open. */
  private async markdownFileToPdf(file: OpenedFile): Promise<Uint8Array> {
    const open = file.path ? this.docs.find((d) => d.path === file.path && d.md) : undefined;
    if (open) return this.markdownToPdf(open.md!, open.name);
    const md = await MdDocument.create(this.readBytes, file.path, new TextDecoder().decode(file.bytes));
    try {
      return await this.markdownToPdf(md, file.name);
    } finally {
      md.dispose();
    }
  }

  /** Run a Markdown → PDF conversion with the Convert button disabled and a note about images. */
  private async withConversion<T>(d: Doc, work: () => Promise<T>): Promise<T | null> {
    if (this.converting || !d.md) return null;
    this.converting = true;
    this.renderToolbarState();
    toast("Making the PDF…");
    try {
      return await work();
    } catch (e: any) {
      toast(`Couldn't make the PDF: ${e?.message ?? e}`, "error");
      return null;
    } finally {
      this.converting = false;
      this.renderToolbarState();
    }
  }

  private imageNote(d: Doc): string {
    const c = d.mdImages;
    const notes: string[] = [];
    if (c?.missing) notes.push(`${c.missing} missing image${c.missing === 1 ? " is" : "s are"} shown as placeholders`);
    if (c?.remote && !d.md?.remoteAllowed) notes.push(`${c.remote} web image${c.remote === 1 ? " wasn't" : "s weren't"} loaded`);
    return notes.length ? ` (${notes.join("; ")})` : "";
  }

  /** Convert → PDF: the PDF opens as a new, unsaved tab next to the Markdown file. */
  async convertMarkdown(d: Doc) {
    const bytes = await this.withConversion(d, () => this.markdownToPdf(d.md!, d.name));
    if (!bytes) return;
    try {
      const name = replaceExt(d.name, "pdf");
      const src = await Source.load(name, bytes);
      this.sources.add(src);
      const doc = this.newDoc(name, null, pagesForSource(src.id, src.pageCount), false, { nearPath: d.path });
      this.activate(doc);
      toast(`Made a ${src.pageCount}-page PDF${this.imageNote(d)}. Save to keep it.`);
    } catch (e: any) {
      toast(`Couldn't open the PDF: ${e?.message ?? e}`, "error");
    }
  }

  /** Export as PDF…: ask where, then write the PDF straight there. */
  async exportMarkdownPdf(d: Doc) {
    if (d.kind !== "markdown") return;
    const path = await this.platform.pickSavePath(replaceExt(d.name, "pdf"), "pdf", d.path);
    if (!path) return;
    const bytes = await this.withConversion(d, () => this.markdownToPdf(d.md!, d.name));
    if (!bytes) return;
    try {
      await this.platform.write(path, bytes);
      this.history.record(path, "pdf", false);
      this.savedToast(`Exported ${this.platform.baseName(path)}${this.imageNote(d)}`, path);
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
    }
  }

  // ================================================================ convert

  private jpegQuality(): number {
    try {
      const q = Number(localStorage.getItem(JPEG_QUALITY_KEY));
      if (q >= 0.3 && q <= 1) return q;
    } catch {
      /* default */
    }
    return 0.85;
  }

  private convertMenuItems(): MenuItem[] {
    const d = this.active;
    if (d?.kind === "markdown") {
      const paper = this.paper();
      return [
        { label: "PDF", disabled: this.converting, action: () => void this.convertMarkdown(d) },
        { label: "Export as PDF…", disabled: this.converting, action: () => void this.exportMarkdownPdf(d) },
        { separator: true, label: "" },
        {
          label: `Paper Size (${this.paperLabel(paper)})`,
          submenu: (["a4", "letter"] as Paper[]).map((p) => ({
            label: `${p === paper ? "✓ " : "   "}${this.paperLabel(p)}`,
            action: () => this.setPaper(p),
          })),
        },
      ];
    }
    const many = (d?.pages.length ?? 0) > 1;
    const page = many ? "Current Page as " : "";
    const items: MenuItem[] = (["jpeg", "png", "tiff", "bmp"] as ImageFormat[]).map((f) => ({
      label: `${page}${IMAGE_LABEL[f]}`,
      action: () => void this.convertTo(f),
    }));
    if (d?.imageFormat || many) {
      items.push({ separator: true, label: "" }, { label: many ? "Whole Document as PDF" : "PDF", action: () => void this.convertTo("pdf") });
    }
    items.push(
      { separator: true, label: "" },
      { label: `JPEG Quality… (${Math.round(this.jpegQuality() * 100)}%)`, action: () => void this.jpegQualityDialog() },
    );
    return items;
  }

  private showConvertMenu(anchor: HTMLElement) {
    if (this.active?.kind !== "pages" && this.active?.kind !== "markdown") return;
    const r = anchor.getBoundingClientRect();
    openMenu(this.convertMenuItems(), r.left, r.bottom + 4);
  }

  /** Open a copy of the current image (or page) in another format, as a new unsaved tab. */
  async convertTo(format: ImageFormat | "pdf") {
    const d = this.active;
    if (d?.kind !== "pages") return;
    const near = d.path ?? d.nearPath;
    const base = d.name.replace(/\.[^.]+$/, "");
    if (format === "pdf") {
      const doc = this.newDoc(`${base}.pdf`, null, clonePages(d.pages), false, { nearPath: near });
      this.activate(doc);
      return;
    }
    const id = d.pages.length === 1 ? d.pages[0].id : d.selection.size === 1 ? [...d.selection][0] : this.currentPageId;
    const ref = d.pages.find((p) => p.id === id) ?? d.pages[0];
    const index = d.pages.indexOf(ref);
    const name = d.pages.length > 1 ? `${base} page ${index + 1}.${IMAGE_SAVE_EXT[format]}` : `${base}.${IMAGE_SAVE_EXT[format]}`;
    try {
      const opaque = format === "jpeg" || format === "bmp";
      const canvas = await flattenPage(this.sources, ref, this.images, opaque);
      const bytes = await encodeCanvas(canvas, format, this.jpegQuality());
      canvas.width = canvas.height = 0;
      const src = await Source.loadImage(name, bytes, format);
      this.sources.add(src);
      const doc = this.newDoc(name, null, pagesForSource(src.id, src.pageCount), false, { imageFormat: format, nearPath: near });
      this.activate(doc);
      const size = bytes.length > 1048576 ? `${(bytes.length / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`;
      toast(`Converted to ${IMAGE_LABEL[format]} (${size}). Save to keep it.`);
    } catch (e: any) {
      toast(`Couldn't convert: ${e?.message ?? e}`, "error");
    }
  }

  /** Pick the JPEG quality used for conversions and JPEG saves, with a live size estimate. */
  private async jpegQualityDialog() {
    const d = this.active;
    let q = Math.round(this.jpegQuality() * 100);
    const value = h("span", { class: "q-value" }, `${q}%`);
    const estimate = h("span", { class: "muted" }, "");
    const slider = h("input", { type: "range", min: "40", max: "100", step: "1", value: String(q), class: "q-slider", "aria-label": "JPEG quality" });
    const body = h(
      "div",
      { class: "q-dialog" },
      h("p", {}, "Used when converting to JPEG and when saving JPEG images. Higher means better quality and bigger files."),
      h("div", { class: "q-row" }, h("span", { class: "muted" }, "Smaller"), slider, h("span", { class: "muted" }, "Better"), value),
      estimate,
    );
    // Estimate the size by encoding the current image (or page) at the chosen quality.
    let sample: HTMLCanvasElement | null = null;
    let timer = 0;
    const ref = d?.kind === "pages" ? d.pages.find((p) => p.id === this.currentPageId) ?? d.pages[0] : null;
    const update = () => {
      q = Number(slider.value);
      value.textContent = `${q}%`;
      clearTimeout(timer);
      if (!ref) return;
      timer = window.setTimeout(async () => {
        sample ??= await flattenPage(this.sources, ref, this.images, true);
        const bytes = await encodeCanvas(sample, "jpeg", q / 100);
        const kb = bytes.length / 1024;
        estimate.textContent = `This ${d!.pages.length > 1 ? "page" : "image"} as a JPEG: about ${kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`}`;
      }, 150);
    };
    slider.addEventListener("input", update);
    update();
    const ok = await modal({
      title: "JPEG quality",
      body,
      cancelValue: false,
      buttons: [{ label: "Cancel", value: false }, { label: "Done", value: true, kind: "primary" }],
    });
    clearTimeout(timer);
    if (sample) (sample as HTMLCanvasElement).width = 0;
    if (!ok) return;
    try {
      localStorage.setItem(JPEG_QUALITY_KEY, String(q / 100));
    } catch {
      /* storage unavailable */
    }
    toast(`JPEG quality set to ${q}%`);
  }

  // ================================================================ markup

  private loadMarkupPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(MARKUP_KEY) ?? "{}");
      if (MARK_COLORS.includes(p.color)) this.markColor = p.color;
      if (MARK_WIDTHS.includes(p.width)) this.markWidth = p.width;
    } catch {
      /* defaults */
    }
  }

  private saveMarkupPrefs() {
    try {
      localStorage.setItem(MARKUP_KEY, JSON.stringify({ color: this.markColor, width: this.markWidth }));
    } catch {
      /* storage unavailable */
    }
  }

  private buildMarkupBar() {
    this.loadMarkupPrefs();
    const tool = (t: Tool, label: string, iconName: string, key: string) =>
      h("button", { class: "tool", title: `${label} (${key})`, "aria-label": label, dataset: { tool: t }, onclick: () => this.setTool(t) }, icon(iconName));
    const swatches = MARK_COLORS.map((c) =>
      h("button", {
        class: "swatch",
        title: "Colour",
        "aria-label": `Colour ${c}`,
        dataset: { color: c },
        style: { background: c },
        onclick: () => this.setMarkStyle({ color: c }),
      }),
    );
    const widths = MARK_WIDTHS.map((w, i) =>
      h("button", {
        class: "tool width",
        title: ["Thin", "Medium", "Thick"][i] + " lines",
        "aria-label": ["Thin", "Medium", "Thick"][i] + " lines",
        dataset: { width: String(w) },
        onclick: () => this.setMarkStyle({ width: w }),
      }, h("span", { class: "width-sample", style: { height: `${Math.round(w * 1.2 + 0.5)}px` } })),
    );
    this.markupBar.append(
      tool("select", "Select and move", "pointer", "V"),
      tool("rect", "Rectangle", "rect", "R"),
      tool("oval", "Oval", "oval", "O"),
      tool("arrow", "Arrow", "arrow", "A"),
      tool("callout", "Callout with text", "callout", "T"),
      tool("crop", "Crop", "crop", "C"),
      h("div", { class: "sep" }),
      h("div", { class: "swatches" }, ...swatches),
      h("div", { class: "sep" }),
      ...widths,
      h("div", { class: "spacer" }),
      h("span", { class: "markup-hint" }),
      h("button", { class: "btn primary small apply-crop", onclick: () => this.applyCrop() }, "Crop"),
      h("button", { class: "tool with-text", title: `Copy the image with its markup (${MOD}C)`, onclick: () => void this.copyImage() }, icon("copy"), h("span", {}, "Copy")),
    );
  }

  private renderMarkupBar() {
    const d = this.active;
    const sel = this.selectedMarkObj();
    const color = sel?.color ?? this.markColor;
    const width = sel?.width ?? this.markWidth;
    for (const b of this.markupBar.querySelectorAll<HTMLElement>("[data-tool]")) b.classList.toggle("active", b.dataset.tool === this.tool);
    for (const b of this.markupBar.querySelectorAll<HTMLElement>("[data-color]")) b.classList.toggle("active", b.dataset.color === color);
    for (const b of this.markupBar.querySelectorAll<HTMLElement>("[data-width]")) b.classList.toggle("active", Number(b.dataset.width) === width);
    const hint = this.markupBar.querySelector(".markup-hint");
    this.markupBar.classList.toggle("has-crop-draft", !!this.cropDraft);
    if (hint && this.tool === "crop") {
      const draft = this.cropDraft;
      const ref = draft ? d?.pages.find((p) => p.id === draft.pageId) : undefined;
      const k = ref ? this.sources.get(ref.sourceId).original?.pointsPerPixel[ref.index] : undefined;
      const units = (v: number) => Math.round(k ? v / this.scale / k : v / this.scale);
      hint.textContent = draft
        ? `${units(draft.w)} × ${units(draft.h)} ${k ? "px" : "pt"}. Adjust the box, then press Enter or click Crop. Esc to cancel.`
        : `Drag a box around the part to keep.`;
    } else if (hint) {
      hint.textContent = !d || d.kind !== "pages" ? "" : this.tool !== "select"
        ? this.tool === "callout"
          ? "Click what you want to point at, or drag from it to where the text should go, then type."
          : `Drag on the ${d.imageFormat ? "image" : "page"} to draw. Shift for squares, circles and 45° arrows. Esc to stop.`
        : sel?.type === "callout"
          ? "Double-click to edit the text. Drag the box or the dot to move them. Delete to remove."
          : sel ? "Drag to move, drag a handle to resize. Delete to remove." : "";
    }
    this.root.classList.toggle("drawing", !!d?.markup && this.tool !== "select");
  }

  toggleMarkup() {
    const d = this.active;
    if (d?.kind !== "pages") return;
    d.markup = !d.markup;
    if (!d.markup) {
      this.tool = "select";
      this.selectMark(null);
    }
    this.render();
  }

  setTool(t: Tool) {
    const d = this.active;
    if (d?.kind !== "pages") return;
    if (!d.markup) {
      d.markup = true;
      this.render();
    }
    this.tool = t;
    if (t !== "crop") this.clearCropDraft();
    if (t !== "select") this.selectMark(null);
    if (this.placing) this.stopPlacing();
    this.renderMarkupBar();
  }

  private selectedMarkObj(): Mark | null {
    if (!this.selectedMark || !this.active) return null;
    for (const p of this.active.pages) {
      const m = p.marks.find((x) => x.id === this.selectedMark);
      if (m) return m;
    }
    return null;
  }

  private pageOfMark(id: string): PageRef | undefined {
    return this.active?.pages.find((p) => p.marks.some((m) => m.id === id));
  }

  private selectMark(id: string | null) {
    const prev = this.selectedMark ? this.pageOfMark(this.selectedMark) : undefined;
    this.selectedMark = id;
    if (id && this.selectedStamp) {
      const sp = this.active?.pages.find((p) => p.stamps.some((s) => s.id === this.selectedStamp));
      this.selectedStamp = null;
      if (sp) this.renderStampsFor(sp.id);
    }
    if (prev) this.renderMarksFor(prev.id);
    const next = id ? this.pageOfMark(id) : undefined;
    if (next && next !== prev) this.renderMarksFor(next.id);
    this.renderMarkupBar();
  }

  /** New colour or line width: applies to the selected shape and to the next ones. */
  private setMarkStyle(style: { color?: string; width?: number }) {
    if (style.color) this.markColor = style.color;
    if (style.width) this.markWidth = style.width;
    this.saveMarkupPrefs();
    const d = this.active;
    const sel = this.selectedMarkObj();
    if (d && sel) {
      this.commit(d, d.pages.map((p) => ({ ...p, marks: p.marks.map((m) => (m.id === sel.id ? { ...m, ...style } : m)) })));
    }
    this.renderMarkupBar();
  }

  private deleteMark(id: string) {
    const d = this.active;
    if (!d) return;
    this.selectedMark = null;
    this.commit(d, d.pages.map((p) => (p.marks.some((m) => m.id === id) ? { ...p, marks: p.marks.filter((m) => m.id !== id) } : p)));
  }

  /** Draw the page's shapes (plus an in-progress one) as SVG over the page, and update its thumbnail. */
  private renderMarksFor(pageId: string, preview?: Mark) {
    const d = this.active;
    const pe = this.pageEls.get(pageId);
    const ref = d?.pages.find((p) => p.id === pageId);
    if (!d || !ref) return;
    if (pe) pe.marks.replaceChildren(...this.markNodes(ref, this.scale, true, preview));
    if (!preview) this.renderThumbMarks(ref);
  }

  private renderThumbMarks(ref: PageRef) {
    const t = this.thumbEls.get(ref.id);
    if (!t) return;
    let svg = t.el.querySelector<SVGSVGElement>("svg.marks");
    if (!ref.marks.length) return svg?.replaceChildren();
    if (!svg) {
      svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
      svg.classList.add("marks");
      t.el.querySelector(".thumb-content")!.append(svg);
    }
    const size = displaySize(this.sources, ref);
    svg.replaceChildren(...this.markNodes(ref, Math.min(THUMB_W / size.width, THUMB_H / size.height), false));
  }

  /** SVG elements for a page's shapes at a given scale. `interactive` adds hit areas and handles. */
  private markNodes(ref: PageRef, scale: number, interactive: boolean, preview?: Mark): Element[] {
    const vp = viewportFor(this.sources, ref, scale);
    const P = (x: number, y: number) => vp.convertToViewportPoint(x, y) as [number, number];
    const el = (tag: string, attrs: Record<string, string | number>) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      return n;
    };
    let marks = ref.marks;
    if (preview) marks = marks.some((m) => m.id === preview.id) ? marks.map((m) => (m.id === preview.id ? preview : m)) : [...marks, preview];
    const nodes: Element[] = [];
    for (const m of marks) {
      const g = el("g", interactive ? { "data-mark": m.id, class: m.id === this.selectedMark ? "mark selected" : "mark" } : {});
      const sw = m.width * scale;
      const paint = { stroke: m.color, "stroke-width": sw, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
      const hit: Record<string, string | number> = interactive
        ? { class: "mark-hit", stroke: "transparent", fill: "none", "stroke-width": Math.max(14, sw + 10) }
        : { display: "none" };
      const [ax, ay] = P(m.x1, m.y1), [bx, by] = P(m.x2, m.y2);
      const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), hgt = Math.abs(by - ay);
      let handles: [number, number][] = [];
      if (m.type === "callout") {
        nodes.push(this.calloutNode(m, vp, scale, interactive, g, el));
        continue;
      }
      if (m.type === "rect") {
        g.append(el("rect", { x, y, width: w, height: hgt, ...paint }), el("rect", { x, y, width: w, height: hgt, ...hit }));
        handles = [[x, y], [x + w, y], [x + w, y + hgt], [x, y + hgt]];
      } else if (m.type === "oval") {
        const e = { cx: x + w / 2, cy: y + hgt / 2, rx: w / 2, ry: hgt / 2 };
        g.append(el("ellipse", { ...e, ...paint }), el("ellipse", { ...e, ...hit }));
        handles = [[x, y], [x + w, y], [x + w, y + hgt], [x, y + hgt]];
      } else {
        const geo = arrowGeometry(m);
        if (geo) {
          const [s0, s1] = geo.shaft.map(([px, py]) => P(px, py));
          const head = geo.head.map(([px, py]) => P(px, py).join(",")).join(" ");
          g.append(
            el("line", { x1: s0[0], y1: s0[1], x2: s1[0], y2: s1[1], ...paint }),
            el("polygon", { points: head, fill: m.color, stroke: m.color, "stroke-width": Math.min(sw, 2 * scale), "stroke-linejoin": "round" }),
            el("line", { x1: ax, y1: ay, x2: bx, y2: by, ...hit }),
          );
        }
        handles = [[ax, ay], [bx, by]];
      }
      if (interactive && m.id === this.selectedMark && !preview) {
        handles.forEach(([hx, hy], i) => g.append(el("rect", { class: "mark-handle", "data-handle": i, x: hx - 5, y: hy - 5, width: 10, height: 10, rx: 2 })));
      }
      nodes.push(g);
    }
    return nodes;
  }

  private pointIn(e: PointerEvent, pageId: string): [number, number] {
    const r = this.pageEls.get(pageId)!.content.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Mark from two display points (CSS px on the page). */
  private markFromDisplay(ref: PageRef, base: Omit<Mark, "x1" | "y1" | "x2" | "y2">, a: [number, number], b: [number, number]): Mark {
    const vp = viewportFor(this.sources, ref, this.scale);
    const [x1, y1] = vp.convertToPdfPoint(...a);
    const [x2, y2] = vp.convertToPdfPoint(...b);
    return { ...base, x1, y1, x2, y2 };
  }

  /** Shift-constrain: squares and circles, or arrows at 45° steps. */
  private constrain(type: MarkType, a: [number, number], b: [number, number]): [number, number] {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (type === "arrow") {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + Math.sign(dx || 1) * side, a[1] + Math.sign(dy || 1) * side];
  }

  private drawMark(e: PointerEvent, ref: PageRef) {
    const d = this.active!;
    const type = this.tool as MarkType;
    const pageEl = this.pageEls.get(ref.id)!.el;
    const start = this.pointIn(e, ref.id);
    const base = { id: uid("m"), type, color: this.markColor, width: this.markWidth };
    let end = start;
    pageEl.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = this.pointIn(ev, ref.id);
      end = ev.shiftKey ? this.constrain(type, start, p) : p;
      this.renderMarksFor(ref.id, this.markFromDisplay(ref, base, start, end));
    };
    const up = () => {
      pageEl.removeEventListener("pointermove", move);
      pageEl.removeEventListener("pointerup", up);
      pageEl.removeEventListener("pointercancel", up);
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 4) {
        this.renderMarksFor(ref.id);
        return;
      }
      const mark = this.markFromDisplay(ref, base, start, end);
      this.commit(d, d.pages.map((p) => (p.id === ref.id ? { ...p, marks: [...p.marks, mark] } : p)));
      this.selectMark(mark.id);
    };
    pageEl.addEventListener("pointermove", move);
    pageEl.addEventListener("pointerup", up);
    pageEl.addEventListener("pointercancel", up);
  }

  /** Select a shape and move it, or drag one of its handles to reshape it. */
  private dragMark(e: PointerEvent, ref: PageRef, markId: string, handle: number | null) {
    const d = this.active!;
    const orig = ref.marks.find((m) => m.id === markId);
    if (!orig) return;
    if (this.selectedMark !== markId) this.selectMark(markId);
    const pageEl = this.pageEls.get(ref.id)!.el;
    const vp = viewportFor(this.sources, ref, this.scale);
    const a = vp.convertToViewportPoint(orig.x1, orig.y1) as [number, number];
    const b = vp.convertToViewportPoint(orig.x2, orig.y2) as [number, number];
    const start = this.pointIn(e, ref.id);
    let current = orig;
    let moved = false;
    pageEl.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      let p = this.pointIn(ev, ref.id);
      const dx = p[0] - start[0], dy = p[1] - start[1];
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      if (orig.type === "callout") {
        if (handle === null) {
          // Move the box; the dot stays on what it points at.
          const [x1, y1] = vp.convertToPdfPoint(a[0] + dx, a[1] + dy);
          current = { ...orig, x1, y1 };
        } else if (handle === 1) {
          const [x2, y2] = vp.convertToPdfPoint(...p);
          current = { ...orig, x2, y2 };
        } else {
          // Width handle: project the drag onto the text direction.
          const [ux, uy] = this.calloutAxis(orig, vp);
          const len = Math.hypot(ux, uy);
          const boxW = Math.max(CALLOUT_MIN_WIDTH, (orig.boxW ?? CALLOUT_MIN_WIDTH) + (dx * ux + dy * uy) / len / this.scale);
          current = this.relayout({ ...orig, boxW, autoW: false });
        }
      } else if (handle === null) {
        current = this.markFromDisplay(ref, orig, [a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy]);
      } else if (orig.type === "arrow") {
        const fixed = handle === 0 ? b : a;
        if (ev.shiftKey) p = this.constrain("arrow", fixed, p);
        current = handle === 0 ? this.markFromDisplay(ref, orig, p, b) : this.markFromDisplay(ref, orig, a, p);
      } else {
        // Corners in display order: top-left, top-right, bottom-right, bottom-left. Keep the opposite one fixed.
        const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
        const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const fixed = corners[(handle + 2) % 4];
        if (ev.shiftKey) p = this.constrain(orig.type, fixed, p);
        current = this.markFromDisplay(ref, orig, fixed, p);
      }
      this.renderMarksFor(ref.id, current);
    };
    const up = (ev: PointerEvent) => {
      pageEl.removeEventListener("pointermove", move);
      pageEl.removeEventListener("pointerup", up);
      pageEl.removeEventListener("pointercancel", up);
      if (!moved) {
        this.lastMarkClick = { id: markId, t: performance.now(), x: ev.clientX, y: ev.clientY };
        return;
      }
      this.lastMarkClick = null;
      this.commit(d, d.pages.map((p) => (p.id === ref.id ? { ...p, marks: p.marks.map((m) => (m.id === markId ? current : m)) } : p)));
      this.renderMarksFor(ref.id);
    };
    pageEl.addEventListener("pointermove", move);
    pageEl.addEventListener("pointerup", up);
    pageEl.addEventListener("pointercancel", up);
  }

  // ================================================================ callouts

  private calloutFont(): Promise<Uint8Array> {
    this.calloutFontBytes ??= fetch(`${import.meta.env.BASE_URL}fonts/Inter-Regular.ttf`)
      .then((r) => {
        if (!r.ok) throw new Error("couldn't load the callout font");
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b));
    return this.calloutFontBytes;
  }

  private measureCtx: CanvasRenderingContext2D | null = null;
  private measure(fontSize: number) {
    this.measureCtx ??= document.createElement("canvas").getContext("2d")!;
    const ctx = this.measureCtx;
    ctx.font = `${fontSize}px ${CALLOUT_FONT}, sans-serif`;
    return (s: string) => ctx.measureText(s).width;
  }

  /** Re-wrap a callout's text for its width. */
  private relayout(m: Mark): Mark {
    const box = layoutCallout(m.text ?? "", { width: m.boxW ?? CALLOUT_MIN_WIDTH, auto: !!m.autoW, fontSize: m.fontSize }, this.measure(m.fontSize ?? CALLOUT_FONT_SIZE));
    return { ...m, boxW: box.width, lines: box.lines };
  }

  /** The callout's text direction on screen (display px per point). */
  private calloutAxis(m: Mark, vp: ReturnType<typeof viewportFor>): [number, number] {
    const { ux } = frame(m);
    const [p0x, p0y] = vp.convertToViewportPoint(m.x1, m.y1);
    const [p1x, p1y] = vp.convertToViewportPoint(m.x1 + ux[0], m.y1 + ux[1]);
    return [p1x - p0x, p1y - p0y];
  }

  /** SVG for a callout, drawn in its local frame (see core/callout.ts). */
  private calloutNode(m: Mark, vp: ReturnType<typeof viewportFor>, scale: number, interactive: boolean, g: Element, el: (tag: string, attrs: Record<string, string | number>) => Element): Element {
    const { ux, down } = frame(m);
    const P = (x: number, y: number) => vp.convertToViewportPoint(x, y) as [number, number];
    const o = P(m.x1, m.y1), px = P(m.x1 + ux[0], m.y1 + ux[1]), pd = P(m.x1 + down[0], m.y1 + down[1]);
    const local = el("g", { transform: `matrix(${px[0] - o[0]} ${px[1] - o[1]} ${pd[0] - o[0]} ${pd[1] - o[1]} ${o[0]} ${o[1]})` });
    const w = m.boxW ?? CALLOUT_MIN_WIDTH, h = boxHeight(m);
    const l = leader(m);
    const editingThis = this.editing?.mark.id === m.id;
    if (l) {
      local.append(
        el("line", { x1: l.from[0], y1: l.from[1], x2: l.to[0], y2: l.to[1], stroke: m.color, "stroke-width": Math.max(1, m.width * 0.75), "stroke-linecap": "round" }),
        el("circle", { cx: l.to[0], cy: l.to[1], r: dotRadius(m), fill: m.color, stroke: "#fff", "stroke-width": 1.5 }),
      );
      if (interactive) local.append(el("line", { class: "mark-hit", x1: l.from[0], y1: l.from[1], x2: l.to[0], y2: l.to[1], stroke: "transparent", "stroke-width": 12 / scale }));
    }
    local.append(
      el("path", { d: boxPath(w, h, 0, 1.5), fill: "rgba(0,0,0,0.12)" }),
      el("path", { d: boxPath(w, h), fill: "#fff", stroke: m.color, "stroke-width": m.width, class: interactive ? "callout-box" : "" }),
    );
    if (!editingThis) {
      (m.lines ?? []).forEach((line, i) => {
        if (!line) return;
        const t = el("text", { x: CALLOUT_PAD_X, y: baseline(m, i), "font-family": `${CALLOUT_FONT}, sans-serif`, "font-size": m.fontSize ?? CALLOUT_FONT_SIZE, fill: CALLOUT_TEXT_COLOR });
        t.textContent = line;
        local.append(t);
      });
    }
    if (interactive && m.id === this.selectedMark && !editingThis) {
      const s = 10 / scale;
      const to = l?.to ?? toLocal(m, m.x2, m.y2);
      local.append(
        el("circle", { class: "mark-handle", "data-handle": 1, cx: to[0], cy: to[1], r: s / 1.6, "stroke-width": 1.5 / scale }),
        el("rect", { class: "mark-handle width-handle", "data-handle": 2, x: w - s / 2, y: h / 2 - s, width: s, height: s * 2, rx: s / 4, "stroke-width": 1.5 / scale }),
      );
    }
    g.append(local);
    g.classList.add("callout");
    return g;
  }

  private onPageDoubleClick(e: MouseEvent, pageId: string) {
    const id = (e.target as Element).closest<SVGElement>("[data-mark]")?.dataset.mark;
    const ref = this.active?.pages.find((p) => p.id === pageId);
    const mark = ref?.marks.find((m) => m.id === id);
    if (mark?.type === "callout") {
      e.preventDefault();
      this.startEditing(pageId, mark, false);
    }
  }

  /** Click (or drag from) the point to annotate; the box goes where the pointer is released. */
  private createCallout(e: PointerEvent, ref: PageRef) {
    const pageEl = this.pageEls.get(ref.id)!.el;
    const start = this.pointIn(e, ref.id);
    let end = start;
    const base: Mark = this.relayout({
      id: uid("m"),
      type: "callout",
      x1: 0, y1: 0, x2: 0, y2: 0,
      color: this.markColor,
      width: Math.min(this.markWidth, 3),
      text: "",
      boxW: CALLOUT_MIN_WIDTH,
      autoW: true,
      fontSize: CALLOUT_FONT_SIZE,
      rotation: totalRotation(this.sources, ref),
    });
    const place = (target: [number, number], at: [number, number]): Mark => {
      const vp = viewportFor(this.sources, ref, this.scale);
      const W = (base.boxW ?? CALLOUT_MIN_WIDTH) * this.scale, H = boxHeight(base) * this.scale;
      const dragged = Math.hypot(at[0] - target[0], at[1] - target[1]) >= 6;
      // A click puts the box up and to the right of the point; a drag puts it where the pointer ends.
      const pos: [number, number] = dragged ? at : [target[0] + 40, target[1] - 60];
      const left = pos[0] >= target[0] ? pos[0] : pos[0] - W;
      const area = this.visibleArea(ref);
      const L = Math.min(Math.max(area.left + 4, left), area.left + area.width - W - 4);
      const T = Math.min(Math.max(area.top + 4, pos[1] - H / 2), area.top + area.height - H - 4);
      const [x1, y1] = vp.convertToPdfPoint(L, T);
      const [x2, y2] = vp.convertToPdfPoint(...target);
      return { ...base, x1, y1, x2, y2 };
    };
    pageEl.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      end = this.pointIn(ev, ref.id);
      this.renderMarksFor(ref.id, place(start, end));
    };
    const up = () => {
      pageEl.removeEventListener("pointermove", move);
      pageEl.removeEventListener("pointerup", up);
      pageEl.removeEventListener("pointercancel", up);
      this.startEditing(ref.id, place(start, end), true);
    };
    pageEl.addEventListener("pointermove", move);
    pageEl.addEventListener("pointerup", up);
    pageEl.addEventListener("pointercancel", up);
  }

  /** Type into a callout, in place. */
  private startEditing(pageId: string, mark: Mark, isNew: boolean) {
    this.finishEditing();
    const d = this.active;
    const ref = d?.pages.find((p) => p.id === pageId);
    const pe = this.pageEls.get(pageId);
    if (!d || !ref || !pe) return;
    const vp = viewportFor(this.sources, ref, this.scale);
    const [ax, ay] = this.calloutAxis(mark, vp);
    // In-place typing needs upright text on screen; otherwise ask in a dialog.
    if (Math.abs(ay) > 1e-6 || ax <= 0) return void this.editInDialog(pageId, mark, isNew);
    this.selectedMark = mark.id;
    const textarea = h("textarea", { class: "callout-editor", spellcheck: "true", "aria-label": "Callout text", rows: "1" });
    textarea.value = mark.text ?? "";
    const s = this.scale;
    const size = (mark.fontSize ?? CALLOUT_FONT_SIZE) * s;
    Object.assign(textarea.style, {
      fontFamily: `${CALLOUT_FONT}, sans-serif`,
      fontSize: `${size}px`,
      lineHeight: `${size * CALLOUT_LINE_HEIGHT}px`,
      padding: `${CALLOUT_PAD_Y * s}px ${CALLOUT_PAD_X * s}px`,
      color: CALLOUT_TEXT_COLOR,
    });
    this.editing = { pageId, mark, isNew, textarea };
    const sync = () => {
      const e = this.editing;
      if (!e) return;
      e.mark = this.relayout({ ...e.mark, text: textarea.value });
      const [L, T] = vp.convertToViewportPoint(e.mark.x1, e.mark.y1);
      Object.assign(textarea.style, {
        left: `${L}px`,
        top: `${T}px`,
        width: `${(e.mark.boxW ?? CALLOUT_MIN_WIDTH) * s}px`,
        height: `${boxHeight(e.mark) * s}px`,
      });
      this.renderMarksFor(pageId, e.mark);
    };
    textarea.addEventListener("input", sync);
    textarea.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    pe.content.append(textarea);
    sync();
    textarea.focus();
    textarea.select();
    this.renderMarkupBar();
  }

  private finishEditing() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    e.textarea.remove();
    const d = this.active;
    if (!d) return;
    const mark = this.relayout({ ...e.mark, text: (e.mark.text ?? "").replace(/\s+$/, "") });
    const empty = !mark.text?.trim();
    const exists = d.pages.some((p) => p.marks.some((m) => m.id === mark.id));
    if (empty) {
      if (exists) this.deleteMark(mark.id);
      else this.renderMarksFor(e.pageId);
      return;
    }
    const before = d.pages.find((p) => p.id === e.pageId)?.marks.find((m) => m.id === mark.id);
    if (before && JSON.stringify(before) === JSON.stringify(mark)) {
      this.renderMarksFor(e.pageId);
      return;
    }
    this.commit(d, d.pages.map((p) => (p.id === e.pageId ? { ...p, marks: exists ? p.marks.map((m) => (m.id === mark.id ? mark : m)) : [...p.marks, mark] } : p)));
    this.selectMark(mark.id);
  }

  private async editInDialog(pageId: string, mark: Mark, isNew: boolean) {
    const area = h("textarea", { class: "callout-dialog-text", rows: "4" });
    area.value = mark.text ?? "";
    const ok = await modal({
      title: isNew ? "Callout text" : "Edit callout",
      body: area,
      cancelValue: false,
      buttons: [{ label: "Cancel", value: false }, { label: "Done", value: true, kind: "primary" }],
      onOpen: () => setTimeout(() => area.focus()),
    });
    const d = this.active;
    if (!ok || !d) return void this.renderMarksFor(pageId);
    const text = area.value.trim();
    const exists = d.pages.some((p) => p.marks.some((m) => m.id === mark.id));
    if (!text) {
      if (exists) this.deleteMark(mark.id);
      return void this.renderMarksFor(pageId);
    }
    const next = this.relayout({ ...mark, text });
    this.commit(d, d.pages.map((p) => (p.id === pageId ? { ...p, marks: exists ? p.marks.map((m) => (m.id === mark.id ? next : m)) : [...p.marks, next] } : p)));
  }

  // ================================================================ crop

  /** The page's visible area in page-content CSS px (the crop window, or the whole page). */
  private visibleArea(ref: PageRef) {
    const win = cropWindow(this.sources, ref, this.scale);
    if (win) return win;
    const vp = viewportFor(this.sources, ref, this.scale);
    return { left: 0, top: 0, width: vp.width, height: vp.height };
  }

  private clearCropDraft() {
    if (!this.cropDraft) return;
    const pe = this.pageEls.get(this.cropDraft.pageId);
    this.cropDraft = null;
    pe?.content.querySelector(".crop-box")?.remove();
    this.renderMarkupBar();
  }

  private renderCropDraft() {
    const draft = this.cropDraft;
    for (const b of this.pagesHost.querySelectorAll(".crop-box")) b.remove();
    if (draft) {
      const pe = this.pageEls.get(draft.pageId);
      const box = h(
        "div",
        { class: "crop-box", style: { left: `${draft.l}px`, top: `${draft.t}px`, width: `${draft.w}px`, height: `${draft.h}px` } },
        ...[0, 1, 2, 3].map((i) => h("div", { class: `crop-handle c${i}`, dataset: { corner: String(i) } })),
      );
      pe?.content.append(box);
    }
    this.renderMarkupBar();
  }

  /** Draw, move or resize the crop box. */
  private cropPointer(e: PointerEvent, ref: PageRef) {
    const area = this.visibleArea(ref);
    const clampX = (x: number) => Math.min(area.left + area.width, Math.max(area.left, x));
    const clampY = (y: number) => Math.min(area.top + area.height, Math.max(area.top, y));
    const start = this.pointIn(e, ref.id);
    const target = e.target as HTMLElement;
    const draft = this.cropDraft?.pageId === ref.id ? { ...this.cropDraft } : null;
    const corner = target.closest<HTMLElement>(".crop-handle")?.dataset.corner;
    const inside = draft && start[0] >= draft.l && start[0] <= draft.l + draft.w && start[1] >= draft.t && start[1] <= draft.t + draft.h;
    let mode: "new" | "move" | "resize" = corner !== undefined && draft ? "resize" : inside ? "move" : "new";
    if (this.cropDraft && this.cropDraft.pageId !== ref.id) this.clearCropDraft();
    // For a resize, the corner opposite the handle stays put.
    let fixed: [number, number] = start;
    if (mode === "resize" && draft) {
      const c = Number(corner);
      fixed = [c === 1 || c === 2 ? draft.l : draft.l + draft.w, c >= 2 ? draft.t : draft.t + draft.h];
    }
    const pageEl = this.pageEls.get(ref.id)!.el;
    pageEl.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = this.pointIn(ev, ref.id);
      if (mode === "move" && draft) {
        const l = Math.min(area.left + area.width - draft.w, Math.max(area.left, draft.l + p[0] - start[0]));
        const t = Math.min(area.top + area.height - draft.h, Math.max(area.top, draft.t + p[1] - start[1]));
        this.cropDraft = { ...draft, l, t };
      } else {
        const a = mode === "new" ? start : fixed;
        const bx = clampX(p[0]), by = clampY(p[1]);
        const ax = clampX(a[0]), ay = clampY(a[1]);
        this.cropDraft = { pageId: ref.id, l: Math.min(ax, bx), t: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
      }
      this.renderCropDraft();
    };
    const up = () => {
      pageEl.removeEventListener("pointermove", move);
      pageEl.removeEventListener("pointerup", up);
      pageEl.removeEventListener("pointercancel", up);
      const dr = this.cropDraft;
      if (dr && (dr.w < 4 || dr.h < 4)) this.clearCropDraft();
    };
    pageEl.addEventListener("pointermove", move);
    pageEl.addEventListener("pointerup", up);
    pageEl.addEventListener("pointercancel", up);
  }

  applyCrop() {
    const d = this.active;
    const draft = this.cropDraft;
    const ref = draft ? d?.pages.find((p) => p.id === draft.pageId) : undefined;
    if (!d || !draft || !ref) return;
    const vp = viewportFor(this.sources, ref, this.scale);
    const [ax, ay] = vp.convertToPdfPoint(draft.l, draft.t);
    const [bx, by] = vp.convertToPdfPoint(draft.l + draft.w, draft.t + draft.h);
    const crop: Crop = { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
    this.cropDraft = null;
    this.tool = "select";
    for (const b of this.pagesHost.querySelectorAll(".crop-box")) b.remove();
    this.commit(d, d.pages.map((p) => (p.id === ref.id ? { ...p, crop } : p)));
    toast("Cropped. Undo to bring it back; saving makes it permanent for images.");
  }

  removeCrop() {
    const d = this.active;
    if (!d) return;
    const ids = this.targetIds(d);
    this.commit(d, d.pages.map((p) => (ids.has(p.id) && p.crop ? { ...p, crop: null } : p)));
  }

  // ================================================================ copy to clipboard

  /** Copy the current page (or the one selected page) as an image, markup and signatures included. */
  async copyImage() {
    const d = this.active;
    if (d?.kind !== "pages") return;
    const id = d.selection.size === 1 ? [...d.selection][0] : this.currentPageId ?? d.pages[0]?.id;
    const ref = d.pages.find((p) => p.id === id);
    if (!ref) return;
    try {
      const canvas = await flattenPage(this.sources, ref, this.images, false);
      await this.platform.writeClipboardImage(canvas);
      canvas.width = canvas.height = 0;
      d.copied = snapshot(d.pages);
      toast(d.pages.length > 1 ? `Copied page ${d.pages.indexOf(ref) + 1} as an image` : "Copied to the clipboard");
    } catch (e: any) {
      toast(`Couldn't copy: ${e?.message ?? e}`, "error");
    }
  }

  // ================================================================ library, tab limit, settings

  private historyKind(doc: Doc): HistoryKind {
    return doc.kind === "model" ? "model" : doc.kind === "markdown" ? "markdown" : doc.imageFormat ? "image" : "pdf";
  }

  /** A small picture of the first page, for the Library. */
  private async saveThumb(doc: Doc) {
    const ref = doc.pages[0];
    if (!doc.path || !ref || doc.kind !== "pages") return;
    try {
      const size = displaySize(this.sources, ref);
      const scale = Math.min(180 / size.width, 180 / size.height);
      const canvas = document.createElement("canvas");
      await renderInto(this.sources, ref, scale / (window.devicePixelRatio || 1), canvas, () => true);
      if (canvas.width) await this.history.setThumb(doc.path, canvas);
      canvas.width = canvas.height = 0;
    } catch {
      /* a missing thumbnail is fine */
    }
  }

  showLibrary() {
    if (this.active) this.activate(null);
    this.library.render();
  }

  private toggleLibrary() {
    if (this.active) return this.showLibrary();
    const back = this.lastDoc && this.docs.includes(this.lastDoc) ? this.lastDoc : [...this.docs].sort((a, b) => b.lastActive - a.lastActive)[0];
    if (back) this.activate(back);
  }

  private togglePin(d: Doc) {
    d.pinned = !d.pinned;
    this.renderTabs();
    if (!d.pinned) this.enforceTabLimit();
  }

  /**
   * Keep at most `maxTabs` files open by closing the least recently used ones.
   * Pinned tabs, unsaved changes and never-saved documents are never closed, and
   * don't count toward the limit; neither does the tab you're looking at.
   */
  private enforceTabLimit() {
    const countable = this.docs.filter((d) => !d.pinned && d.path && !d.path.startsWith("download:") && !isDirty(d));
    let excess = countable.length - this.settings.maxTabs;
    if (excess <= 0) return;
    const victims = countable.filter((d) => d !== this.active).sort((a, b) => a.lastActive - b.lastActive);
    const closed: Doc[] = [];
    for (const d of victims) {
      if (excess-- <= 0) break;
      const i = this.docs.indexOf(d);
      this.docs.splice(i, 1);
      if (this.lastDoc === d) this.lastDoc = null;
      d.md?.dispose();
      closed.push(d);
    }
    if (!closed.length) return;
    this.collectSources();
    this.render();
    // Opening several files closes several tabs: tell about them in one message.
    this.recentlyClosed.push(...closed);
    clearTimeout(this.closedToastTimer);
    this.closedToastTimer = window.setTimeout(() => {
      const all = this.recentlyClosed.splice(0);
      const names = all.length === 1 ? `“${all[0].name}”` : `${all.length} tabs you hadn't used for a while`;
      toast(`Closed ${names}${all.length === 1 ? ", which you hadn't used for a while" : ""}. Keeping ${this.settings.maxTabs} files open.`, "info", {
        actions: [
          ...(all.length === 1 && all[0].path ? [{ label: "Reopen", run: () => void this.openPath(all[0].path!) }] : []),
          { label: "Library", run: () => this.showLibrary() },
        ],
      });
    }, 600);
  }

  private recentlyClosed: Doc[] = [];
  private closedToastTimer = 0;

  private quickSwitch() {
    const now = Date.now();
    const openItems: SwitcherItem[] = this.docs.map((d) => ({
      docId: d.id,
      path: d.path,
      ...(d.path ? splitPath(this.platform.displayPath(d.path)) : { name: d.name, dir: "" }),
      name: d.name,
      last: d === this.active ? now : d.lastActive,
      kind: this.historyKind(d),
    }));
    const openPaths = new Set(this.docs.map((d) => d.path).filter(Boolean));
    const fromHistory: SwitcherItem[] = this.history
      .list()
      .filter((e) => !openPaths.has(e.path) && this.history.exists(e.path))
      .map((e) => ({ path: e.path, name: e.name, dir: e.dir, last: e.last, kind: e.kind }));
    showSwitcher([...openItems, ...fromHistory], (it) => {
      const doc = it.docId ? this.docs.find((d) => d.id === it.docId) : undefined;
      if (doc) this.activate(doc);
      else if (it.path) void this.openPath(it.path);
    });
  }

  private async settingsDialog() {
    const s = this.settings;
    const tabs = h("input", { type: "number", min: "1", max: "200", step: "1", value: String(s.maxTabs), class: "num-input", "aria-label": "Most open files" });
    const months = h("input", { type: "number", min: "1", max: "120", step: "1", value: String(s.historyMonths), class: "num-input", "aria-label": "Months of history" });
    const clear = h("button", { class: "btn plain small", onclick: async () => {
      const ok = await modal({
        title: "Clear the Library?",
        body: "Unacro will forget every file you've opened. Your files themselves aren't touched.",
        cancelValue: false,
        buttons: [{ label: "Cancel", value: false }, { label: "Clear", value: true, kind: "danger" }],
      });
      if (ok) {
        await this.history.clear();
        toast("Library cleared");
      }
    } }, "Clear Library…");
    const body = h(
      "div",
      { class: "settings" },
      h("label", { class: "setting" }, h("span", {}, "Keep at most"), tabs, h("span", {}, "files open")),
      h("p", { class: "setting-note" }, "Older tabs close by themselves (you can reopen them from the Library). Pinned tabs, unsaved changes and new documents never close and don't count."),
      h("label", { class: "setting" }, h("span", {}, "Remember files opened in the last"), months, h("span", {}, "months")),
      h("p", { class: "setting-note" }, "The Library keeps names, folders, times and small thumbnails on this computer only."),
      h("div", { class: "setting" }, clear),
    );
    const ok = await modal({
      title: "Settings",
      body,
      cancelValue: false,
      buttons: [{ label: "Cancel", value: false }, { label: "Save", value: true, kind: "primary" }],
    });
    if (!ok) return;
    const maxTabs = Math.round(Number(tabs.value));
    const historyMonths = Math.round(Number(months.value));
    this.settings = {
      maxTabs: Number.isFinite(maxTabs) && maxTabs >= 1 ? Math.min(200, maxTabs) : s.maxTabs,
      historyMonths: Number.isFinite(historyMonths) && historyMonths >= 1 ? Math.min(120, historyMonths) : s.historyMonths,
    };
    saveSettings(this.settings);
    this.history.prune();
    this.enforceTabLimit();
    if (!this.active) this.library.render();
  }
}
