// The Library: every file opened in the last few months, with several ways to look
// at them (recent, timeline, by folder, by type), search, and thumbnails.

import { groupByFolder, groupByTime, groupByType, relativeTime, search, type Group, type HistoryEntry } from "../core/history";
import type { HistoryStore } from "../history";
import { h, icon } from "./dom";

export type LibraryMode = "recent" | "time" | "folder" | "type";

export interface LibraryDeps {
  history: HistoryStore;
  isOpen(path: string): boolean;
  open(path: string): void;
  reveal(path: string): void;
  revealLabel: string;
  canReveal: boolean;
  copyPath(path: string): void;
  openDialog(): void;
  newFromClipboard(): void;
  settings(): void;
  months(): number;
}

const MODE_KEY = "unacro.libraryMode";
const MODES: [LibraryMode, string][] = [
  ["recent", "Recent"],
  ["time", "Timeline"],
  ["folder", "Folders"],
  ["type", "Type"],
];
const MAX_ROWS = 600;

export class LibraryView {
  readonly el = h("section", { class: "library", "aria-label": "Library" });
  private body = h("div", { class: "lib-body" });
  private searchInput = h("input", { class: "lib-search", type: "search", placeholder: "Search", "aria-label": "Search the library" });
  private count = h("span", { class: "lib-count" });
  private mode: LibraryMode = "recent";
  private collapsed = new Set<string>();
  private thumbObserver: IntersectionObserver;

  constructor(private deps: LibraryDeps) {
    try {
      const m = localStorage.getItem(MODE_KEY) as LibraryMode | null;
      if (m && MODES.some(([k]) => k === m)) this.mode = m;
    } catch {
      /* default */
    }
    const modeButtons = MODES.map(([key, label]) =>
      h("button", { class: "seg", dataset: { mode: key }, onclick: () => this.setMode(key) }, label),
    );
    this.el.append(
      h(
        "header",
        { class: "lib-head" },
        h("div", { class: "lib-title" }, h("h1", {}, "Library"), this.count),
        h("label", { class: "search lib-search-wrap" }, icon("search"), this.searchInput),
        h("div", { class: "segmented", role: "tablist", "aria-label": "Group by" }, ...modeButtons),
        h("div", { class: "spacer" }),
        h("button", { class: "tool", title: "New from Clipboard", "aria-label": "New from Clipboard", onclick: () => deps.newFromClipboard() }, icon("paste")),
        h("button", { class: "tool", title: "Open…", "aria-label": "Open", onclick: () => deps.openDialog() }, icon("open")),
        h("button", { class: "tool", title: "Settings", "aria-label": "Settings", onclick: () => deps.settings() }, icon("gear")),
      ),
      this.body,
    );
    this.searchInput.addEventListener("input", () => this.render());
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.body.querySelector<HTMLElement>(".lib-row:not(.missing)");
        if (first?.dataset.path) deps.open(first.dataset.path);
      } else if (e.key === "Escape" && this.searchInput.value) {
        e.stopPropagation();
        this.searchInput.value = "";
        this.render();
      }
    });
    this.thumbObserver = new IntersectionObserver((entries) => this.loadThumbs(entries), { root: this.body, rootMargin: "200px 0px" });
  }

  focusSearch() {
    this.searchInput.focus();
    this.searchInput.select();
  }

  private setMode(m: LibraryMode) {
    this.mode = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
    this.render();
  }

  render() {
    const { history } = this.deps;
    const now = Date.now();
    for (const b of this.el.querySelectorAll<HTMLElement>(".seg")) b.classList.toggle("active", b.dataset.mode === this.mode);
    const query = this.searchInput.value.trim();
    const all = history.list();
    const n = all.length;
    this.count.textContent = n ? `${n} file${n === 1 ? "" : "s"} from the last ${this.describeMonths()}` : "";
    this.thumbObserver.disconnect();

    if (!n) {
      this.body.replaceChildren(
        h(
          "div",
          { class: "lib-empty" },
          h("div", { class: "brand" }, "Unacro"),
          h("p", {}, "Files you open will be listed here, so you can find them again by when you used them or where they live."),
          h(
            "div",
            { class: "empty-actions" },
            h("button", { class: "btn primary", onclick: () => this.deps.openDialog() }, "Open…"),
            h("button", { class: "btn plain", onclick: () => this.deps.newFromClipboard() }, "New from Clipboard"),
          ),
          h("p", { class: "muted" }, "You can also drop PDFs, images or STL models anywhere in the window."),
        ),
      );
      return;
    }

    const entries = query ? search(all, query, MAX_ROWS) : all;
    let groups: Group[];
    if (query || this.mode === "recent") {
      groups = [{ key: "all", title: "", entries: query ? entries : [...entries].sort((a, b) => b.last - a.last) }];
    } else if (this.mode === "time") groups = groupByTime(entries, now);
    else if (this.mode === "folder") groups = groupByFolder(entries);
    else groups = groupByType(entries);

    const out: HTMLElement[] = [];
    let rows = 0;
    for (const g of groups) {
      if (rows >= MAX_ROWS) break;
      const collapsed = this.collapsed.has(g.key);
      if (g.title) out.push(this.groupHeader(g, collapsed));
      if (collapsed) continue;
      const list = h("div", { class: "lib-rows" });
      for (const e of g.entries) {
        if (rows++ >= MAX_ROWS) break;
        list.append(this.row(e, now, this.mode === "folder" && !query));
      }
      out.push(list);
    }
    if (query && !entries.length) out.push(h("p", { class: "lib-none" }, `Nothing matches “${query}”.`));
    if (rows > MAX_ROWS) out.push(h("p", { class: "lib-none" }, "Showing the first 600. Search to find older files."));
    this.body.replaceChildren(...out);
    for (const t of this.body.querySelectorAll(".lib-thumb[data-path]")) this.thumbObserver.observe(t);
    void history.refreshExistence().then((changed) => changed && this.render());
  }

  private describeMonths() {
    const m = this.deps.months();
    return m >= 12 && m % 12 === 0 ? `${m / 12 === 1 ? "year" : `${m / 12} years`}` : `${m} month${m === 1 ? "" : "s"}`;
  }

  private groupHeader(g: Group, collapsed: boolean) {
    const toggle = () => {
      if (this.collapsed.has(g.key)) this.collapsed.delete(g.key);
      else this.collapsed.add(g.key);
      this.render();
    };
    const head = h(
      "div",
      { class: `lib-group${collapsed ? " collapsed" : ""}` },
      h("button", { class: "lib-group-toggle", "aria-expanded": String(!collapsed), onclick: toggle }, icon("chevron"), h("span", { class: "lib-group-title" }, g.title), h("span", { class: "lib-group-count" }, String(g.entries.length))),
    );
    if (g.detail) {
      const detail = g.detail;
      head.append(h("span", { class: "lib-group-detail", title: detail }, h("bdi", {}, detail)));
      if (this.deps.canReveal) head.append(h("button", { class: "lib-link", onclick: () => this.deps.reveal(g.entries[0].path) }, this.deps.revealLabel));
    }
    return head;
  }

  private row(e: HistoryEntry, now: number, inFolder: boolean) {
    const missing = !this.deps.history.exists(e.path);
    const open = this.deps.isOpen(e.path);
    const thumb = h("div", { class: `lib-thumb kind-${e.kind}`, dataset: { path: e.path } }, icon(e.kind === "pdf" ? "doc" : e.kind === "model" ? "cube" : "image"));
    const actions = h(
      "div",
      { class: "lib-actions" },
      this.deps.canReveal && !missing
        ? h("button", { class: "tool", title: this.deps.revealLabel, "aria-label": this.deps.revealLabel, onclick: (ev: Event) => (ev.stopPropagation(), this.deps.reveal(e.path)) }, icon("folder"))
        : null,
      h("button", { class: "tool", title: "Copy path", "aria-label": "Copy path", onclick: (ev: Event) => (ev.stopPropagation(), this.deps.copyPath(e.path)) }, icon("copy")),
      h("button", { class: "tool", title: "Remove from Library", "aria-label": "Remove from Library", onclick: (ev: Event) => (ev.stopPropagation(), this.deps.history.remove(e.path)) }, icon("x")),
    );
    const row = h(
      "div",
      {
        class: `lib-row${missing ? " missing" : ""}${open ? " is-open" : ""}`,
        role: "button",
        tabindex: "0",
        title: missing ? `${e.path} (moved or deleted)` : e.path,
        dataset: { path: e.path },
        onclick: () => !missing && this.deps.open(e.path),
        onkeydown: (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !missing) this.deps.open(e.path);
          else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            const rows = [...this.body.querySelectorAll<HTMLElement>(".lib-row")];
            rows[rows.indexOf(row) + (ev.key === "ArrowDown" ? 1 : -1)]?.focus();
          }
        },
      },
      thumb,
      h(
        "div",
        { class: "lib-text" },
        h("div", { class: "lib-name" }, e.name, open ? h("span", { class: "lib-badge" }, "open") : null, missing ? h("span", { class: "lib-badge warn" }, "moved or deleted") : null),
        inFolder ? null : h("div", { class: "lib-dir" }, h("bdi", {}, e.dir)),
      ),
      h("div", { class: "lib-meta" }, h("span", {}, relativeTime(e.last, now)), e.count > 1 ? h("span", { class: "muted" }, `${e.count}×`) : null),
      actions,
    );
    return row;
  }

  private loadThumbs(entries: IntersectionObserverEntry[]) {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target as HTMLElement;
      this.thumbObserver.unobserve(el);
      const path = el.dataset.path!;
      void this.deps.history.thumbUrl(path).then((url) => {
        if (!url || !el.isConnected) return;
        el.replaceChildren(h("img", { src: url, alt: "", loading: "lazy", draggable: "false" }));
        el.classList.add("has-img");
      });
    }
  }
}
