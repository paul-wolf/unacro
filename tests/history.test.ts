import { describe, expect, it } from "vitest";
import {
  MONTH_MS,
  fuzzyScore,
  groupByFolder,
  groupByTime,
  groupByType,
  pathKey,
  prune,
  record,
  relativeTime,
  search,
  splitPath,
  type HistoryEntry,
} from "../src/core/history";

const NOW = new Date(2026, 9, 23, 13, 30, 0).getTime(); // Fri 23 Oct 2026, 13:30 local
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function entry(path: string, ago: number, kind: HistoryEntry["kind"] = "pdf", count = 1): HistoryEntry {
  return { path, ...splitPath(path), kind, first: NOW - ago, last: NOW - ago, count };
}

describe("history basics", () => {
  it("splits paths", () => {
    expect(splitPath("/Users/paul/Docs/a.pdf")).toEqual({ name: "a.pdf", dir: "/Users/paul/Docs" });
    expect(splitPath("C:\\Users\\p\\b.png")).toEqual({ name: "b.png", dir: "C:\\Users\\p" });
    expect(splitPath("/a.pdf")).toEqual({ name: "a.pdf", dir: "/" });
  });

  it("makes stable, distinct keys", () => {
    expect(pathKey("/a/b.pdf")).toBe(pathKey("/a/b.pdf"));
    expect(pathKey("/a/b.pdf")).not.toBe(pathKey("/a/c.pdf"));
    expect(pathKey("/a/b.pdf")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records opens and views", () => {
    const m = new Map<string, HistoryEntry>();
    record(m, "/d/x.pdf", "pdf", NOW - HOUR, true);
    record(m, "/d/x.pdf", "pdf", NOW - MIN, false); // viewed again
    record(m, "/d/x.pdf", "pdf", NOW, true); // opened again
    const e = m.get("/d/x.pdf")!;
    expect(e.count).toBe(2);
    expect(e.first).toBe(NOW - HOUR);
    expect(e.last).toBe(NOW);
  });

  it("forgets files not used within the retention period", () => {
    const list = [entry("/a", 5 * MONTH_MS), entry("/b", 7 * MONTH_MS)];
    expect(prune(list, 6, NOW).map((e) => e.path)).toEqual(["/a"]);
  });
});

describe("grouping", () => {
  const list = [
    entry("/w/now.pdf", 2 * MIN),
    entry("/w/recent.png", 40 * MIN, "image"),
    entry("/w/morning.pdf", 4 * HOUR + 10 * MIN), // today 09:20
    entry("/h/Screenshot 2026-10-22 at 10.00.png", DAY, "image"), // yesterday
    entry("/h/tue.pdf", 3 * DAY),
    entry("/old/aug.stl", 70 * DAY, "model"),
  ];

  it("groups by time, finest for recent files", () => {
    const g = groupByTime(list, NOW);
    expect(g.map((x) => x.key)).toEqual(["m5", "h1", "today-9", "yesterday", expect.stringMatching(/^day-/), expect.stringMatching(/^month-/)]);
    expect(g[2].title).toBe("Today, 09:00–10:00");
    expect(g[0].entries[0].name).toBe("now.pdf");
  });

  it("groups by folder, most recently used folder first", () => {
    const g = groupByFolder(list);
    expect(g.map((x) => x.detail)).toEqual(["/w", "/h", "/old"]);
    expect(g[0].entries.map((e) => e.name)).toEqual(["now.pdf", "recent.png", "morning.pdf"]);
  });

  it("groups by type and spots screenshots", () => {
    const g = groupByType(list);
    expect(g.map((x) => [x.key, x.entries.length])).toEqual([["pdf", 3], ["screenshot", 1], ["image", 1], ["model", 1]]);
  });
});

describe("quick switcher matching", () => {
  it("matches characters in order, preferring the file name", () => {
    expect(fuzzyScore("inv", "invoice-2026.pdf", "/x")).toBeGreaterThan(fuzzyScore("inv", "report.pdf", "/x/invoices"));
    expect(fuzzyScore("rpt", "report.pdf", "/x")).toBeGreaterThan(0);
    expect(fuzzyScore("zzz", "report.pdf", "/x")).toBe(-1);
  });

  it("searches and orders results", () => {
    const list = [entry("/a/tax-return.pdf", DAY), entry("/b/taxi-receipt.png", HOUR, "image"), entry("/c/notes.pdf", MIN)];
    expect(search(list, "tax").map((e) => e.name)).toEqual(["tax-return.pdf", "taxi-receipt.png"]);
    expect(search(list, "").map((e) => e.name)).toEqual(["notes.pdf", "taxi-receipt.png", "tax-return.pdf"]);
  });

  it("describes times briefly", () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 12 * MIN, NOW)).toBe("12 min ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - DAY, NOW)).toMatch(/^yesterday \d\d:\d\d$/);
  });
});
