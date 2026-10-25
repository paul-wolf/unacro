// The file history on disk (history.json and small thumbnails in Unacro's data
// folder), plus the user's settings. See core/history.ts for the pure logic.

import { MONTH_MS, pathKey, prune, record, type HistoryEntry, type HistoryFile, type HistoryKind } from "./core/history";
import { MARKDOWN_EXTS, extOf } from "./core/formats";
import type { Platform } from "./platform";

// ------------------------------------------------------------------ settings

export interface Settings {
  /** Most files kept open; the least recently used beyond this close by themselves. */
  maxTabs: number;
  /** How long files stay in the history. */
  historyMonths: number;
}

const SETTINGS_KEY = "unacro.settings";
export const DEFAULT_SETTINGS: Settings = { maxTabs: 12, historyMonths: 6 };

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return {
      maxTabs: Number.isInteger(s.maxTabs) && s.maxTabs >= 1 ? s.maxTabs : DEFAULT_SETTINGS.maxTabs,
      historyMonths: Number.isFinite(s.historyMonths) && s.historyMonths > 0 ? s.historyMonths : DEFAULT_SETTINGS.historyMonths,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ history

const HISTORY_FILE = "history.json";
const THUMBS = "thumbs";

export function kindOfPath(path: string): HistoryKind {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext === "stl") return "model";
  if (MARKDOWN_EXTS.includes(ext)) return "markdown";
  return "image";
}

export class HistoryStore {
  private entries = new Map<string, HistoryEntry>();
  private saveTimer = 0;
  private thumbUrls = new Map<string, Promise<string | null>>();
  private existence = new Map<string, boolean>();
  private existenceCheckedAt = 0;
  /** Called (debounced) whenever the history changes. */
  onChange: (() => void) | null = null;
  private changeTimer = 0;

  constructor(private platform: Platform, private months: () => number) {}

  async load() {
    try {
      const bytes = await this.platform.dataRead(HISTORY_FILE);
      if (bytes) {
        const file = JSON.parse(new TextDecoder().decode(bytes)) as HistoryFile;
        for (const e of prune(file.entries ?? [], this.months(), Date.now())) this.entries.set(e.path, e);
      }
    } catch (e) {
      console.warn("Couldn't read the file history", e);
    }
    this.importOldRecentList();
  }

  /** Earlier versions kept a plain recent-files list; fold it into the history once. */
  private importOldRecentList() {
    try {
      const raw = localStorage.getItem("unacro.recent");
      if (!raw) return;
      const paths: string[] = JSON.parse(raw);
      const now = Date.now();
      paths.forEach((p, i) => {
        if (!this.entries.has(p)) record(this.entries, p, kindOfPath(p), now - (i + 1) * 60_000, true);
      });
      localStorage.removeItem("unacro.recent");
      this.changed();
    } catch {
      /* nothing to import */
    }
  }

  list(): HistoryEntry[] {
    return [...this.entries.values()];
  }

  get(path: string) {
    return this.entries.get(path);
  }

  get size() {
    return this.entries.size;
  }

  /** A file was opened (`opened`) or just looked at again. */
  record(path: string, kind: HistoryKind, opened: boolean) {
    if (path.startsWith("download:")) return;
    record(this.entries, path, kind, Date.now(), opened);
    this.existence.set(path, true);
    this.changed();
  }

  remove(path: string) {
    this.entries.delete(path);
    this.thumbUrls.delete(path);
    void this.platform.dataDelete(`${THUMBS}/${pathKey(path)}.jpg`).catch(() => {});
    this.changed();
  }

  async clear() {
    this.entries.clear();
    for (const u of this.thumbUrls.values()) void u.then((url) => url && URL.revokeObjectURL(url));
    this.thumbUrls.clear();
    await this.platform.dataDelete(THUMBS).catch(() => {});
    this.changed();
  }

  /** Apply a new retention period. */
  prune() {
    const kept = prune(this.list(), this.months(), Date.now());
    if (kept.length === this.entries.size) return;
    const keep = new Set(kept.map((e) => e.path));
    for (const p of [...this.entries.keys()]) if (!keep.has(p)) this.remove(p);
    this.changed();
  }

  private changed() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 800);
    clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => this.onChange?.(), 50);
  }

  async save() {
    clearTimeout(this.saveTimer);
    const file: HistoryFile = { version: 1, entries: this.list().sort((a, b) => b.last - a.last) };
    try {
      await this.platform.dataWrite(HISTORY_FILE, new TextEncoder().encode(JSON.stringify(file)));
    } catch (e) {
      console.warn("Couldn't save the file history", e);
    }
  }

  // -------------------------------------------------------------- thumbnails

  async setThumb(path: string, canvas: HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.78));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const old = this.thumbUrls.get(path);
    this.thumbUrls.set(path, Promise.resolve(URL.createObjectURL(blob)));
    void old?.then((u) => u && URL.revokeObjectURL(u));
    await this.platform.dataWrite(`${THUMBS}/${pathKey(path)}.jpg`, bytes).catch(() => {});
  }

  thumbUrl(path: string): Promise<string | null> {
    let u = this.thumbUrls.get(path);
    if (!u) {
      u = this.platform
        .dataRead(`${THUMBS}/${pathKey(path)}.jpg`)
        .then((b) => (b ? URL.createObjectURL(new Blob([b as BlobPart], { type: "image/jpeg" })) : null))
        .catch(() => null);
      this.thumbUrls.set(path, u);
    }
    return u;
  }

  // -------------------------------------------------------------- moved or deleted files

  exists(path: string): boolean {
    return this.existence.get(path) ?? true;
  }

  /** Check which files still exist (at most every 20 s unless forced). Returns true if anything changed. */
  async refreshExistence(force = false): Promise<boolean> {
    if (!force && Date.now() - this.existenceCheckedAt < 20_000) return false;
    this.existenceCheckedAt = Date.now();
    const paths = this.list().map((e) => e.path);
    if (!paths.length) return false;
    let result: boolean[];
    try {
      result = await this.platform.pathsExist(paths);
    } catch {
      return false;
    }
    let changed = false;
    paths.forEach((p, i) => {
      if (this.existence.get(p) !== result[i]) changed = true;
      this.existence.set(p, result[i]);
    });
    return changed;
  }

  /** For the Settings dialog. */
  static describeMonths(m: number) {
    return m >= 12 && m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} month${m === 1 ? "" : "s"}`;
  }

  static readonly MONTH_MS = MONTH_MS;
}
