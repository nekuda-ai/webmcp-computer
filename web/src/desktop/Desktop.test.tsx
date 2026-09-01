import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeMemoryFileSystem, ls } from "../kernel/fs";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { createUntitledEntry, DesktopWindows } from "./Desktop";

describe("Desktop window lifecycle", () => {
  test("keeps a minimized window mounted so tools and buffer state survive", () => {
    resetKernelStore();
    const process = useKernelStore.getState().spawn("editor", {
      path: "~/desktop/draft.md",
    });
    useKernelStore.getState().minimize(process.pid);
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const markup = renderToStaticMarkup(
        <DesktopWindows processes={[process]} minimizedPids={[process.pid]} />,
      );
      expect(markup).toContain(`aria-label="Editor window, PID ${process.pid}"`);
      expect(markup).toContain("window-shell--editor is-focused is-minimized");
      expect(markup).toContain("display:none");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("retries one untitled collision without clobbering either create", async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();

    await Promise.all([createUntitledEntry("file"), createUntitledEntry("file")]);

    const names = (await ls("~/desktop")).map(({ name }) => name);
    expect(names).toContain("untitled");
    expect(names).toContain("untitled-2");
  });
});
