import { beforeEach, describe, expect, test } from "bun:test";
import { BROWSER_IDLE_MS } from "../../../shared/session-limits";
import {
  isHumanActive,
  isHumanActivityContext,
  isLiveViewFocusInteraction,
} from "./activity";
import { resetKernelStore, useKernelStore } from "./store";

describe("isHumanActive", () => {
  beforeEach(() => {
    resetKernelStore();
    useKernelStore.setState({ lastActivityAt: 1_000_000, lastHumanActivityAt: 1_000_000 });
  });

  test("is active while the last activity is within the idle window", () => {
    expect(isHumanActive({ now: 1_000_000 + BROWSER_IDLE_MS - 1, visibility: "visible" })).toBe(true);
    expect(isHumanActive({ now: 1_000_000 + BROWSER_IDLE_MS, visibility: "visible" })).toBe(false);
  });

  test("honours a custom idle window", () => {
    expect(isHumanActive({ now: 1_000_000 + 500, idleMs: 1_000, visibility: "visible" })).toBe(true);
    expect(isHumanActive({ now: 1_000_000 + 1_000, idleMs: 1_000, visibility: "visible" })).toBe(false);
  });

  test("is idle when the tab is hidden, unfocused, or this tab does not own the machine", () => {
    expect(isHumanActivityContext({ visibility: "hidden", focused: true })).toBe(false);
    expect(isHumanActive({ now: 1_000_000, visibility: "hidden", focused: true })).toBe(false);
    expect(isHumanActivityContext({ visibility: "visible", focused: false })).toBe(false);
    expect(isHumanActive({ now: 1_000_000, visibility: "visible", focused: false })).toBe(false);
    for (const machineOwnership of ["pending", "conflict", "unsupported", "unavailable"] as const) {
      useKernelStore.setState({ machineOwnership });
      expect(isHumanActivityContext({ visibility: "visible", focused: true })).toBe(false);
      expect(isHumanActive({ now: 1_000_000, visibility: "visible", focused: true })).toBe(false);
    }
  });

  test("agent/general activity never establishes human presence", () => {
    useKernelStore.setState({ lastHumanActivityAt: 0 });
    useKernelStore.getState().recordActivity();
    expect(isHumanActive({ now: Date.now(), visibility: "visible", focused: true })).toBe(false);

    useKernelStore.getState().recordHumanActivity();
    expect(isHumanActive({ now: Date.now(), visibility: "visible", focused: true })).toBe(true);
  });

  test("uses the current time and treats a missing document as visible and focused", () => {
    useKernelStore.getState().recordHumanActivity();
    expect(isHumanActive()).toBe(true);
    useKernelStore.setState({ lastHumanActivityAt: Date.now() - BROWSER_IDLE_MS - 1 });
    expect(isHumanActive()).toBe(false);
  });

  test("counts only a trusted, visible focus transition into the live-view iframe", () => {
    const iframe = {};
    expect(isLiveViewFocusInteraction(iframe, {
      activeElement: iframe,
      visibility: "visible",
      focused: true,
      trusted: true,
    })).toBe(true);
    expect(isLiveViewFocusInteraction(iframe, {
      activeElement: iframe,
      visibility: "hidden",
      focused: true,
      trusted: true,
    })).toBe(false);
    expect(isLiveViewFocusInteraction(iframe, {
      activeElement: iframe,
      visibility: "visible",
      focused: true,
      trusted: false,
    })).toBe(false);
    expect(isLiveViewFocusInteraction(iframe, {
      activeElement: {},
      visibility: "visible",
      focused: true,
      trusted: true,
    })).toBe(false);
    expect(isLiveViewFocusInteraction(iframe, {
      activeElement: iframe,
      visibility: "visible",
      focused: false,
      trusted: true,
    })).toBe(false);
  });
});
