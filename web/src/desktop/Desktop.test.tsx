import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeMemoryFileSystem, ls } from "../kernel/fs";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { createUntitledEntry, Desktop, DesktopWindows, machineSurfaceState } from "./Desktop";

describe("Desktop window lifecycle", () => {
  test("keeps the human surface inert throughout ownership acquisition", () => {
    expect(machineSurfaceState("pending")).toEqual({
      blocked: true,
      showOwnershipNotice: true,
      showTakeOver: false,
    });
    expect(machineSurfaceState("conflict")).toEqual({
      blocked: true,
      showOwnershipNotice: true,
      showTakeOver: true,
    });
    expect(machineSurfaceState("owned")).toEqual({
      blocked: false,
      showOwnershipNotice: false,
      showTakeOver: false,
    });
    expect(machineSurfaceState("unsupported")).toEqual({
      blocked: false,
      showOwnershipNotice: true,
      showTakeOver: false,
    });
  });

  test("renders the pending desktop inert without the confirmed-conflict action", () => {
    resetKernelStore();
    useKernelStore.setState({ machineOwnership: "pending" });
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const markup = renderToStaticMarkup(<Desktop />);
      expect(markup).toContain("machine-blocker");
      expect(markup).toContain('class="desktop__interactive" inert="" aria-hidden="true"');
      expect(markup).not.toContain(">Take over</button>");
    } finally {
      consoleError.mockRestore();
    }
  });

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
