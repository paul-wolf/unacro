// The application: open documents (tabs), page sidebar, viewer, and all actions.

import { buildPdf } from "./core/build";
import { pagesToMarkdown } from "./core/markdown";
import { clonePages, movePages, normRotation, pagesForSource, uid, type PageRef, type Stamp } from "./core/model";
import { Source, Sources, displaySize, renderInto, renderTextLayer, totalRotation, viewportFor } from "./pdf";
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
}

interface PageEl {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  stamps: HTMLDivElement;
  key: string;
  rendered: string | null;
  visible: boolean;
}

const MOD = isMac() ? "⌘" : "Ctrl+";
const SHIFT = isMac() ? "⇧" : "Shift+";
const RECENT_KEY = "unacro.recent";
const THUMB_W = 116;
const THUMB_H = 150;
const PAGE_GAP = 16;

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
  private empty = h("div", { class: "empty" });
  private status = h("footer", { class: "statusbar" });
  private searchInput = h("input", { class: "search-input", type: "search", placeholder: "Find", "aria-label": "Find in document" });
  private searchInfo = h("span", { class: "search-info" });
  private buttons: Record<string, HTMLButtonElement> = {};

  constructor(private platform: Platform) {}

  // ================================================================ setup

  async start() {
    for (const sig of loadSignatures()) this.images.set(sig.id, dataUrlToBytes(sig.dataUrl));
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

    const initial = await this.platform.initialPaths().catch(() => []);
    for (const p of initial) await this.openPath(p);
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
      if (e.target === this.tabs) void this.openDialog();
    });

    const workspace = h("main", { class: "workspace" }, this.sidebar, this.viewer, this.empty);
    this.root.append(this.toolbar, this.tabs, workspace, this.status);
  }

  // ================================================================ documents

  private newDoc(name: string, path: string | null, pages: PageRef[], clean = true): Doc {
    const doc: Doc = {
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
    };
    this.docs.push(doc);
    return doc;
  }

  private async loadSource(file: OpenedFile): Promise<Source | null> {
    try {
      const src = await Source.load(file.name, file.bytes);
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
      const src = await this.loadSource(f);
      if (!src) continue;
      last = this.newDoc(f.name, f.path, pagesForSource(src.id, src.pageCount));
      if (f.path) this.addRecent(f.path);
    }
    if (last) this.activate(last);
  }

  async openDialog() {
    try {
      await this.openFiles(await this.platform.pickPdfs(true));
    } catch (e: any) {
      toast(`Couldn't open: ${e?.message ?? e}`, "error");
    }
  }

  async openPath(path: string) {
    try {
      await this.openFiles([await this.platform.readPath(path)]);
    } catch (e: any) {
      toast(`Couldn't open ${path}: ${e?.message ?? e}`, "error");
      this.removeRecent(path);
    }
  }

  /** Pick several PDFs and combine them into a new, unsaved document. */
  async combineFromFiles() {
    const files = await this.platform.pickPdfs(true).catch((e) => {
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

  combineOpenTabs() {
    if (this.docs.length < 2) return;
    const pages = this.docs.flatMap((d) => clonePages(d.pages));
    this.activate(this.newDoc("Combined.pdf", null, pages, false));
  }

  private activate(doc: Doc | null) {
    if (this.active && this.active !== doc) this.active.scrollTop = this.viewer.scrollTop;
    this.active = doc;
    this.selectedStamp = null;
    this.placing = null;
    this.clearSearch(false);
    this.render(true);
    if (doc) {
      requestAnimationFrame(() => (this.viewer.scrollTop = doc.scrollTop));
    }
  }

  async closeDoc(doc: Doc): Promise<boolean> {
    if (isDirty(doc)) {
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
    if (this.active === doc) this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    else this.render();
    this.collectSources();
    return true;
  }

  private async closeOthers(keep: Doc) {
    for (const d of [...this.docs]) if (d !== keep && !(await this.closeDoc(d))) return;
  }

  private async confirmQuit(): Promise<boolean> {
    for (const d of [...this.docs]) {
      if (isDirty(d) && !(await this.closeDoc(d))) return false;
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

  private async writePdf(doc: Doc, path: string) {
    const bytes = await buildPdf({ pages: doc.pages, sources: this.sources.bytesMap(), images: this.images });
    await this.platform.write(path, bytes);
  }

  /** Save to the document's own file, or ask where if it has none. Returns false if cancelled or failed. */
  async save(doc = this.active): Promise<boolean> {
    if (!doc) return false;
    if (!doc.path || doc.path.startsWith("download:")) return this.saveAs(doc);
    try {
      await this.writePdf(doc, doc.path);
      doc.saved = snapshot(doc.pages);
      this.render();
      toast(`Saved ${doc.name}`);
      return true;
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
      return false;
    }
  }

  /** Save to a new file; the document now lives there. */
  async saveAs(doc = this.active): Promise<boolean> {
    if (!doc) return false;
    const path = await this.platform.pickSavePath(doc.name, "pdf", doc.path);
    if (!path) return false;
    try {
      await this.writePdf(doc, path);
      doc.path = path;
      doc.name = this.platform.baseName(path);
      doc.saved = snapshot(doc.pages);
      this.addRecent(path);
      this.render();
      toast(`Saved as ${doc.name}`);
      return true;
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
      return false;
    }
  }

  /** Write the current state elsewhere; the open document keeps pointing at its file. */
  async saveCopy(doc = this.active) {
    if (!doc) return;
    const base = doc.name.replace(/\.pdf$/i, "");
    const path = await this.platform.pickSavePath(`${base} copy.pdf`, "pdf", doc.path);
    if (!path) return;
    try {
      await this.writePdf(doc, path);
      this.addRecent(path);
      toast(`Saved a copy as ${this.platform.baseName(path)}`);
    } catch (e: any) {
      toast(`Couldn't save: ${e?.message ?? e}`, "error");
    }
  }

  // ================================================================ markdown

  private async markdownFor(doc: Doc): Promise<string> {
    const texts = await Promise.all(doc.pages.map((p) => this.sources.get(p.sourceId).pageText(p.index, p.rotation)));
    return pagesToMarkdown(texts);
  }

  async exportMarkdown() {
    const doc = this.active;
    if (!doc) return;
    const name = doc.name.replace(/\.pdf$/i, "") + ".md";
    const path = await this.platform.pickSavePath(name, "md", doc.path);
    if (!path) return;
    try {
      const md = await this.markdownFor(doc);
      await this.platform.write(path, new TextEncoder().encode(md));
      toast(md.trim() ? `Exported ${this.platform.baseName(path)}` : "Exported, but this PDF has no text (it may be a scan).");
    } catch (e: any) {
      toast(`Couldn't export: ${e?.message ?? e}`, "error");
    }
  }

  async copyMarkdown() {
    const doc = this.active;
    if (!doc) return;
    try {
      const md = await this.markdownFor(doc);
      await navigator.clipboard.writeText(md);
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
    const d = this.active;
    if (!d?.undo.length) return;
    d.redo.push(d.pages);
    d.pages = d.undo.pop()!;
    this.selectedStamp = null;
    this.render();
  }

  redo() {
    const d = this.active;
    if (!d?.redo.length) return;
    d.undo.push(d.pages);
    d.pages = d.redo.pop()!;
    this.selectedStamp = null;
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
    if (!d) return this.openDialog();
    const files = await this.platform.pickPdfs(true).catch(() => [] as OpenedFile[]);
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
    if (!d || !this.clipboard.length) return;
    this.insertPages(d, clonePages(this.clipboard), this.insertIndex(d));
  }

  extractSelection() {
    const d = this.active;
    if (!d || !d.selection.size) return;
    const pages = clonePages(d.pages.filter((p) => d.selection.has(p.id)));
    const base = d.name.replace(/\.pdf$/i, "");
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
    if (!this.active) return;
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
    return Math.min(avail / widest, 1.75);
  }

  setZoom(z: number | "fit") {
    const d = this.active;
    if (!d) return;
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
    this.renderTabs();
    this.renderToolbarState();
    this.renderStatus();
    this.renderTitle();
    if (!d) {
      this.renderEmpty();
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

  private renderTitle() {
    const d = this.active;
    (window as any).__unacroDirty = this.docs.some(isDirty);
    if (!d) return this.platform.setTitle("Unacro");
    const where = d.path ? this.platform.displayPath(d.path) : "not saved yet";
    this.platform.setTitle(`${isDirty(d) ? "● " : ""}${d.name} — ${where}`);
  }

  private renderToolbarState() {
    const d = this.active;
    const has = !!d;
    for (const k of ["save", "insert", "rotl", "rotr", "delete", "sign", "md", "zoomin", "zoomout"]) this.buttons[k].disabled = !has;
    this.buttons.undo.disabled = !d?.undo.length;
    this.buttons.redo.disabled = !d?.redo.length;
    this.buttons.delete.disabled = !d?.selection.size;
    this.searchInput.disabled = !has;
    const zl = this.toolbar.querySelector(".zoom-value");
    if (zl) zl.textContent = d ? (d.zoom === "fit" ? "Fit" : `${Math.round(this.scale * 100)}%`) : "–";
  }

  private renderTabs() {
    const items = this.docs.map((d) => {
      const dirty = isDirty(d);
      const tab = h(
        "div",
        {
          class: `tab${d === this.active ? " active" : ""}${dirty ? " dirty" : ""}`,
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
          openMenu(this.docs.map((d) => ({ label: `${isDirty(d) ? "● " : ""}${d.name}`, action: () => this.activate(d) })), r.left - 200, r.bottom + 4);
        } }, icon("chevron"))
      : null;
    const strip = h("div", { class: "tab-strip" }, ...items);
    this.tabs.replaceChildren(strip, ...(listBtn ? [listBtn] : []));
    const activeTab = strip.querySelector(".tab.active");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderStatus() {
    const d = this.active;
    if (!d) {
      this.status.replaceChildren(h("span", { class: "muted" }, "No document open"));
      return;
    }
    const idx = d.pages.findIndex((p) => p.id === this.currentPageId);
    const pathEl = d.path
      ? h("button", {
          class: "path",
          title: this.platform.canReveal ? "Show in folder" : this.platform.displayPath(d.path),
          onclick: () => this.platform.canReveal && void this.platform.reveal(d.path!),
        }, this.platform.canReveal ? icon("folder") : null, h("span", { class: "path-text" }, h("bdi", {}, this.platform.displayPath(d.path))))
      : h("span", { class: "path muted" }, "No file location yet. Save will ask where.");
    const parts: Node[] = [pathEl, h("span", { class: "spacer" })];
    if (d.selection.size > 1) parts.push(h("span", {}, `${d.selection.size} pages selected`));
    parts.push(h("span", { class: "page-pos" }, `Page ${idx + 1 || 1} of ${d.pages.length}`));
    this.status.replaceChildren(...parts);
  }

  private renderEmpty() {
    const recent = this.platform.persistentPaths ? this.getRecent() : [];
    this.empty.replaceChildren(
      h(
        "div",
        { class: "empty-inner" },
        h("div", { class: "brand" }, "Unacro"),
        h("p", { class: "muted" }, "Drop PDFs anywhere to open them."),
        h(
          "div",
          { class: "empty-actions" },
          h("button", { class: "btn primary", onclick: () => void this.openDialog() }, "Open PDF…"),
          h("button", { class: "btn plain", onclick: () => void this.combineFromFiles() }, "Combine PDFs…"),
        ),
        recent.length
          ? h(
              "div",
              { class: "recent" },
              h("h3", {}, "Recent"),
              ...recent.slice(0, 8).map((p) =>
                h("button", { class: "recent-item", title: p, onclick: () => void this.openPath(p) },
                  h("span", { class: "recent-name" }, this.platform.baseName(p)),
                  h("span", { class: "recent-path" }, p)),
              ),
            )
          : null,
      ),
    );
  }

  // ------------------------------------------------------------ sidebar

  private renderSidebar() {
    const d = this.active!;
    const keep = new Set<string>();
    const els: HTMLElement[] = [];
    d.pages.forEach((ref, i) => {
      const key = `${ref.sourceId}:${ref.index}:${ref.rotation}`;
      let t = this.thumbEls.get(ref.id);
      if (!t || t.key !== key) {
        if (t) this.thumbObserver.unobserve(t.el);
        const canvas = h("canvas", { class: "thumb-canvas" });
        const el = h("div", { class: "thumb", dataset: { id: ref.id } }, h("div", { class: "thumb-frame" }, canvas), h("div", { class: "thumb-num" }));
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
      (t.el.lastElementChild as HTMLElement).textContent = String(i + 1);
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
      const key = `${ref.sourceId}:${ref.index}:${ref.rotation}:${this.scale.toFixed(4)}`;
      let pe = this.pageEls.get(ref.id);
      if (!pe) {
        const canvas = h("canvas", { class: "page-canvas" });
        const text = h("div", { class: "textLayer" });
        const stamps = h("div", { class: "stamps" });
        const el = h("div", { class: "page", dataset: { id: ref.id } }, canvas, text, stamps);
        el.addEventListener("pointerdown", (e) => this.onPagePointerDown(e, ref.id));
        pe = { el, canvas, text, stamps, key: "", rendered: null, visible: false };
        this.pageEls.set(ref.id, pe);
        this.pageObserver.observe(el);
      }
      if (pe.key !== key) {
        pe.key = key;
        const size = displaySize(this.sources, ref);
        pe.el.style.width = `${Math.floor(size.width * this.scale)}px`;
        pe.el.style.height = `${Math.floor(size.height * this.scale)}px`;
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
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.placeAt(ref, e.clientX - r.left, e.clientY - r.top);
      return;
    }
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
      if (tabEl && tabEl.dataset.doc !== d.id) {
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
    const intoSidebar = !!this.active && !!target?.closest(".sidebar");
    const at = intoSidebar ? this.sidebarIndexAt(y) : 0;
    const files = await getFiles();
    if (!files.length) return toast("Only PDF files can be opened.", "error");
    if (intoSidebar && this.active) await this.insertFiles(this.active, files, at);
    else await this.openFiles(files);
  }

  // ================================================================ menus

  private showFileMenu(anchor: HTMLElement) {
    const d = this.active;
    const r = anchor.getBoundingClientRect();
    const recent = this.platform.persistentPaths ? this.getRecent() : [];
    const items: MenuItem[] = [
      { label: "Open…", shortcut: `${MOD}O`, action: () => void this.openDialog() },
      ...(this.platform.persistentPaths
        ? [{
            label: "Open Recent",
            disabled: !recent.length,
            submenu: [
              ...recent.map((p) => ({ label: p, action: () => void this.openPath(p) })),
              { separator: true, label: "" },
              { label: "Clear Menu", action: () => this.clearRecent() },
            ],
          }]
        : []),
      { label: "Combine PDFs into New Document…", action: () => void this.combineFromFiles() },
      { label: "Combine All Open Tabs", disabled: this.docs.length < 2, action: () => this.combineOpenTabs() },
      { separator: true, label: "" },
      { label: "Save", shortcut: `${MOD}S`, disabled: !d, action: () => void this.save() },
      { label: "Save As…", shortcut: `${SHIFT}${MOD}S`, disabled: !d, action: () => void this.saveAs() },
      { label: "Save a Copy…", disabled: !d, action: () => void this.saveCopy() },
      { separator: true, label: "" },
      { label: "Export as Markdown…", disabled: !d, action: () => void this.exportMarkdown() },
      { separator: true, label: "" },
      ...(this.platform.canReveal ? [{ label: "Show in Folder", disabled: !d?.path, action: () => d?.path && void this.platform.reveal(d.path) }] : []),
      { label: "Close", shortcut: `${MOD}W`, disabled: !d, action: () => d && void this.closeDoc(d) },
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

  private showTabMenu(d: Doc, x: number, y: number) {
    openMenu(
      [
        { label: "Close", action: () => void this.closeDoc(d) },
        { label: "Close Other Tabs", disabled: this.docs.length < 2, action: () => void this.closeOthers(d) },
        { separator: true, label: "" },
        ...(this.platform.canReveal ? [{ label: "Show in Folder", disabled: !d.path, action: () => d.path && void this.platform.reveal(d.path) }] : []),
        { label: "Copy Path", disabled: !d.path, action: () => d.path && void navigator.clipboard.writeText(this.platform.displayPath(d.path)) },
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
    if (isModalOpen()) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

    if (e.key === "Escape") {
      closeMenus();
      if (this.placing) this.stopPlacing();
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
        s: () => void (e.shiftKey ? this.saveAs() : this.save()),
        w: () => this.active && void this.closeDoc(this.active),
        f: () => {
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
      const fn = act[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }
    if (inInput) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedStamp) {
        e.preventDefault();
        this.deleteStamp(this.selectedStamp);
      } else if (document.activeElement === this.sidebar && this.active?.selection.size) {
        e.preventDefault();
        this.deleteSelected();
      }
    }
  }

  // ================================================================ recent files

  private getRecent(): string[] {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  private setRecent(list: string[]) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 15)));
    } catch {
      /* storage unavailable */
    }
  }

  private addRecent(path: string) {
    if (!this.platform.persistentPaths) return;
    this.setRecent([path, ...this.getRecent().filter((p) => p !== path)]);
  }

  private removeRecent(path: string) {
    this.setRecent(this.getRecent().filter((p) => p !== path));
    if (!this.active) this.renderEmpty();
  }

  private clearRecent() {
    this.setRecent([]);
    if (!this.active) this.renderEmpty();
  }
}
