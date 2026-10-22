# Unacro: Goals

Unacro is a small, fast, open-source PDF tool for the things people actually do with PDFs every day. It runs on Linux first and also on macOS and Windows. It is MIT-licensed.

This document is the yardstick for every feature request and pull request. If a change doesn't serve a goal below, or it pulls toward a non-goal, the answer is no (or "not yet").

## Who it's for

People who open a lot of PDFs, look at them, shuffle pages around, sign something now and then, and otherwise leave the content alone. The reference user lives in macOS Preview all day and has not edited the text of a PDF in over a year.

## Core goals (v1)

1. **View PDFs quickly.** Open instantly, scroll smoothly, zoom, search text, and show page thumbnails in a sidebar.
2. **Combine documents.** Merge several PDFs into one, insert pages (or a whole document) from another PDF at any position, and move pages between open documents.
3. **Organize pages.** Reorder by drag and drop, rotate, delete, and select several pages at once.
4. **Sign.** Draw a signature once (or import a transparent PNG), keep it, then place, move, and resize it on any page. This is a visual signature like Preview's, not a cryptographic one.
5. **Export to Markdown.** Turn a PDF into reasonable Markdown with headings, paragraphs, and lists inferred from the layout. Getting it perfect isn't the goal. Getting it useful is.

## File management goals

Preview's file handling is the main frustration Unacro exists to fix. These are requirements, not polish.

- **Save means save, and Save As means Save As.** `Ctrl+S` writes to the file you opened. `Ctrl+Shift+S` asks for a new name and location, writes there, and from then on the open document *is* that new file. There is no "Duplicate" or "Move To" dance.
- **Save a Copy** writes the current state somewhere else and leaves the open document pointed at the original.
- **No surprise autosave.** Nothing touches your file on disk until you save. Unsaved changes are clearly marked, and closing a changed document asks first.
- **Saves are atomic.** Unacro writes to a temporary file and then renames it over the original. A crash mid-save can't leave you with half a PDF.
- **Always know where a file is.** The full path is visible (title bar and tab tooltip), and "Show in Folder" opens your file manager on it.
- **Many documents, one window.** Open documents are tabs in a single window, not a pile of windows. You can switch quickly, close others, and use a recent-files list. Thirty open PDFs should feel no heavier than three: pages render only when they're on screen.
- **Drag and drop works the obvious way.** Drop a PDF on the tab bar to open it. Drop it into the thumbnail sidebar to insert its pages at that spot.

## Principles

- **Do a few things very well.** Each feature should be as smooth as its counterpart in Preview, or better.
- **Your files are yours.** No accounts, no cloud, no telemetry, no network access at all.
- **Fast and light.** A small native shell (Tauri) instead of a bundled browser. Fast startup and low memory.
- **Permissive licensing only.** Every dependency must allow Unacro to stay MIT: permissive licenses (MIT, BSD, Apache 2.0, ISC and similar), plus file-level licenses such as MPL-2.0 that come in through Tauri itself. Nothing GPL, LGPL-only or AGPL, which rules out MuPDF/PyMuPDF.
- **Keyboard-friendly.** Every common action has a shortcut.

## Non-goals

These are deliberately out of scope. They are not "maybe later".

- **Editing existing PDF text** or reflowing content.
- **Converting to Word or Excel.**
- **Rendering every broken or exotic PDF correctly.** Mainstream PDFs must work. Strange ones can fail gracefully.
- **Cryptographic or certificate-based digital signatures.**
- **Full form designer, JavaScript in PDFs, 3D, multimedia, preflight, or print production.**
- **Being a Preview or Acrobat clone.** Matching feature lists is not the aim.

## Maybe later

Good ideas that are not in v1. Each needs a clear reason before it's built.

- Markup annotations (highlight, underline, sticky notes, freehand).
- Filling existing form fields.
- Text boxes for adding a date or initials next to a signature.
- Better Markdown for tables and multi-column layouts, possibly through an optional Docling add-on.
- OCR for scanned documents (Tesseract).
- A command-line mode, e.g. `unacro merge a.pdf b.pdf -o out.pdf` and `unacro md file.pdf`.
- Compression and image downsampling.

## Known limitations of the current approach

- Saving rebuilds the page list. The file that contributes the most pages is kept as the base, so its bookmarks, form fields and metadata survive. Pages copied in from *other* files lose their form fields, and bookmarks pointing at deleted pages go nowhere. Tightening this up is required before 1.0.
- Password-protected PDFs can't be opened yet.
- Markdown export ignores tables and multi-column layouts, and scanned PDFs have no text to export.
