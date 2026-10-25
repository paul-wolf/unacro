// Pure helpers for Markdown documents (no DOM): front matter, where an image
// reference points, and the paper size to print on. Kept separate so they can be
// unit-tested.

export interface FrontMatter {
  /** The Markdown without its front matter block. */
  body: string;
  /** `title:` from the front matter, if there is one. */
  title: string | null;
}

/** Split off a leading YAML front matter block (`---` … `---` or `...`). */
export function splitFrontMatter(text: string): FrontMatter {
  const src = text.replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { body: src, title: null };
  let title: string | null = null;
  const t = /^title[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(m[1]);
  if (t) {
    title = t[1].replace(/^(['"])(.*)\1$/, "$2").trim() || null;
  }
  return { body: src.slice(m[0].length), title };
}

export type ImageRef =
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string }
  | { kind: "unsupported"; reason: string };

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif);/i;

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function dirOf(path: string) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : "";
}

/** Join and normalise a relative path onto a folder, keeping the folder's separator style. */
export function joinPath(dir: string, rel: string): string {
  const win = /^[A-Za-z]:/.test(dir) || dir.startsWith("\\\\");
  let prefix: string;
  let rest: string;
  if (dir.startsWith("\\\\")) [prefix, rest] = ["\\\\", dir.slice(2)];
  else if (win) [prefix, rest] = [`${dir.slice(0, 2)}\\`, dir.slice(2)];
  else [prefix, rest] = [dir.startsWith("/") ? "/" : "", dir];
  const out = rest.split(/[\\/]/).filter((p) => p);
  for (const p of rel.split(/[\\/]/)) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return prefix + out.join(win ? "\\" : "/");
}

/**
 * Work out what an image `src` in a Markdown file refers to.
 * `mdPath` is the Markdown file's own path (null for an unsaved document).
 */
export function resolveImageRef(src: string, mdPath: string | null): ImageRef {
  const s = src.trim();
  if (!s) return { kind: "unsupported", reason: "empty address" };
  if (DATA_IMAGE.test(s)) return { kind: "data", url: s };
  if (/^data:/i.test(s)) return { kind: "unsupported", reason: "not an image" };
  if (/^https?:\/\//i.test(s)) return { kind: "remote", url: s };
  if (/^\/\//.test(s)) return { kind: "remote", url: `https:${s}` };
  if (/^file:/i.test(s)) {
    // file:///home/x/a.png, file:///C:/x/a.png, file://localhost/x
    const m = /^file:\/\/(localhost)?(\/.*)$/i.exec(s);
    if (!m) return { kind: "unsupported", reason: "file address on another computer" };
    let p = safeDecode(m[2].split(/[?#]/)[0]);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, "\\");
    return { kind: "local", path: p };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) {
    return { kind: "unsupported", reason: `“${s.split(":")[0]}:” addresses aren't supported` };
  }
  // A plain path. Markdown paths are URL-ish: %20 means a space, and ?/# end the path.
  const path = safeDecode(s.split(/[?#]/)[0]);
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return { kind: "local", path };
  if (path.startsWith("~/")) return { kind: "unsupported", reason: "“~” paths aren't supported; use a relative path" };
  if (!mdPath) return { kind: "unsupported", reason: "the document has no folder yet" };
  return { kind: "local", path: joinPath(dirOf(mdPath), path) };
}

export type Paper = "a4" | "letter";

/** Countries that use US Letter paper; everywhere else uses A4. */
const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH", "CL", "CO", "VE", "PR", "GT", "CR", "PA", "DO", "SV", "NI", "HN", "BZ"]);

/** The default paper for a locale like "en-US" or "uk-UA". */
export function paperForLocale(locale: string | undefined): Paper {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale ?? "")?.[1]?.toUpperCase();
  return region && LETTER_REGIONS.has(region) ? "letter" : "a4";
}

/** Page size in points. */
export const PAPER_SIZE: Record<Paper, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

/** Page margin in points (19 mm, roughly ¾ inch), on every side. */
export const PAGE_MARGIN = 54;

/** The text of the first level-1 heading, for a PDF title when there's no front matter title. */
export function firstHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].replace(/[*_`]/g, "").trim() || null;
  }
  return null;
}
