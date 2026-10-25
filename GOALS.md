# Unacro: Goals

Unacro is a small, fast, open-source viewer for the files you look at all day: PDFs, screenshots, photos and other images, Markdown documents, plus simple 3D models. It also handles the everyday jobs around them: combining, organizing, signing, marking up and converting. It runs on Linux first, and also on macOS and Windows. It is MIT-licensed.

Think of it as what macOS Preview should be: available everywhere, and with file handling that never leaves you wondering where your file went.

This document is the yardstick for every feature request and pull request. If a change doesn't serve a goal below, or it pulls toward a non-goal, the answer is no (or "not yet").

## Who it's for

The reference user lives in Preview all day. Mostly PDFs, then screenshots, then general images. They mark up screenshots constantly, sign documents now and then, and keep their iPhone on HEIC to save space. They often need to turn Markdown documents into PDFs. They have not edited the text of a PDF in over a year.

What drives them away from Preview, and what Unacro must get right:

- **File management.** "Move To" instead of Save As. No easy way to see where a file lives.
- **Too many documents.** A Window menu with hundreds of entries, and an app that misbehaves once many files are open.
- **HEIC friction.** iPhone photos that can't be used anywhere without converting them first.
- **Not on Linux.**

## Core goals (v1)

1. **View quickly.** PDFs and images open instantly, scroll smoothly, zoom, show page thumbnails, and (for PDFs) search text.
2. **Images and screenshots are first-class.** JPEG, PNG, GIF, HEIC, TIFF and BMP open like any document. Edits save back in the image's own format. **New from Clipboard** (`Ctrl/⌘+N`) turns a screenshot on the clipboard into a new document straight away.
3. **Mark up screenshots and images.** Rectangles, ovals, arrows and text callouts in a few colours and widths, from a bar above the image, editable until saved (done). The core workflow is paste a screenshot, mark it up, copy it, with no saving in between.
4. **Convert without friction.** Turning HEIC (or any image) into JPEG or PNG, or images into a PDF, is a single obvious action.
5. **Combine documents.** Merge PDFs, images and Markdown documents into one PDF, insert pages from another file at any position, and move pages between open documents.
6. **Organize pages.** Reorder by drag and drop, rotate, delete, and select several pages at once.
7. **Sign.** Draw a signature once (or import a photo of it), keep it, then place, move and resize it on any page or image. This is a visual signature like Preview's, not a cryptographic one.
8. **Export to Markdown.** Turn a PDF into reasonable Markdown with headings, paragraphs and lists inferred from the layout. Getting it perfect isn't the goal. Getting it useful is.
9. **Markdown to PDF.** Markdown documents open rendered, like any other document, and Convert turns them into a PDF in one step, images included (see below).
10. **Look at 3D models** (low priority). Open STL files to rotate, zoom and check their size. Viewing only.

## Markdown documents

Turning a Markdown document into a good-looking PDF is a frequent need. It should work the way images do: open it, look at it, convert it.

- **Opening.** A .md file (double-clicked with Unacro as the handler, opened with "Open With", or dropped on the window) opens rendered in a tab. The view is read-only: editing stays in the user's text editor. The tab reloads when the file changes on disk, so it can sit beside the editor as a preview.
- **Converting.** Convert → PDF produces the PDF as a new, unsaved tab, exactly like image conversion. Nothing is written until the user saves. Combine accepts .md files directly.
- **How.** A permissive Markdown parser (markdown-it) renders to HTML with one well-designed stylesheet. The system web view's own print-to-PDF produces the file: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. What's in the tab is what ends up in the PDF. Page breaks avoid splitting code blocks, tables and images where the engine allows.
- **Flavour.** CommonMark plus the GitHub extensions: tables, task lists, strikethrough and autolinks. Front matter is hidden; a `title` in it becomes the PDF's title.
- **Images are essential.**
  - Local images always work: paths relative to the .md file's folder, absolute paths, paths with spaces or URL-encoding, PNG, JPEG, GIF, SVG, WebP, HEIC where Unacro can read it, and embedded data URIs.
  - Images are embedded in the PDF at full resolution and scaled to fit the page width, never upscaled.
  - A missing local image shows a clear placeholder with its path, and the tab says how many are missing before converting.
  - Remote images (https://…) are **not** fetched by default. A bar at the top of the tab says "This document has N images from the web" with a "Load remote images" button. Loading is per document and per session, and only fetches the image URLs in that document. Until then, each remote image shows a placeholder with its address.
- **Safety.** Raw HTML in Markdown is rendered in its safe subset. Scripts, iframes and event handlers are stripped. Rendering never triggers a network request on its own.
- **Code blocks** are monospaced with syntax highlighting (highlight.js).
- **Page setup.** A4 or Letter by locale, with sensible margins.
- **Status.** Done: rendered tabs that follow the file, local and opt-in web images, Convert → PDF and Export as PDF…, combining. Checked end to end on Linux; macOS and Windows still need a run on real machines.

## Office documents (via LibreOffice)

The aim is that reading, marking up and signing the Word and PowerPoint files people send you shouldn't require a Microsoft subscription.

- When a .pptx, .ppt, .docx or .doc file is opened in Unacro (for example because the user has made Unacro the handler for that type), Unacro offers to convert it to PDF.
- Conversion uses an installed copy of LibreOffice, run headless as a separate process. Unacro never bundles or links an office suite, and never uses a cloud or paid converter.
- The PDF opens as a new, unsaved tab, like Convert. Nothing is written next to the original until the user saves.
- If LibreOffice isn't installed, Unacro says what's needed instead of failing silently.
- Unacro doesn't edit Office files. Spreadsheets (.xlsx) are out of scope, because they don't paginate usefully.
- Fidelity follows LibreOffice. Mainstream decks and documents must look right. Missing fonts (Calibri, Cambria: install Carlito and Caladea) and exotic content may not.

## File management goals

Preview's file handling is the main frustration Unacro exists to fix. These are requirements, not polish.

- **Save means save, and Save As means Save As.** `Ctrl+S` writes to the file you opened. `Ctrl+Shift+S` asks for a new name and location, writes there, and from then on the open document *is* that new file. There is no "Duplicate" or "Move To" dance.
- **Save a Copy** writes the current state somewhere else and leaves the open document pointed at the original.
- **Images stay images.** Saving an image writes the same format back. If that's impossible (GIF and HEIC can't be written, and an image that now has several pages has to become a PDF), Unacro says why and asks where to save instead. It never silently changes the format.
- **No surprise autosave.** Nothing touches your file on disk until you save. Unsaved changes are clearly marked, and closing a changed document asks first.
- **Saves are atomic.** Unacro writes to a temporary file and then renames it over the original. A crash mid-save can't leave you with half a file.
- **Always know where a file is.** The full path is visible in the status bar, title bar and tab tooltip, and "Open Containing Folder" (on a tab's right-click menu, or by clicking the path in the status bar) opens your file manager with the file selected. After every save, a message shows the folder with "Show in Finder" / "Open Folder" and "Copy Path" buttons. The path can always be copied from the status bar.
- **Many documents, one window, and it stays tidy.** Open documents are tabs in a single window. At most *n* files stay open (12 by default). Opening more quietly closes the least recently used tab, but never one that's pinned, has unsaved changes or was never saved. Nothing is lost: every file is in the Library.
- **Find anything you've opened.** The Library lists every file opened in the last *m* months (6 by default) by recency, timeline (down to the last 5 minutes), folder or type, with search and thumbnails. Go to File (`⌘P`) jumps to any open or recent file by typing part of its name.
- **Opening from the file manager adds a tab.** Double-clicking a file, "Open With", or dropping it on the app icon opens it in the running window. It never starts a second copy of the app.
- **Drag and drop works the obvious way.** Drop a file on the window to open it. Drop it into the thumbnail sidebar to insert its pages at that spot.

## Principles

- **Do a few things very well.** Each feature should be as smooth as its counterpart in Preview, or better.
- **Your files are yours.** No accounts, no cloud, no telemetry, and no network access on its own. The one exception is a fetch the user explicitly asks for in the moment, such as "Load remote images" in a Markdown document, and it only reaches the addresses in that document.
- **Fast and light.** A small native shell (Tauri) instead of a bundled browser. Heavy parts, like the 3D viewer and the Markdown parser, load only when needed.
- **Permissive licensing only.** Every dependency must allow Unacro to stay MIT: permissive licenses (MIT, BSD, Apache 2.0, ISC and similar), plus file-level licenses such as MPL-2.0 that come in through Tauri itself. Nothing GPL, LGPL-only or AGPL, which rules out MuPDF/PyMuPDF. Separate programs the user has installed themselves (such as LibreOffice) may be run as external processes; they are not dependencies. (HEIC on Linux is the open question here: see below.)
- **Keyboard-friendly.** Every common action has a shortcut.

## Non-goals

These are deliberately out of scope. They are not "maybe later".

- **Editing existing PDF text** or reflowing content.
- **Converting to Word or Excel.**
- **Editing Office documents,** or converting spreadsheets.
- **Editing Markdown.** Unacro shows and converts it; a text editor writes it.
- **Photo editing.** No filters, layers, retouching or colour correction. Rotating, cropping, markup and converting are as far as it goes.
- **Rendering every broken or exotic file correctly.** Mainstream files must work. Strange ones can fail gracefully.
- **Cryptographic or certificate-based digital signatures.**
- **3D editing, slicing or measuring tools,** and other 3D formats until there's a real need.
- **Form designer, JavaScript in PDFs, multimedia, preflight or print production.**
- **Copying Preview feature-for-feature.** Unacro covers what people use daily, done better.

## Roadmap

In rough order:

1. **More markup if it's missed:** plain text labels, highlight, freehand, a choice of text size for callouts. (Rectangles, ovals, arrows and callouts, an outlined rounded box with a straight leader line and dot, are done.)
2. **Batch conversion** of several files at once. (Single-file Convert is done: it opens a new tab, and JPEG quality is set once.)
3. **HEIC on Linux.** It works on macOS through the system. On Linux it needs libheif, which is LGPL, so this needs a decision about the licensing principle (for example, using the system's libheif as an optional, dynamically loaded library).
4. **Office documents via LibreOffice** (see above): detect LibreOffice (PATH, Flatpak, standard install locations, or a custom path in settings), convert with a private profile (`-env:UserInstallation`) so it works while LibreOffice is already open, write to a temp folder, show a "Converting…" state, and time out gracefully.

## Maybe later

Good ideas without a firm plan yet. Each needs a clear reason before it's built.

- Filling existing PDF form fields.
- Text boxes for adding a date or initials next to a signature.
- Better Markdown for tables and multi-column layouts, possibly through an optional Docling add-on.
- OCR for scanned documents and screenshots (Tesseract).
- A command-line mode, e.g. `unacro merge a.pdf b.pdf -o out.pdf`, `unacro convert *.heic --to jpg`, `unacro md file.pdf`.
- Compression and image downsampling.
- WebP and AVIF images.
- Keynote as an alternative Office converter on macOS.
- For Markdown: math (KaTeX), Mermaid diagrams, a table of contents, page numbers and headers, a choice of stylesheets, and Typst as an alternative typesetter if web view page breaks prove too weak.

## Known limitations of the current approach

- Saving a PDF rebuilds the page list. The file that contributes the most pages is kept as the base, so its bookmarks, form fields and metadata survive. Pages copied in from *other* files lose their form fields, and bookmarks pointing at deleted pages go nowhere. Tightening this up is required before 1.0.
- Saving an edited image (rotated, cropped, marked up or signed) re-encodes it and drops its metadata (EXIF: camera, date, location). Unchanged images are never rewritten, and saving an untouched image in its own format copies it byte for byte.
- A PDF that contains callouts embeds the whole Inter font (about 175 KB), because embedding only the characters used breaks with this font in pdf-lib.
- Crop is reversible until an image is saved. In PDFs it sets the page's crop box, so the hidden part is still in the file.
- GIF and HEIC can be opened but not written. Animated GIFs show their first frame.
- Password-protected PDFs can't be opened yet.
- Markdown export ignores tables and multi-column layouts, and scans have no text to export.
- Find (`Ctrl+F`) doesn't search Markdown tabs yet. The PDF made from one can be searched.
- A web image that fails to load shows a placeholder in the Markdown tab, but is simply left out of the PDF.
- Page breaks in a PDF made from Markdown follow the system's web view: code blocks, tables and images aren't split where the engine can avoid it, but very long ones still are.
