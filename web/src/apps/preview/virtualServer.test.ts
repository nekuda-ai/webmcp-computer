import { describe, expect, test } from "bun:test";
import {
  buildSelfContainedDocument,
  MAX_PREVIEW_DOCUMENT_BYTES,
  type PreviewVirtualFile,
} from "./virtualServer";

const encoder = new TextEncoder();

function textFile(path: string, contentType: string, body: string): PreviewVirtualFile {
  return { path, contentType, body: encoder.encode(body) };
}

describe("Preview self-contained virtual server", () => {
  test("inlines stylesheets, scripts, and binary assets into one document", () => {
    const result = buildSelfContainedDocument([
      textFile(
        "index.html",
        "text/html; charset=utf-8",
        '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="trail.png"><script type="module" src="app.js"></script></body></html>',
      ),
      textFile(
        "style.css",
        "text/css; charset=utf-8",
        'body { background: url("trail.png"); }',
      ),
      { path: "trail.png", contentType: "image/png", body: Uint8Array.from([137, 80, 78, 71]) },
      textFile("app.js", "text/javascript; charset=utf-8", 'document.body.dataset.ready = "yes";'),
    ], 7, "token");

    expect(result.warnings).toEqual([]);
    expect(result.html).toContain('<style data-verbos-inlined="">body { background: url("data:image/png;base64,');
    expect(result.html).toContain('<img src="data:image/png;base64,');
    expect(result.html).toContain('<script type="importmap">');
    expect(result.html).toContain('<script type="module">import \"verbos-module:app.js\";</script>');
    expect(result.html).not.toContain('href="style.css"');
    expect(result.html).not.toContain('src="app.js"');
    expect(result.html).not.toContain("blob:");
    expect(result.html).toContain("modelContext");
    expect(result.html).toContain("site-tool-register");
  });

  test("inlines nested CSS imports and their url assets", () => {
    const result = buildSelfContainedDocument([
      textFile("index.html", "text/html", '<link rel="stylesheet" href="css/main.css">'),
      textFile("css/main.css", "text/css", '@import "nested/colors.css";'),
      textFile("css/nested/colors.css", "text/css", 'body { background: url("../../sky.png"); }'),
      { path: "sky.png", contentType: "image/png", body: Uint8Array.from([1, 2, 3]) },
    ], 7, "token");

    expect(result.warnings).toEqual([]);
    expect(result.html).toContain('@import url("data:text/css;base64,');
    expect(result.html).not.toContain("nested/colors.css");
  });

  test("keeps missing and escaping references and emits distinct console warnings", () => {
    const result = buildSelfContainedDocument([
      textFile(
        "index.html",
        "text/html",
        '<html><head><link rel="stylesheet" href="missing.css"></head><body><img src="../outside.png"></body></html>',
      ),
    ], 7, "token");

    expect(result.warnings).toEqual([
      "verbos-preview: missing asset: missing.css",
      "verbos-preview: outside the served root: ../outside.png",
    ]);
    expect(result.html).toContain('href="missing.css"');
    expect(result.html).toContain('src="../outside.png"');
    expect(result.html).toContain("verbos-preview: missing asset: missing.css");
    expect(result.html).toContain("verbos-preview: internal navigation unavailable:");
  });

  test("memoizes diamond imports, deduplicates CSS imports, and reuses asset URIs", () => {
    const cssFiles = Array.from({ length: 16 }, (_, index) => textFile(
      `css/layer-${index}.css`,
      "text/css",
      index === 15
        ? '.end { background: url("../logo.svg"); }'
        : `@import "layer-${index + 1}.css"; @import "layer-${index + 1}.css";`,
    ));
    const moduleFiles = Array.from({ length: 16 }, (_, index) => textFile(
      `js/module-${index}.js`,
      "text/javascript",
      index === 15
        ? "export const end = true;"
        : `import "./module-${index + 1}.js"; import "./module-${index + 1}.js";`,
    ));
    const result = buildSelfContainedDocument([
      textFile(
        "index.html",
        "text/html",
        '<link rel="stylesheet" href="css/layer-0.css"><img src="logo.svg"><img src="logo.svg"><script type="module" src="js/module-0.js"></script>',
      ),
      ...cssFiles,
      ...moduleFiles,
      textFile("logo.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ], 7, "token");

    expect(result.warnings).toEqual([]);
    expect(result.html.length).toBeLessThan(100_000);
    expect(result.html.match(/verbos-module:js%2Fmodule-/g)).toHaveLength(17);
    const imageUris = [...result.html.matchAll(/<img src="(data:image\/svg\+xml[^\"]+)"/g)]
      .map((match) => match[1]);
    expect(imageUris).toHaveLength(2);
    expect(imageUris[0]).toBe(imageUris[1]);
  });

  test("keeps the gallery document and drops only assets that exceed the budget", () => {
    const gallery = Array.from(
      { length: 50 },
      (_, index) => `<img src="photo.jpg" alt="Photo ${index + 1}">`,
    ).join("");
    const result = buildSelfContainedDocument([
      textFile("index.html", "text/html", `<main id="gallery">${gallery}</main>`),
      { path: "photo.jpg", contentType: "image/jpeg", body: new Uint8Array(200_000) },
    ], 7, "token");

    expect(result.warnings).toEqual([
      "verbos-preview: asset dropped (budget): photo.jpg",
    ]);
    expect(new TextEncoder().encode(result.html).byteLength).toBeLessThanOrEqual(
      MAX_PREVIEW_DOCUMENT_BYTES,
    );
    expect(result.html).toContain('<main id="gallery">');
    expect(result.html).toContain('src="data:image/jpeg;base64,');
    expect(result.html).toContain('src="photo.jpg"');
    expect(result.html).not.toContain("verbos-preview: document too large");
  });

  test("rejects an over-budget asset before base64 encoding", () => {
    const body = {
      byteLength: MAX_PREVIEW_DOCUMENT_BYTES,
      get length(): number {
        throw new Error("base64 encoding should not inspect length");
      },
      subarray(): never {
        throw new Error("base64 encoding should not read body chunks");
      },
    } as unknown as Uint8Array;
    const result = buildSelfContainedDocument([
      textFile("index.html", "text/html", '<img src="too-big.png">'),
      { path: "too-big.png", contentType: "image/png", body },
    ], 7, "token");

    expect(result.warnings).toEqual([
      "verbos-preview: asset dropped (budget): too-big.png",
    ]);
    expect(result.html).toContain('src="too-big.png"');
  });

  test("delays inlined classic defer scripts until DOMContentLoaded", () => {
    const result = buildSelfContainedDocument([
      textFile(
        "index.html",
        "text/html",
        '<html><head><script defer src="defer.js"></script></head><body><p id="ready"></p></body></html>',
      ),
      textFile("defer.js", "text/javascript", 'document.getElementById("ready").textContent = "yes";'),
    ], 7, "token");

    expect(result.warnings).toContain(
      "verbos-preview: defer script delayed until DOMContentLoaded: defer.js",
    );
    expect(result.html).toContain('document.addEventListener("DOMContentLoaded",()=>{document.getElementById("ready")');
    expect(result.html).not.toContain("<script defer");
  });

  test("decodes HTML entities before resolving and re-encodes rewritten attributes", () => {
    const result = buildSelfContainedDocument([
      textFile("index.html", "text/html", '<link rel="stylesheet" href="a&amp;b.css">'),
      textFile("a&b.css", "text/css", "body { color: red; }"),
    ], 7, "token");

    expect(result.warnings).toEqual([]);
    expect(result.html).toContain("body { color: red; }");
    expect(result.html).not.toContain("a&amp;b.css");
  });

  test("does not rewrite marked inlined styles with the HTML base path", () => {
    const result = buildSelfContainedDocument([
      textFile("index.html", "text/html", '<link rel="stylesheet" href="css/main.css">'),
      textFile("css/main.css", "text/css", '@import "nested/colors.css";'),
      textFile("css/nested/colors.css", "text/css", ".probe { color: blue; }"),
    ], 7, "token");

    expect(result.warnings).toEqual([]);
    expect(result.html).toContain('style data-verbos-inlined=""');
    expect(result.html).not.toContain("missing asset: nested/colors.css");
  });

  test("rewrites srcset, object data, and form action while warning on local gaps", () => {
    const result = buildSelfContainedDocument([
      textFile(
        "index.html",
        "text/html",
        '<img srcset="logo.svg 1x, logo-2x.svg 2x"><object data="diagram.svg"></object><form action="done.html"></form><iframe src="frame.html"></iframe><a href="page.html">Page</a>',
      ),
      textFile("logo.svg", "image/svg+xml", "<svg/ >"),
      textFile("logo-2x.svg", "image/svg+xml", "<svg/ >"),
      textFile("diagram.svg", "image/svg+xml", "<svg/ >"),
      textFile("done.html", "text/html", "done"),
      textFile("frame.html", "text/html", "frame"),
      textFile("page.html", "text/html", "page"),
    ], 7, "token");

    expect(result.html).toMatch(/srcset="data:image\/svg\+xml[^\"]+ 1x, data:image\/svg\+xml[^\"]+ 2x"/);
    expect(result.html).toContain('<object data="data:image/svg+xml');
    expect(result.html).toContain('<form action="data:text/html');
    expect(result.warnings).toContain(
      "verbos-preview: unhandled local reference: iframe src: frame.html",
    );
    expect(result.warnings).toContain(
      "verbos-preview: internal navigation unavailable: page.html",
    );
  });

  test("parses descriptor-free srcset candidates around comma separators", () => {
    const result = buildSelfContainedDocument([
      textFile("index.html", "text/html", '<img srcset="logo.svg, logo-2x.svg">'),
      textFile("logo.svg", "image/svg+xml", "<svg/ >"),
      textFile("logo-2x.svg", "image/svg+xml", "<svg/ >"),
    ], 7, "token");

    expect(result.warnings).toEqual([]);
    expect(result.html).toMatch(/srcset="data:image\/svg\+xml[^\"]+, data:image\/svg\+xml[^\"]+"/);
  });
});
