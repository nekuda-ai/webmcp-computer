import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ContextMenuMachine,
  clampContextMenuPosition,
  keepsNativeContextMenu,
  nextEnabledMenuItem,
  type ContextMenuDescriptor,
} from "./ContextMenu";

function menu(label: string, action = () => undefined): ContextMenuDescriptor {
  return {
    label,
    x: 24,
    y: 36,
    items: [
      { label: "Open", onSelect: action },
      { type: "separator" },
      { label: "Unavailable", disabled: true, onSelect: action },
    ],
  };
}

describe("ContextMenu state machine", () => {
  test("opens at a pointer position and each dismissal path closes it", () => {
    const machine = new ContextMenuMachine();

    for (const reason of ["escape", "click-away", "scroll"] as const) {
      machine.open(menu(reason));
      expect(machine.snapshot()).toEqual(expect.objectContaining({
        label: reason,
        x: 24,
        y: 36,
      }));
      machine.dismiss(reason);
      expect(machine.snapshot()).toBeNull();
    }
  });

  test("a second contextmenu replaces the one open menu", () => {
    const machine = new ContextMenuMachine();
    machine.open(menu("first"));
    machine.open({ ...menu("second"), x: 80, y: 90 });

    expect(machine.snapshot()).toEqual(expect.objectContaining({
      label: "second",
      x: 80,
      y: 90,
    }));
  });

  test("activation closes and calls an enabled handler while disabled items stay inert", () => {
    let calls = 0;
    const machine = new ContextMenuMachine();
    machine.open(menu("actions", () => { calls += 1; }));

    expect(machine.activate(2)).toBe(false);
    expect(calls).toBe(0);
    expect(machine.snapshot()).not.toBeNull();

    expect(machine.activate(0)).toBe(true);
    expect(calls).toBe(1);
    expect(machine.snapshot()).toBeNull();
  });

  test("restores the previously focused connected element on dismiss and activation", () => {
    const originalDocument = globalThis.document;
    let focusCalls = 0;
    const previousFocus = {
      isConnected: true,
      focus() { focusCalls += 1; },
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { activeElement: previousFocus },
    });

    try {
      const machine = new ContextMenuMachine();
      machine.open(menu("dismiss"));
      machine.dismiss("escape");
      expect(focusCalls).toBe(1);

      machine.open(menu("activate"));
      expect(machine.activate(0)).toBe(true);
      expect(focusCalls).toBe(2);

      previousFocus.isConnected = false;
      machine.open(menu("detached"));
      machine.dismiss("click-away");
      expect(focusCalls).toBe(2);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});

describe("ContextMenu placement and navigation", () => {
  test("clamps the menu inside every viewport edge", () => {
    expect(clampContextMenuPosition(
      { x: 310, y: 190 },
      { width: 120, height: 100 },
      { width: 320, height: 200 },
    )).toEqual({ left: 192, top: 92 });
    expect(clampContextMenuPosition(
      { x: -20, y: -10 },
      { width: 120, height: 100 },
      { width: 320, height: 200 },
    )).toEqual({ left: 8, top: 8 });
  });

  test("arrow navigation skips separators and disabled items", () => {
    const items: ContextMenuDescriptor["items"] = [
      { label: "First", onSelect: () => undefined },
      { type: "separator" },
      { label: "Disabled", disabled: true, onSelect: () => undefined },
      { label: "Last", onSelect: () => undefined },
    ];

    expect(nextEnabledMenuItem(items, -1, 1)).toBe(0);
    expect(nextEnabledMenuItem(items, 0, 1)).toBe(3);
    expect(nextEnabledMenuItem(items, 3, 1)).toBe(0);
    expect(nextEnabledMenuItem(items, 0, -1)).toBe(3);
  });
});

describe("native context-menu targets", () => {
  const OriginalElement = globalThis.Element;

  class TestElement {
    constructor(
      private readonly tagName: "input" | "textarea" | "div",
      private readonly contentEditable = false,
    ) {}

    closest(): TestElement | null {
      return this.tagName === "input" || this.tagName === "textarea" || this.contentEditable
        ? this
        : null;
    }
  }

  beforeAll(() => {
    Object.defineProperty(globalThis, "Element", { configurable: true, value: TestElement });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "Element", { configurable: true, value: OriginalElement });
  });

  test("keeps input, textarea, and contenteditable menus native", () => {
    expect(keepsNativeContextMenu(new TestElement("input") as unknown as EventTarget)).toBe(true);
    expect(keepsNativeContextMenu(new TestElement("textarea") as unknown as EventTarget)).toBe(true);
    expect(keepsNativeContextMenu(new TestElement("div", true) as unknown as EventTarget)).toBe(true);
  });

  test("uses the VerbOS menu for a plain div", () => {
    expect(keepsNativeContextMenu(new TestElement("div") as unknown as EventTarget)).toBe(false);
  });
});
