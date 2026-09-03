import { beforeEach, describe, expect, test } from "bun:test";
import { BROWSER_IDLE_MS } from "../../../shared/session-limits";
import { isHumanActive } from "./activity";
import { resetKernelStore, useKernelStore } from "./store";

describe("isHumanActive", () => {
  beforeEach(() => {
    resetKernelStore();
    useKernelStore.setState({ lastActivityAt: 1_000_000 });
  });

  test("is active while the last activity is within the idle window", () => {
    expect(isHumanActive({ now: 1_000_000 + BROWSER_IDLE_MS - 1, visibility: "visible" })).toBe(true);
    expect(isHumanActive({ now: 1_000_000 + BROWSER_IDLE_MS, visibility: "visible" })).toBe(false);
  });

  test("honours a custom idle window", () => {
    expect(isHumanActive({ now: 1_000_000 + 500, idleMs: 1_000, visibility: "visible" })).toBe(true);
    expect(isHumanActive({ now: 1_000_000 + 1_000, idleMs: 1_000, visibility: "visible" })).toBe(false);
  });

  test("is idle when the tab is hidden or this tab does not own the machine", () => {
    expect(isHumanActive({ now: 1_000_000, visibility: "hidden" })).toBe(false);
    useKernelStore.setState({ machineConflict: true });
    expect(isHumanActive({ now: 1_000_000, visibility: "visible" })).toBe(false);
  });

  test("uses the current time and treats a missing document as visible", () => {
    useKernelStore.getState().recordActivity();
    expect(isHumanActive()).toBe(true);
    useKernelStore.setState({ lastActivityAt: Date.now() - BROWSER_IDLE_MS - 1 });
    expect(isHumanActive()).toBe(false);
  });
});
