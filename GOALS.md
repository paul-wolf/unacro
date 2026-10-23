# Unacro: Goals

Unacro is a small, fast, open-source viewer for the files you look at all day: PDFs, screenshots, photos and other images, plus simple 3D models. It also handles the everyday jobs around them: combining, organizing, signing, marking up and converting. It runs on Linux first, and also on macOS and Windows. It is MIT-licensed.

Think of it as what macOS Preview should be: available everywhere, and with file handling that never leaves you wondering where your file went.

This document is the yardstick for every feature request and pull request. If a change doesn't serve a goal below, or it pulls toward a non-goal, the answer is no (or "not yet").

## Who it's for

The reference user lives in Preview all day. Mostly PDFs, then screenshots, then general images. They mark up screenshots constantly, sign documents now and then, and keep their iPhone on HEIC to save space. They have not edited the text of a PDF in over a year.

What drives them away from Preview, and what Unacro must get right:

- **File management.** "Move To" instead of Save As. No easy way to see where a file lives.
- **Too many documents.** A Window menu with hundreds of entries, and an app that misbehaves once many files are open.
- **HEIC friction.** iPhone photos that can't be used anywhere without converting them first.
- **Not on Linux.**

## Core goals (v1)

1. **View quickly.** PDFs and images open instantly, scroll smoothly, zoom, show page thumbnails, and (for PDFs) search text.
2. **Images and screenshots are first-class.** JPEG, PNG, GIF, HEIC, TIFF and BMP open like any document. Edits save back in the image's own format. **New from Clipboard** (`Ctrl/⌘+N`) turns a screenshot on the clipboard into a new document straight away.
3. **Mark up screenshots and images.** Rectangles, ovals and arrows in a few colours and widths, from a bar above the image, editable until saved (done). Speech bubbles with text come next. The core workflow is paste a screenshot, mark it up, copy it, with no saving in between.
4. **Convert without friction.** Turning HEIC (or any image) into JPEG or PNG, or images into a PDF, is a single obvious action.
5. **Combine documents.** Merge PDFs and images into one PDF, insert pages from another file at any position, and move pages between open documents.
6. **Organize pages.** Reorder by drag and drop, rotate, delete, and select several pages at once.
7. **Sign.** Draw a signature once (or import a photo of it), keep it, then place, move and resize it on any page or image. This is a visual signature like Preview's, not a cryptographic one.
8. **Export to Markdown.** Turn a PDF into reasonable Markdown with headings, paragraphs and lists inferred from the layout. Getting it perfect isn't the goal. Getting it useful is.
9. **Look at 3D models** (low priority). Open STL files to rotate, zoom and check their size. Viewing only.

## File management goals

Preview's file handling is the main frustration Unacro exists to fix. These are requirements, not polish.

- **Save means save, and Save As means Save As.** `Ctrl+S` writes to the file you opened. `Ctrl+Shift+S` asks for a new name and location, writes there, and from then on the open document *is* that new file. There is no "Duplicate" or "Move To" dance.
- **Save a Copy** writes the current state somewhere else and leaves the open document pointed at the original.
- **Images stay images.** Saving an image writes the same format back. If that's impossible (GIF and HEIC can't be written, and an image that now has several pages has to become a PDF), Unacro says why and asks where to save instead. It never silently changes the format.
- **No surprise autosave.** Nothing touches your file on disk until you save. Unsaved changes are clearly marked, and closing a changed document asks first.
- **Saves are atomic.** Unacro writes to a temporary file and then renames it over the original. A crash mid-save can't leave you with half a file.
- **Always know where a file is.** The full path is visible in the status bar, title bar and tab tooltip, and "Open Containing Folder" (on a tab's right-click menu, or by clicking the path in the status bar) opens your file manager with the file selected. After every save, a message shows the folder with "Show in Finder" / "Open Folder" and "Copy Path" buttons. The path can always be copied from the status bar.
- **Many documents, one window.** Open documents are tabs in a single window, with a list of all tabs for quick switching. Thirty open files should feel no heavier than three, because pages render only when they're on screen.
- **Opening from the file manager adds a tab.** Double-clicking a file, "Open With", or dropping it on the app icon opens it in the running window. It never starts a second copy of the app.
- **Drag and drop works the obvious way.** Drop a file on the window to open it. Drop it into the thumbnail sidebar to insert its pages at that spot.

## Principles

- **Do a few things very well.** Each feature should be as smooth as its counterpart in Preview, or better.
- **Your files are yours.** No accounts, no cloud, no telemetry, no network access at all.
- **Fast and light.** A small native shell (Tauri) instead of a bundled browser. Heavy parts, like the 3D viewer, load only when needed.
- **Permissive licensing only.** Every dependency must allow Unacro to stay MIT: permissive licenses (MIT, BSD, Apache 2.0, ISC and similar), plus file-level licenses such as MPL-2.0 that come in through Tauri itself. Nothing GPL, LGPL-only or AGPL, which rules out MuPDF/PyMuPDF. (HEIC on Linux is the open question here: see below.)
- **Keyboard-friendly.** Every common action has a shortcut.

## Non-goals

These are deliberately out of scope. They are not "maybe later".

- **Editing existing PDF text** or reflowing content.
- **Converting to Word or Excel.**
- **Photo editing.** No filters, layers, retouching or colour correction. Rotating, cropping, markup and converting are as far as it goes.
- **Rendering every broken or exotic file correctly.** Mainstream files must work. Strange ones can fail gracefully.
- **Cryptographic or certificate-based digital signatures.**
- **3D editing, slicing or measuring tools,** and other 3D formats until there's a real need.
- **Form designer, JavaScript in PDFs, multimedia, preflight or print production.**
- **Copying Preview feature-for-feature.** Unacro covers what people use daily, done better.

## Roadmap

In rough order:

1. **Speech bubbles with text**, then maybe plain text labels, highlight and freehand. (Rectangles, ovals and arrows are done.)
2. **One-click conversion:** "Convert to JPEG/PNG" for images (especially HEIC), writing next to the original without a dialog, plus batch conversion of several files.
3. **Crop** for images and screenshots.
4. **HEIC on Linux.** It works on macOS through the system. On Linux it needs libheif, which is LGPL, so this needs a decision about the licensing principle (for example, using the system's libheif as an optional, dynamically loaded library).

## Maybe later

Good ideas without a firm plan yet. Each needs a clear reason before it's built.

- Filling existing PDF form fields.
- Text boxes for adding a date or initials next to a signature.
- Better Markdown for tables and multi-column layouts, possibly through an optional Docling add-on.
- OCR for scanned documents and screenshots (Tesseract).
- A command-line mode, e.g. `unacro merge a.pdf b.pdf -o out.pdf`, `unacro convert *.heic --to jpg`, `unacro md file.pdf`.
- Compression and image downsampling.
- WebP and AVIF images.

## Known limitations of the current approach

- Saving a PDF rebuilds the page list. The file that contributes the most pages is kept as the base, so its bookmarks, form fields and metadata survive. Pages copied in from *other* files lose their form fields, and bookmarks pointing at deleted pages go nowhere. Tightening this up is required before 1.0.
- Saving an edited image re-encodes it and drops its metadata (EXIF: camera, date, location). Unchanged images are never rewritten.
- GIF and HEIC can be opened but not written. Animated GIFs show their first frame.
- Password-protected PDFs can't be opened yet.
- Markdown export ignores tables and multi-column layouts, and scans have no text to export.
