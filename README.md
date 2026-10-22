# Unacro

**Un-Acrobat your PDFs.** Unacro is a small, fast, open-source viewer for PDFs, screenshots, images and STL models, with the everyday jobs built in: combine, reorder, sign, convert, and export to Markdown. Think macOS Preview, but on Linux too, and with file handling that always tells you where your file is. Linux first, also macOS and Windows. MIT licensed.

See [GOALS.md](GOALS.md) for what Unacro is (and deliberately isn't).

## Features

- **View**: PDFs, images (JPEG, PNG, GIF, HEIC, TIFF, BMP) and STL 3D models, with continuous scrolling, zoom, page thumbnails, text selection and find (`Ctrl+F`)
- **Screenshots**: New from Clipboard (`Ctrl+N`) opens the image on your clipboard as a new document
- **Images**: rotate, sign, then save back in the same format, or export as PDF. Multi-page TIFFs open as several pages. HEIC works on macOS.
- **Combine**: turn several PDFs and images into one new PDF, insert pages from another PDF or an image anywhere, copy pages between open documents (drag thumbnails onto another tab, or `Ctrl+C` / `Ctrl+V`)
- **Organize**: drag to reorder, rotate, delete, multi-select with `Shift` / `Ctrl`, open a selection as a new document
- **Sign**: draw your signature once (or import a photo/scan of it), then click to place it, drag to move, resize from the corner
- **Markdown**: export or copy a document as Markdown, with headings, paragraphs and lists inferred from the layout
- **3D models**: STL viewer with rotate, pan, zoom, size and triangle count
- **Proper file handling**: Save, Save As (the document then lives at the new location), Save a Copy, no autosave, atomic writes, full path in the status bar with "Show in Folder", unsaved-changes prompts, recent files, one window with tabs

## Keyboard

| Action | Shortcut |
| --- | --- |
| New from Clipboard | `Ctrl+N` |
| Open / Save / Save As | `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Close tab / switch tabs | `Ctrl+W` / `Ctrl+Tab`, `Ctrl+PageDown`, `Ctrl+PageUp` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` |
| Rotate right / left | `Ctrl+R` / `Ctrl+L` |
| Delete selected pages | `Delete` (with the sidebar focused) |
| Copy / paste pages | `Ctrl+C` / `Ctrl+V` (with the sidebar focused) |
| Select all pages | `Ctrl+A` (with the sidebar focused) |
| Zoom in / out / fit (or reset a 3D view) | `Ctrl++` / `Ctrl+-` / `Ctrl+0`, or `Ctrl` + scroll |
| Find | `Ctrl+F`, then `Enter` / `Shift+Enter` |

On macOS, use `⌘` instead of `Ctrl`.

## Building

You need [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs), plus Tauri's system libraries ([prerequisites](https://v2.tauri.app/start/prerequisites/)). On Debian/Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # build installers (.deb, .rpm, .AppImage on Linux; .app/.dmg on macOS)
```

You can also open files from the command line: `unacro a.pdf b.pdf`.

### Opening PDFs from Finder or your file manager

Installed builds register Unacro as an app that can open PDFs, images (JPEG, PNG, GIF, HEIC, TIFF, BMP) and STL models. Double-clicking, "Open With → Unacro" and dropping files on the app icon all open the file as a new tab in the running window. If Unacro isn't running, it starts. Unacro registers as an *alternate* app for these types, so it won't take over from your current defaults. To make it the default for a type:

- **macOS:** select a file of that type in Finder, press `⌘I`, choose Unacro under "Open with", then click "Change All…".
- **Linux:** right-click a file, choose "Open With…" and pick Unacro (most file managers offer a "set as default" option there), or run e.g. `xdg-mime default unacro.desktop application/pdf image/png`.

File associations only exist in an installed build (`npm run tauri build`), not in `npm run tauri dev`. On macOS, copy `src-tauri/target/release/bundle/macos/Unacro.app` to Applications.

For quick UI work without the desktop shell, `npm run dev` serves the same UI at http://localhost:1420 in a browser (Chromium recommended). In the browser, Save works through the browser's file picker or falls back to a download.

Tests:

```sh
npm test                      # PDF building and Markdown conversion
cd src-tauri && cargo test    # native file writing
```

## How it's built

| Part | Library | License |
| --- | --- | --- |
| Desktop shell | [Tauri 2](https://tauri.app) | MIT / Apache-2.0 |
| Rendering, text, search | [PDF.js](https://mozilla.github.io/pdf.js/) | Apache-2.0 |
| Combining, rotating, signing, saving | [pdf-lib](https://pdf-lib.js.org) | MIT |
| TIFF reading and writing | [UTIF.js](https://github.com/photopea/UTIF.js) | MIT |
| 3D viewer (loaded only for STL files) | [three.js](https://threejs.org) | MIT |

The UI is plain TypeScript with no framework.

- `src/core/`: the document model, PDF building (`build.ts`) and PDF-to-Markdown (`markdown.ts`). No DOM, unit-tested in Node.
- `src/app.ts`: tabs, sidebar, viewer, signatures, menus, keyboard.
- `src/platform.ts`: everything that touches the operating system (desktop vs. browser).
- `src-tauri/`: the native side. It only reads files, writes them atomically, and passes on files the operating system asks it to open.

Images are opened as one-page documents (wrapped in an in-memory PDF), so every page feature works on them too. The original pixels are kept, and saving an edited image draws it again at full resolution with rotation and signatures applied. An unchanged image is never rewritten.

Edits are never applied to your file directly. A document is a list of page references (source file + page number + rotation + signatures). Saving builds a new PDF from that list and writes it to a temporary file that is then renamed over the target. When most pages come from one file, that file is used as the base, so its bookmarks, form fields and metadata are kept.

## Privacy

Unacro makes no network requests. Saved signatures are stored locally on your machine.

## License

[MIT](LICENSE)
