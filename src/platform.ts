// Everything that touches the operating system goes through here, so the same
// UI runs inside Tauri (desktop app) and in a plain browser (for development).

export interface OpenedFile {
  name: string;
  /** Real file path (desktop) or an opaque handle key (browser). Null when the file can't be written back. */
  path: string | null;
  bytes: Uint8Array;
}

import { ALL_EXTS, IMAGE_OPEN_EXTS, MODEL_EXTS, PDF_EXTS, extOf } from "./core/formats";

/** What a save dialog is for. "image" offers image formats and PDF. */
export type SaveKind = "pdf" | "md" | "image";
/** What an open dialog accepts: everything, or only things that can become pages. */
export type OpenKind = "any" | "pages";

const OPEN_FILTERS: Record<OpenKind, { name: string; extensions: string[] }[]> = {
  any: [
    { name: "All supported files", extensions: ALL_EXTS },
    { name: "PDF", extensions: PDF_EXTS },
    { name: "Images", extensions: IMAGE_OPEN_EXTS },
    { name: "3D models", extensions: MODEL_EXTS },
  ],
  pages: [
    { name: "PDFs and images", extensions: [...PDF_EXTS, ...IMAGE_OPEN_EXTS] },
    { name: "PDF", extensions: PDF_EXTS },
    { name: "Images", extensions: IMAGE_OPEN_EXTS },
  ],
};

const SAVE_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  pdf: { name: "PDF", extensions: ["pdf"] },
  md: { name: "Markdown", extensions: ["md"] },
  png: { name: "PNG image", extensions: ["png"] },
  jpg: { name: "JPEG image", extensions: ["jpg", "jpeg"] },
  tiff: { name: "TIFF image", extensions: ["tiff", "tif"] },
  bmp: { name: "BMP image", extensions: ["bmp"] },
};
const IMAGE_SAVE_EXTS = ["png", "jpg", "jpeg", "tiff", "tif", "bmp", "pdf"];

/** Save dialog filters, with the suggested file's own format first. */
function saveFilters(kind: SaveKind, suggestedName: string) {
  if (kind !== "image") return [SAVE_FILTERS[kind]];
  const ext = extOf(suggestedName);
  const first = ext === "jpeg" ? "jpg" : ext === "tif" ? "tiff" : ext;
  const order = [first, ...["png", "jpg", "tiff", "bmp", "pdf"].filter((e) => e !== first)];
  return order.filter((e) => SAVE_FILTERS[e]).map((e) => SAVE_FILTERS[e]);
}

/** Make sure a chosen path has an extension this kind of save can write. */
function withExtension(path: string, kind: SaveKind, suggestedName: string) {
  const ext = extOf(path);
  if (kind === "image") return IMAGE_SAVE_EXTS.includes(ext) ? path : `${path}.${extOf(suggestedName) || "png"}`;
  return ext === kind ? path : `${path}.${kind}`;
}

const isSupported = (name: string) => ALL_EXTS.includes(extOf(name));

export interface Platform {
  kind: "tauri" | "browser";
  pickFiles(multiple: boolean, kind?: OpenKind): Promise<OpenedFile[]>;
  readPath(path: string): Promise<OpenedFile>;
  /** Ask where to save. Returns a path/handle key, or null if cancelled. */
  pickSavePath(suggestedName: string, kind: SaveKind, nearPath?: string | null): Promise<string | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** Human-readable location for the status bar and title. */
  displayPath(path: string): string;
  baseName(path: string): string;
  canReveal: boolean;
  reveal(path: string): Promise<void>;
  initialPaths(): Promise<string[]>;
  /** Files the OS asks the running app to open (double-click, Open With, second launch). */
  onOpenPaths(handler: (paths: string[]) => void): Promise<void>;
  setTitle(title: string): void;
  /** handler resolves true if the window may close. */
  onCloseRequested(handler: () => Promise<boolean>): void;
  /** Files dropped from the file manager, with the drop point in CSS pixels. */
  onFileDrop(handler: (files: () => Promise<OpenedFile[]>, x: number, y: number) => void): void;
  /** An image on the clipboard (e.g. a screenshot) as PNG bytes, or null if there is none. */
  readClipboardImage(): Promise<Uint8Array | null>;
  /** Put an image on the clipboard so it can be pasted into other apps. */
  writeClipboardImage(canvas: HTMLCanvasElement): Promise<void>;
  /** Whether recent-file paths survive a restart. */
  persistentPaths: boolean;
}

async function rgbaToPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("Couldn't read the clipboard image.");
  return new Uint8Array(await blob.arrayBuffer());
}

export function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function baseNameOf(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function dirOf(path: string) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : null;
}

// ---------------------------------------------------------------- Tauri

async function tauriPlatform(): Promise<Platform> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const opener = await import("@tauri-apps/plugin-opener");
  const clipboard = await import("@tauri-apps/plugin-clipboard-manager");
  const win = getCurrentWindow();

  const readPath = async (path: string): Promise<OpenedFile> => {
    const data = await invoke<ArrayBuffer>("read_file", { path });
    return { name: baseNameOf(path), path, bytes: new Uint8Array(data) };
  };

  return {
    kind: "tauri",
    persistentPaths: true,
    canReveal: true,
    async pickFiles(multiple, kind = "any") {
      const picked = await dialog.open({ multiple, filters: OPEN_FILTERS[kind] });
      if (!picked) return [];
      const paths = Array.isArray(picked) ? picked : [picked];
      return Promise.all(paths.map(readPath));
    },
    readPath,
    async pickSavePath(suggestedName, kind, nearPath) {
      const dir = nearPath ? dirOf(nearPath) : null;
      const defaultPath = dir ? `${dir}/${suggestedName}` : suggestedName;
      const path = await dialog.save({ defaultPath, filters: saveFilters(kind, suggestedName) });
      return path ? withExtension(path, kind, suggestedName) : null;
    },
    async write(path, data) {
      await invoke("write_file", data, { headers: { "x-path": encodeURIComponent(path) } });
    },
    displayPath: (p) => p,
    baseName: baseNameOf,
    reveal: (p) => opener.revealItemInDir(p),
    initialPaths: () => invoke<string[]>("initial_paths"),
    async writeClipboardImage(canvas) {
      const { Image } = await import("@tauri-apps/api/image");
      const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      const image = await Image.new(new Uint8Array(data.buffer), canvas.width, canvas.height);
      try {
        await clipboard.writeImage(image);
      } finally {
        void image.close();
      }
    },
    async readClipboardImage() {
      let image;
      try {
        image = await clipboard.readImage();
      } catch {
        return null; // nothing image-like on the clipboard
      }
      const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
      return rgbaToPng(rgba, width, height);
    },
    async onOpenPaths(handler) {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<string[]>("open-files", (e) => handler(e.payload));
    },
    setTitle: (t) => void win.setTitle(t),
    onCloseRequested(handler) {
      void win.onCloseRequested(async (event) => {
        if (!(await handler())) event.preventDefault();
      });
    },
    onFileDrop(handler) {
      void getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        const files = paths.filter(isSupported);
        if (!files.length) return;
        const ratio = window.devicePixelRatio || 1;
        handler(() => Promise.all(files.map(readPath)), position.x / ratio, position.y / ratio);
      });
    },
  };
}

// ---------------------------------------------------------------- Browser

type Handle = FileSystemFileHandle;
const handles = new Map<string, Handle>();
let handleCounter = 0;
function keepHandle(h: Handle) {
  for (const [k, v] of handles) if (v === h) return k;
  const key = `handle:${++handleCounter}:${h.name}`;
  handles.set(key, h);
  return key;
}

const hasFsAccess = typeof window !== "undefined" && "showOpenFilePicker" in window;

function inputPick(multiple: boolean, accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

async function fileToOpened(file: File, path: string | null): Promise<OpenedFile> {
  return { name: file.name, path, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function browserPlatform(): Platform {
  return {
    kind: "browser",
    persistentPaths: false,
    canReveal: false,
    async pickFiles(multiple, kind = "any") {
      const exts = OPEN_FILTERS[kind][0].extensions.map((e) => `.${e}`);
      if (hasFsAccess) {
        try {
          const hs: Handle[] = await (window as any).showOpenFilePicker({
            multiple,
            types: [{ description: OPEN_FILTERS[kind][0].name, accept: { "application/octet-stream": exts } }],
          });
          return Promise.all(hs.map(async (h) => fileToOpened(await h.getFile(), keepHandle(h))));
        } catch (e: any) {
          if (e?.name === "AbortError") return [];
          throw e;
        }
      }
      const files = await inputPick(multiple, exts.join(","));
      return Promise.all(files.map((f) => fileToOpened(f, null)));
    },
    async readPath(path) {
      const h = handles.get(path);
      if (!h) throw new Error("That file is no longer available in this browser session.");
      return fileToOpened(await h.getFile(), path);
    },
    async pickSavePath(suggestedName, kind) {
      if (hasFsAccess) {
        try {
          const h: Handle = await (window as any).showSaveFilePicker({
            suggestedName,
            types: saveFilters(kind, suggestedName).map((f) => ({
              description: f.name,
              accept: { "application/octet-stream": f.extensions.map((e) => `.${e}`) },
            })),
          });
          return keepHandle(h);
        } catch (e: any) {
          if (e?.name === "AbortError") return null;
          throw e;
        }
      }
      return `download:${suggestedName}`;
    },
    async write(path, data) {
      if (path.startsWith("download:")) {
        const name = path.slice("download:".length);
        const type = name.endsWith(".md") ? "text/markdown" : name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return;
      }
      const h = handles.get(path);
      if (!h) throw new Error("No file handle to write to.");
      const w = await (h as any).createWritable();
      await w.write(data);
      await w.close();
    },
    displayPath: (p) => (p.startsWith("handle:") ? p.split(":").slice(2).join(":") : p.replace(/^download:/, "")),
    baseName: (p) => baseNameOf(p.startsWith("handle:") ? p.split(":").slice(2).join(":") : p.replace(/^download:/, "")),
    async reveal() {},
    async initialPaths() {
      return [];
    },
    async onOpenPaths() {},
    async writeClipboardImage(canvas) {
      const blob = new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the image."))), "image/png"),
      );
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    },
    async readClipboardImage() {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        if (type === "image/png") return new Uint8Array(await blob.arrayBuffer());
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        return rgbaToPng(new Uint8Array(data.buffer), c.width, c.height);
      }
      return null;
    },
    setTitle: (t) => (document.title = t),
    onCloseRequested(handler) {
      // Browsers only allow a generic prompt; ask it whenever there are unsaved changes.
      window.addEventListener("beforeunload", (e) => {
        void handler; // the app sets window.__unacroDirty
        if ((window as any).__unacroDirty) e.preventDefault();
      });
    },
    onFileDrop(handler) {
      window.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      });
      window.addEventListener("drop", (e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        const items = [...e.dataTransfer.items].filter((i) => i.kind === "file");
        const files = [...e.dataTransfer.files];
        // Grab handles synchronously-ish so files can be saved back in place where supported.
        const handlePromises = items.map((i) =>
          "getAsFileSystemHandle" in i ? (i as any).getAsFileSystemHandle().catch(() => null) : Promise.resolve(null),
        );
        handler(
          async () => {
            const hs: (Handle | null)[] = await Promise.all(handlePromises);
            const out: OpenedFile[] = [];
            for (let i = 0; i < files.length; i++) {
              const f = files[i];
              if (!isSupported(f.name) && f.type !== "application/pdf") continue;
              const h = hs[i];
              out.push(await fileToOpened(f, h && h.kind === "file" ? keepHandle(h) : null));
            }
            return out;
          },
          e.clientX,
          e.clientY,
        );
      });
    },
  };
}

export async function createPlatform(): Promise<Platform> {
  if ((window as any).__TAURI_INTERNALS__) return tauriPlatform();
  return browserPlatform();
}
