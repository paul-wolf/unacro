// Quick switcher (Ctrl/Cmd+P): type a few letters of a file you've used, press Enter.

import { fuzzyScore, relativeTime, splitPath, type HistoryEntry } from "../core/history";
import { h, icon } from "./dom";

export interface SwitcherItem {
  /** Open documents have an id; history-only files don't. */
  docId?: string;
  path: string | null;
  name: string;
  dir: string;
  last: number;
  kind: HistoryEntry["kind"];
}

let openSwitcher: (() => void) | null = null;

export function showSwitcher(items: SwitcherItem[], choose: (item: SwitcherItem) => void) {
  if (openSwitcher) return openSwitcher();
  const input = h("input", { class: "sw-input", type: "text", placeholder: "Go to file…", "aria-label": "Go to file", spellcheck: "false" });
  const list = h("div", { class: "sw-list", role: "listbox" });
  const panel = h("div", { class: "switcher", role: "dialog", "aria-label": "Go to file" }, h("div", { class: "sw-head" }, icon("search"), input), list);
  const backdrop = h("div", { class: "sw-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, panel);
  let results: SwitcherItem[] = [];
  let sel = 0;
  const now = Date.now();

  const update = () => {
    const q = input.value.trim();
    const scored = items
      .map((it) => ({ it, s: q ? fuzzyScore(q, it.name, it.dir) : 0 }))
      .filter((x) => x.s >= 0)
      // Open files first when there's no query; otherwise best match, then most recent.
      .sort((a, b) => (q ? b.s - a.s : Number(!!b.it.docId) - Number(!!a.it.docId)) || b.it.last - a.it.last);
    results = scored.slice(0, 14).map((x) => x.it);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.replaceChildren(
      ...results.map((it, i) =>
        h(
          "div",
          { class: `sw-item${i === sel ? " selected" : ""}`, role: "option", "aria-selected": String(i === sel), onmousedown: (e: MouseEvent) => (e.preventDefault(), pick(i)) },
          icon(it.kind === "pdf" ? "doc" : it.kind === "model" ? "cube" : it.kind === "markdown" ? "md" : "image"),
          h("span", { class: "sw-name" }, it.name),
          h("span", { class: "sw-dir" }, h("bdi", {}, it.dir || "not saved yet")),
          h("span", { class: "sw-meta" }, it.docId ? "open" : relativeTime(it.last, now)),
        ),
      ),
      ...(results.length ? [] : [h("div", { class: "sw-none" }, "No matching files")]),
    );
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  };
  const pick = (i: number) => {
    const it = results[i];
    if (!it) return;
    close();
    choose(it);
  };
  const close = () => {
    openSwitcher = null;
    backdrop.remove();
  };
  input.addEventListener("input", () => {
    sel = 0;
    update();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(1, results.length);
      update();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  openSwitcher = () => input.focus();
  document.body.append(backdrop);
  update();
  input.focus();
}

export function isSwitcherOpen() {
  return !!document.querySelector(".sw-backdrop");
}

export { splitPath };
