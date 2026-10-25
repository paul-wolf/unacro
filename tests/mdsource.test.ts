import { describe, expect, it } from "vitest";
import { firstHeading, joinPath, paperForLocale, resolveImageRef, splitFrontMatter } from "../src/core/mdsource";
import { detect } from "../src/core/formats";

const text = (s: string) => new TextEncoder().encode(s);

describe("splitFrontMatter", () => {
  it("removes front matter and reads the title", () => {
    const fm = splitFrontMatter('---\ntitle: "Quarterly notes"\ntags: [a, b]\n---\n# Hello\n');
    expect(fm.title).toBe("Quarterly notes");
    expect(fm.body).toBe("# Hello\n");
  });

  it("leaves documents without front matter alone", () => {
    expect(splitFrontMatter("# Hi\n---\nnot front matter\n---\n")).toEqual({ body: "# Hi\n---\nnot front matter\n---\n", title: null });
  });

  it("handles a BOM, CRLF and a front matter block without a title", () => {
    const fm = splitFrontMatter("\uFEFF---\r\nauthor: me\r\n...\r\nText");
    expect(fm).toEqual({ body: "Text", title: null });
  });
});

describe("resolveImageRef", () => {
  const md = "/home/p/notes/Week 1.md";

  it("resolves relative paths against the Markdown file's folder", () => {
    expect(resolveImageRef("img/a.png", md)).toEqual({ kind: "local", path: "/home/p/notes/img/a.png" });
    expect(resolveImageRef("./a.png", md)).toEqual({ kind: "local", path: "/home/p/notes/a.png" });
    expect(resolveImageRef("../shots/b.jpg", md)).toEqual({ kind: "local", path: "/home/p/shots/b.jpg" });
  });

  it("decodes %20 and drops ?query and #fragment", () => {
    expect(resolveImageRef("My%20Pics/c%C3%A5t.png?raw=1#x", md)).toEqual({ kind: "local", path: "/home/p/notes/My Pics/cåt.png" });
  });

  it("keeps literal spaces (from <angle bracket> links)", () => {
    expect(resolveImageRef("My Pics/a b.png", md)).toEqual({ kind: "local", path: "/home/p/notes/My Pics/a b.png" });
  });

  it("accepts absolute paths and file URLs", () => {
    expect(resolveImageRef("/tmp/x.png", md)).toEqual({ kind: "local", path: "/tmp/x.png" });
    expect(resolveImageRef("file:///tmp/a%20b.png", md)).toEqual({ kind: "local", path: "/tmp/a b.png" });
    expect(resolveImageRef("file:///C:/Users/p/a.png", md)).toEqual({ kind: "local", path: "C:\\Users\\p\\a.png" });
  });

  it("works with Windows paths", () => {
    expect(resolveImageRef("img\\a.png", "C:\\Users\\p\\doc.md")).toEqual({ kind: "local", path: "C:\\Users\\p\\img\\a.png" });
    expect(resolveImageRef("../a.png", "C:\\Users\\p\\doc.md")).toEqual({ kind: "local", path: "C:\\Users\\a.png" });
    expect(resolveImageRef("D:\\pics\\a.png", "C:\\Users\\p\\doc.md")).toEqual({ kind: "local", path: "D:\\pics\\a.png" });
  });

  it("tells web images, embedded images and unsupported ones apart", () => {
    expect(resolveImageRef("https://example.com/a.png", md)).toEqual({ kind: "remote", url: "https://example.com/a.png" });
    expect(resolveImageRef("//cdn.example.com/a.png", md)).toEqual({ kind: "remote", url: "https://cdn.example.com/a.png" });
    expect(resolveImageRef("data:image/png;base64,AAAA", md)).toEqual({ kind: "data", url: "data:image/png;base64,AAAA" });
    expect(resolveImageRef("data:text/html;base64,AAAA", md).kind).toBe("unsupported");
    expect(resolveImageRef("javascript:alert(1)", md).kind).toBe("unsupported");
    expect(resolveImageRef("~/a.png", md).kind).toBe("unsupported");
    expect(resolveImageRef("a.png", null).kind).toBe("unsupported");
    expect(resolveImageRef("", md).kind).toBe("unsupported");
  });
});

describe("joinPath", () => {
  it("normalises . and ..", () => {
    expect(joinPath("/a/b", "./c/../d.png")).toBe("/a/b/d.png");
    expect(joinPath("/", "x.png")).toBe("/x.png");
  });
});

describe("paperForLocale", () => {
  it("uses Letter in North America and A4 elsewhere", () => {
    expect(paperForLocale("en-US")).toBe("letter");
    expect(paperForLocale("en_CA")).toBe("letter");
    expect(paperForLocale("en-GB")).toBe("a4");
    expect(paperForLocale("uk-UA")).toBe("a4");
    expect(paperForLocale("de")).toBe("a4");
    expect(paperForLocale(undefined)).toBe("a4");
  });
});

describe("firstHeading", () => {
  it("finds the first level-1 heading", () => {
    expect(firstHeading("intro\n## Not this\n# The *Title* #\n# Later")).toBe("The Title");
    expect(firstHeading("no headings")).toBeNull();
  });
});

describe("detect", () => {
  it("recognises Markdown by its extension, even when it mentions %PDF-", () => {
    expect(detect("notes.md", text("# About the %PDF- header"))).toEqual({ kind: "markdown" });
    expect(detect("README.markdown", text("hi"))).toEqual({ kind: "markdown" });
  });
});
