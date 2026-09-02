import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defineTool } from "@nekuda/webmcp-sdk";
import {
  initializeMemoryFileSystem,
  mkdir,
  readFile,
  writeFile,
} from "../kernel/fs";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { getUiToolGrant, resetUiToolGrants } from "../apps/ui/runtime";
import { fsDeleteTool, fsWriteTool } from "./fileTools";
import { resetToolCatalog, setToolCatalogScope } from "./toolCatalog";
import { MAX_UI_HTML_BYTES, uiOpenTool } from "./uiTools";

const siteTool = defineTool({
  stableKey: "test.site_tool",
  name: "site_demo",
  description: "Test site tool.",
  intent: "act",
  execute() {},
});

describe("ui_open", () => {
  beforeEach(async () => {
    resetKernelStore();
    resetUiToolGrants();
    resetToolCatalog();
    await initializeMemoryFileSystem();
    setToolCatalogScope("test", [fsWriteTool, fsDeleteTool, siteTool, uiOpenTool]);
  });

  afterEach(() => {
    resetUiToolGrants();
    resetToolCatalog();
  });

  test("writes inline HTML, spawns the requested rect, and returns the real grant", async () => {
    const result = await uiOpenTool.execute({
      name: "trail-map",
      html: "<h1>Trail map</h1>",
      allowTools: ["fs_write", "fs_delete", "site_demo", "ui_open", "unknown", "fs_write"],
      x: 180,
      y: 120,
      width: 640,
      height: 480,
    });

    expect(result).toEqual({
      pid: 2,
      path: "~/apps/trail-map.html",
      rect: { x: 180, y: 120, width: 640, height: 480 },
      grantedTools: ["fs_write"],
    });
    expect(await readFile("~/apps/trail-map.html")).toBe("<h1>Trail map</h1>");
    expect(useKernelStore.getState().processes).toContainEqual(expect.objectContaining({
      pid: 2,
      appId: "ui",
      path: "~/apps/trail-map.html",
    }));
    expect(getUiToolGrant(2)).toEqual(["fs_write"]);
  });

  test("defaults to an empty grant", async () => {
    const result = await uiOpenTool.execute({ name: "quiet", html: "<p>Quiet</p>" });
    expect(result).toEqual(expect.objectContaining({ grantedTools: [] }));
    expect(getUiToolGrant((result as { pid: number }).pid)).toEqual([]);
  });

  test("rejects invalid names and oversized UTF-8 HTML", async () => {
    for (const name of ["", "bad name", "-bad", "x".repeat(41)]) {
      await expect(uiOpenTool.execute({ name, html: "ok" })).rejects.toThrow(
        `webmcp-computer: invalid UI app name '${name}'`,
      );
    }
    await expect(uiOpenTool.execute({
      name: "large",
      html: "🙂".repeat(Math.floor(MAX_UI_HTML_BYTES / 4) + 1),
    })).rejects.toThrow("webmcp-computer: html too large for 'large'");
  });

  test("requires exactly one of html or path", async () => {
    await expect(uiOpenTool.execute({ name: "missing" })).rejects.toThrow(
      "webmcp-computer: ui_open for 'missing' requires exactly one of html or path",
    );
    await expect(uiOpenTool.execute({
      name: "both",
      html: "<p>inline</p>",
      path: "~/site/index.html",
    })).rejects.toThrow("webmcp-computer: ui_open for 'both' requires exactly one of html or path");
  });

  test("opens only existing HTML files and names the offending path", async () => {
    await writeFile("~/site/plain.txt", "plain", "system");
    await mkdir("~/site/folder.html", "system");

    await expect(uiOpenTool.execute({
      name: "missing-file",
      path: "~/site/missing.html",
    })).rejects.toThrow("webmcp-computer: no such file: ~/site/missing.html");
    await expect(uiOpenTool.execute({
      name: "wrong-extension",
      path: "~/site/plain.txt",
    })).rejects.toThrow("webmcp-computer: UI app path must end in .html: ~/site/plain.txt");
    await expect(uiOpenTool.execute({
      name: "directory",
      path: "~/site/folder.html",
    })).rejects.toThrow("webmcp-computer: is a directory: ~/site/folder.html");
  });

  test("restored and unknown PIDs have no grant", async () => {
    const restored = useKernelStore.getState().spawn("ui", {
      path: "~/site/restored.html",
    });
    expect(getUiToolGrant(restored.pid)).toEqual([]);
    expect(getUiToolGrant(999)).toEqual([]);
  });
});
