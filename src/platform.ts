// Everything that touches the operating system goes through here, so the same
// UI runs inside Tauri (desktop app) and in a plain browser (for development).

export interface OpenedFile {
  name: string;
  /** Real file path (desktop) or an opaque handle key (browser). Null when the file can't be written back. */
  path: string | null;
  bytes: Uint8Array;
}

export type FileKind = "pdf" | "md";

export interface Platform {
  kind: "tauri" | "browser";
  pickPdfs(multiple: boolean): Promise<OpenedFile[]>;
  readPath(path: string): Promise<OpenedFile>;
  /** Ask where to save. Returns a path/handle key, or null if cancelled. */
  pickSavePath(suggestedName: string, kind: FileKind, nearPath?: string | null): Promise<string | null>;
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
  /** Whether recent-file paths survive a restart. */
  persistentPaths: boolean;
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
  const win = getCurrentWindow();

  const readPath = async (path: string): Promise<OpenedFile> => {
    const data = await invoke<ArrayBuffer>("read_file", { path });
    return { name: baseNameOf(path), path, bytes: new Uint8Array(data) };
  };

  return {
    kind: "tauri",
    persistentPaths: true,
    canReveal: true,
    async pickPdfs(multiple) {
      const picked = await dialog.open({ multiple, filters: [{ name: "PDF", extensions: ["pdf", "PDF"] }] });
      if (!picked) return [];
      const paths = Array.isArray(picked) ? picked : [picked];
      return Promise.all(paths.map(readPath));
    },
    readPath,
    async pickSavePath(suggestedName, kind, nearPath) {
      const dir = nearPath ? dirOf(nearPath) : null;
      const defaultPath = dir ? `${dir}/${suggestedName}` : suggestedName;
      const filters = kind === "pdf" ? [{ name: "PDF", extensions: ["pdf"] }] : [{ name: "Markdown", extensions: ["md"] }];
      const path = await dialog.save({ defaultPath, filters });
      if (!path) return null;
      const ext = kind === "pdf" ? ".pdf" : ".md";
      return path.toLowerCase().endsWith(ext) ? path : path + ext;
    },
    async write(path, data) {
      await invoke("write_file", data, { headers: { "x-path": encodeURIComponent(path) } });
    },
    displayPath: (p) => p,
    baseName: baseNameOf,
    reveal: (p) => opener.revealItemInDir(p),
    initialPaths: () => invoke<string[]>("initial_paths"),
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
        const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
        if (!pdfs.length) return;
        const ratio = window.devicePixelRatio || 1;
        handler(() => Promise.all(pdfs.map(readPath)), position.x / ratio, position.y / ratio);
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
    async pickPdfs(multiple) {
      if (hasFsAccess) {
        try {
          const hs: Handle[] = await (window as any).showOpenFilePicker({
            multiple,
            types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
          });
          return Promise.all(hs.map(async (h) => fileToOpened(await h.getFile(), keepHandle(h))));
        } catch (e: any) {
          if (e?.name === "AbortError") return [];
          throw e;
        }
      }
      const files = await inputPick(multiple, "application/pdf,.pdf");
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
            types:
              kind === "pdf"
                ? [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }]
                : [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
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
        const type = name.endsWith(".md") ? "text/markdown" : "application/pdf";
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
              if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") continue;
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
