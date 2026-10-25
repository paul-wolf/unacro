// File history: every file opened, when, and how often. Pure logic (no DOM), so it
// can be unit-tested: recording, pruning, grouping for the Library views, and the
// fuzzy matching behind the quick switcher.

export type HistoryKind = "pdf" | "image" | "model" | "markdown";

export interface HistoryEntry {
  path: string;
  name: string;
  dir: string;
  kind: HistoryKind;
  /** First and last time it was opened or viewed (ms since epoch). */
  first: number;
  last: number;
  /** How many times it was opened. */
  count: number;
}

export interface HistoryFile {
  version: 1;
  entries: HistoryEntry[];
}

export function splitPath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? { name: path.slice(i + 1), dir: path.slice(0, i) || path.slice(0, 1) } : { name: path, dir: "" };
}

/** Stable short key for a path, used to name its thumbnail file. FNV-1a, 2 × 32 bits. */
export function pathKey(path: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ path.length;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export const MONTH_MS = 30.44 * 24 * 3600 * 1000;

/** Drop entries not touched within `months`. */
export function prune(entries: HistoryEntry[], months: number, now: number): HistoryEntry[] {
  const cutoff = now - months * MONTH_MS;
  return entries.filter((e) => e.last >= cutoff);
}

/** Add an open (count + 1) or a view (just "last") of a file. */
export function record(entries: Map<string, HistoryEntry>, path: string, kind: HistoryKind, now: number, opened: boolean) {
  const existing = entries.get(path);
  if (existing) {
    existing.last = now;
    existing.kind = kind;
    if (opened) existing.count += 1;
    return existing;
  }
  const entry: HistoryEntry = { path, ...splitPath(path), kind, first: now, last: now, count: 1 };
  entries.set(path, entry);
  return entry;
}

// ------------------------------------------------------------------ grouping

export interface Group {
  key: string;
  title: string;
  /** Optional second line, e.g. a folder's full path. */
  detail?: string;
  entries: HistoryEntry[];
}

const byLast = (a: HistoryEntry, b: HistoryEntry) => b.last - a.last;

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Time buckets, finest for recent things: last 5 minutes, last hour, each earlier
 * hour of today, yesterday, each day of the last week, then each month.
 */
export function timeBucket(t: number, now: number): { key: string; title: string } {
  const age = now - t;
  if (age < 5 * 60_000) return { key: "m5", title: "Last 5 minutes" };
  if (age < 60 * 60_000) return { key: "h1", title: "Last hour" };
  const today = startOfDay(now);
  const date = new Date(t);
  if (t >= today) {
    const h = date.getHours();
    return { key: `today-${h}`, title: `Today, ${pad(h)}:00–${pad(h + 1 === 24 ? 0 : h + 1)}:00` };
  }
  const day = startOfDay(t);
  const daysAgo = Math.round((today - day) / 86_400_000);
  if (daysAgo === 1) return { key: "yesterday", title: "Yesterday" };
  if (daysAgo < 7) {
    return { key: `day-${day}`, title: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) };
  }
  const month = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return {
    key: `month-${month}`,
    title: date.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" }),
  };
}

export function groupByTime(entries: HistoryEntry[], now: number): Group[] {
  const groups = new Map<string, Group>();
  for (const e of [...entries].sort(byLast)) {
    const b = timeBucket(e.last, now);
    let g = groups.get(b.key);
    if (!g) groups.set(b.key, (g = { key: b.key, title: b.title, entries: [] }));
    g.entries.push(e);
  }
  return [...groups.values()];
}

/** Folders, most recently used first; files in each folder newest first. */
export function groupByFolder(entries: HistoryEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const e of [...entries].sort(byLast)) {
    let g = groups.get(e.dir);
    if (!g) groups.set(e.dir, (g = { key: `dir-${e.dir}`, title: splitPath(e.dir).name || e.dir, detail: e.dir, entries: [] }));
    g.entries.push(e);
  }
  return [...groups.values()];
}

export function isScreenshot(e: HistoryEntry) {
  return e.kind === "image" && /^(screenshot|screen shot|bildschirmfoto|capture|снимок экрана|знімок екрана)/i.test(e.name);
}

export function groupByType(entries: HistoryEntry[]): Group[] {
  const order: [string, string, (e: HistoryEntry) => boolean][] = [
    ["pdf", "PDFs", (e) => e.kind === "pdf"],
    ["screenshot", "Screenshots", isScreenshot],
    ["image", "Images", (e) => e.kind === "image" && !isScreenshot(e)],
    ["markdown", "Markdown", (e) => e.kind === "markdown"],
    ["model", "3D models", (e) => e.kind === "model"],
  ];
  const sorted = [...entries].sort(byLast);
  return order
    .map(([key, title, test]) => ({ key, title, entries: sorted.filter(test) }))
    .filter((g) => g.entries.length);
}

// ------------------------------------------------------------------ fuzzy matching

/**
 * Score how well `query` matches a file (higher is better), or -1 for no match.
 * Every query character must appear in order. Matches in the file name beat matches
 * in the folder; consecutive characters and word starts score extra.
 */
export function fuzzyScore(query: string, name: string, dir: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const scoreIn = (text: string) => {
    const t = text.toLowerCase();
    let score = 0, ti = 0, prev = -2;
    for (const ch of q) {
      const i = t.indexOf(ch, ti);
      if (i < 0) return -1;
      score += 1;
      if (i === prev + 1) score += 3;
      if (i === 0 || /[\s._\-/\\()]/.test(t[i - 1])) score += 2;
      prev = i;
      ti = i + 1;
    }
    return score - (t.length - q.length) * 0.01;
  };
  const inName = scoreIn(name);
  if (inName >= 0) return inName + 10 + (name.toLowerCase().startsWith(q) ? 5 : 0);
  return scoreIn(`${dir}/${name}`);
}

export function search(entries: HistoryEntry[], query: string, limit = 50): HistoryEntry[] {
  if (!query.trim()) return [...entries].sort(byLast).slice(0, limit);
  return entries
    .map((e) => ({ e, s: fuzzyScore(query, e.name, e.dir) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.e.last - a.e.last)
    .slice(0, limit)
    .map((x) => x.e);
}

/** "just now", "12 min ago", "3 h ago", "yesterday 14:05", "Mon 14:05", "12 Sep". */
export function relativeTime(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = startOfDay(now);
  if (t >= today) return `${Math.floor(s / 3600)} h ago`;
  const daysAgo = Math.round((today - startOfDay(t)) / 86_400_000);
  if (daysAgo === 1) return `yesterday ${hm}`;
  if (daysAgo < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
