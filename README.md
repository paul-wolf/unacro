# Unacro

**Un-Acrobat your PDFs.** Unacro is a small, fast, open-source viewer for PDFs, screenshots, images and STL models, with the everyday jobs built in: combine, reorder, sign, convert, and export to Markdown. Think macOS Preview, but on Linux too, and with file handling that always tells you where your file is. Linux first, also macOS and Windows. MIT licensed.

See [GOALS.md](GOALS.md) for what Unacro is (and deliberately isn't).

## Features

- **View**: PDFs, images (JPEG, PNG, GIF, HEIC, TIFF, BMP) and STL 3D models, with continuous scrolling, zoom, page thumbnails, text selection and find (`Ctrl+F`)
- **Screenshots**: New from Clipboard (`Ctrl+N`) opens the image on your clipboard as a new document. Mark it up, press `Ctrl+C`, and paste it anywhere, with no saving needed. A copied screenshot closes without a "Save changes?" prompt.
- **Convert**: open any image or page as JPEG, PNG, TIFF or BMP (or images as a PDF) in a new tab, then save it next to the original. JPEG quality is set once (default 85%) under Convert → JPEG Quality, which shows the resulting file size. Saving an untouched image in its own format copies it byte for byte, so nothing is recompressed and its metadata survives.
- **Crop**: drag a box (crop tool in the markup bar, or `C`), adjust it, press Enter. Works on images and PDF pages, with rotation and markup, and can be undone. "Remove Crop" is on the page's right-click menu.
- **Callouts**: a rounded, outlined box with your text, joined by a straight line to a dot on what it points at (tool `T`). Click the spot (or drag from it to where the text should go) and type. Drag the box or the dot, widen the box, and double-click to edit the text. Any language works, Cyrillic included.
- **Markup**: rectangles, ovals and arrows in 8 colours and 3 line widths, from the markup bar above the image (shown automatically for images, toggled with **Markup** for PDFs). Shapes stay editable until you save, then become part of the file.
- **Images**: rotate, sign, then save back in the same format, or export as PDF. Multi-page TIFFs open as several pages. HEIC works on macOS.
- **Combine**: turn several PDFs and images into one new PDF, insert pages from another PDF or an image anywhere, copy pages between open documents (drag thumbnails onto another tab, or `Ctrl+C` / `Ctrl+V`)
- **Organize**: drag to reorder, rotate, delete, multi-select with `Shift` / `Ctrl`, open a selection as a new document
- **Sign**: draw your signature once (or import a photo/scan of it), then click to place it, drag to move, resize from the corner
- **Markdown**: export or copy a document as Markdown, with headings, paragraphs and lists inferred from the layout
- **3D models**: STL viewer with rotate, pan, zoom, size and triangle count
- **Library**: every file you've opened in the last 6 months (configurable), as the first tab. View it as a recent list, a timeline (last 5 minutes, last hour, each hour of today, yesterday, each day of the week, then months), by folder, or by type (PDFs, screenshots, images, 3D). Search as you type, with thumbnails, "open" badges, and moved or deleted files greyed out. Open, show in Finder / file manager, copy the path, or remove an entry.
- **Go to File** (`Ctrl+P`): type a few letters of any open or recent file and press Enter.
- **Stays light all day**: at most 12 files stay open (configurable in Settings, `Ctrl+,`). Opening more closes the tab you've used least recently, and a message offers to reopen it. Pinned tabs, tabs with unsaved changes, and new documents never close and don't count.
- **Proper file handling**: Save, Save As (the document then lives at the new location), Save a Copy, no autosave, atomic writes, full path in the status bar (click it to open the containing folder, or copy it with the button next to it), a message after every save with "Show in Finder" / "Open Folder" and "Copy Path" buttons, "Open Containing Folder" and "Copy Path" on each tab's right-click menu, unsaved-changes prompts, recent files, one window with tabs

## Keyboard

| Action | Shortcut |
| --- | --- |
| New from Clipboard | `Ctrl+N` |
| Go to File (open or recent) | `Ctrl+P` |
| Library / back to the last file | `Ctrl+Shift+H` |
| Settings | `Ctrl+,` |
| Open / Save / Save As | `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Close tab / switch tabs | `Ctrl+W` / `Ctrl+Tab`, `Ctrl+PageDown`, `Ctrl+PageUp` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` |
| Rotate right / left | `Ctrl+R` / `Ctrl+L` |
| Delete selected pages | `Delete` (with the sidebar focused) |
| Copy / paste pages | `Ctrl+C` / `Ctrl+V` (with the sidebar focused) |
| Select all pages | `Ctrl+A` (with the sidebar focused) |
| Zoom in / out / fit (or reset a 3D view) | `Ctrl++` / `Ctrl+-` / `Ctrl+0`, or `Ctrl` + scroll |
| Find | `Ctrl+F`, then `Enter` / `Shift+Enter` |
| Copy the image with its markup | `Ctrl+C` |
| Markup tools: select / rectangle / oval / arrow / callout / crop | `V` / `R` / `O` / `A` / `T` / `C` (hold `Shift` while drawing for squares, circles and 45° arrows) |
| Finish typing a callout | `Esc`, `Ctrl+Enter`, or click elsewhere (`Enter` starts a new line) |
| Apply / cancel a crop | `Enter` / `Esc` |
| Remove the selected shape | `Delete` |

On macOS, use `⌘` instead of `Ctrl`.

## Download

Installers for macOS, Linux and Windows are on the [Releases page](https://github.com/paul-wolf/unacro/releases).

- **macOS:** the `.dmg` (`aarch64` for Apple Silicon, `x64` for Intel). The app isn't notarized yet, so the first time macOS may refuse to open it. Go to System Settings → Privacy & Security and click "Open Anyway", or run `xattr -dr com.apple.quarantine /Applications/Unacro.app`.
- **Linux:** the `.AppImage` runs on most distributions. There's also a `.deb` (Debian, Ubuntu) and an `.rpm` (Fedora, openSUSE).
- **Windows:** the `.msi` or `-setup.exe`. SmartScreen may warn about an unrecognised app: click "More info", then "Run anyway".

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

## Releasing

The app's version comes from `package.json`. To publish a release:

```sh
npm version 0.2.0          # updates package.json, commits, and tags v0.2.0
git push --follow-tags
```

The tag starts the [Release workflow](.github/workflows/release.yml). It builds installers for macOS (Apple Silicon and Intel), Linux (x64 and ARM: AppImage, deb, rpm) and Windows, and attaches them to a **draft** release. Check the draft on GitHub's Releases page, edit the notes, and click Publish. The [CI workflow](.github/workflows/ci.yml) type-checks and runs the tests on every push.

## How it's built

| Part | Library | License |
| --- | --- | --- |
| Desktop shell | [Tauri 2](https://tauri.app) | MIT / Apache-2.0 |
| Rendering, text, search | [PDF.js](https://mozilla.github.io/pdf.js/) | Apache-2.0 |
| Combining, rotating, signing, saving | [pdf-lib](https://pdf-lib.js.org) | MIT |
| TIFF reading and writing | [UTIF.js](https://github.com/photopea/UTIF.js) | MIT |
| 3D viewer (loaded only for STL files) | [three.js](https://threejs.org) | MIT |
| Callout text (screen, images and PDFs) | [Inter](https://rsms.me/inter/) font, embedded with [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | OFL-1.1 (font), MIT |

The UI is plain TypeScript with no framework.

- `src/core/`: the document model, PDF building (`build.ts`) and PDF-to-Markdown (`markdown.ts`). No DOM, unit-tested in Node.
- `src/app.ts`: tabs, sidebar, viewer, signatures, menus, keyboard.
- `src/platform.ts`: everything that touches the operating system (desktop vs. browser).
- `src-tauri/`: the native side. It only reads files, writes them atomically, and passes on files the operating system asks it to open.

Images are opened as one-page documents (wrapped in an in-memory PDF), so every page feature works on them too. The original pixels are kept, and saving an edited image draws it again at full resolution with rotation and signatures applied. An unchanged image is never rewritten.

Edits are never applied to your file directly. A document is a list of page references (source file + page number + rotation + signatures). Saving builds a new PDF from that list and writes it to a temporary file that is then renamed over the target. When most pages come from one file, that file is used as the base, so its bookmarks, form fields and metadata are kept.

## Privacy

Unacro makes no network requests. Saved signatures, settings and the Library stay on your machine. The Library is a small `history.json` plus thumbnails in Unacro's data folder (`~/Library/Application Support/dev.unacro.app` on macOS, `~/.local/share/dev.unacro.app` on Linux). "Clear Library…" in Settings deletes it.

## License

[MIT](LICENSE)
