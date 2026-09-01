import { beforeEach, describe, expect, test } from "bun:test";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import {
  closeHumanWindow,
  focusHumanWindow,
  minimizeHumanWindow,
  openHumanApp,
} from "./humanActions";

describe("human window actions", () => {
  beforeEach(() => resetKernelStore());

  test("open, minimize, focus, and close use kernel actions with human events", () => {
    const process = openHumanApp("terminal");
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "human",
      verb: "app_open",
      args: { appId: "terminal", pid: process.pid },
    }));

    minimizeHumanWindow(process.pid);
    expect(useKernelStore.getState().minimizedPids).toEqual([process.pid]);
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "human",
      verb: "window_minimize",
    }));

    focusHumanWindow(process.pid);
    expect(useKernelStore.getState().minimizedPids).toEqual([]);
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "human",
      verb: "window_focus",
    }));

    closeHumanWindow(process.pid);
    expect(useKernelStore.getState().processes).toEqual([]);
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "human",
      verb: "app_close",
      args: expect.objectContaining({ appId: "terminal", pid: process.pid }),
    }));
  });
});
