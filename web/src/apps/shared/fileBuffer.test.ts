import { beforeEach, describe, expect, test } from "bun:test";
import { initializeMemoryFileSystem, readFile, writeFile } from "../../kernel/fs";
import { captureMachineMutationAdmission } from "../../kernel/ownershipAdmission";
import { resetKernelStore, useKernelStore } from "../../kernel/store";
import {
  AUTOSAVE_DELAY_MS,
  resolveExternalFileChange,
  scheduleAutosave,
  type AutosaveClock,
} from "./fileBuffer";

describe("shared editor buffer reconciliation", () => {
  beforeEach(() => resetKernelStore());

  test("preserves dirty human edits when disk content changes", () => {
    expect(resolveExternalFileChange("human draft", "saved", "agent write")).toEqual({
      kind: "conflict",
      content: "human draft",
      savedContent: "saved",
    });
  });

  test("reloads clean buffers and can force a post-save conflict", () => {
    expect(resolveExternalFileChange("saved", "saved", "agent write")).toEqual({
      kind: "reload",
      content: "agent write",
      savedContent: "agent write",
    });
    expect(resolveExternalFileChange("human save", "human save", "agent write", true).kind).toBe(
      "conflict",
    );
  });

  function fakeClock() {
    let nextHandle = 1;
    const pending = new Map<number, () => void>();
    const clock: AutosaveClock = {
      setTimeout(callback, milliseconds) {
        expect(milliseconds).toBe(AUTOSAVE_DELAY_MS);
        const handle = nextHandle++;
        pending.set(handle, callback);
        return handle;
      },
      clearTimeout(handle) {
        pending.delete(handle as number);
      },
    };
    return { clock, pending };
  }

  test("cancel then reschedule keeps one pending write", () => {
    const { clock, pending } = fakeClock();
    const saves: string[] = [];
    const first = scheduleAutosave(() => saves.push("first"), () => true, clock);

    first.cancel();
    scheduleAutosave(() => saves.push("second"), () => true, clock);

    expect(pending.size).toBe(1);
    for (const callback of pending.values()) callback();
    expect(saves).toEqual(["second"]);
  });

  test("unmount flush writes the typed buffer exactly once", async () => {
    await initializeMemoryFileSystem();
    const path = "~/desktop/autosave-unmount.txt";
    await writeFile(path, "saved", "system");
    const { clock, pending } = fakeClock();
    let saves = 0;
    let pendingWrite = Promise.resolve();
    const autosave = scheduleAutosave(() => {
      saves += 1;
      pendingWrite = writeFile(path, "human draft", "human");
    }, () => true, clock);

    autosave.cancel();
    autosave.flush();
    autosave.flush();
    for (const callback of pending.values()) callback();
    await pendingWrite;

    expect(saves).toBe(1);
    expect(pending.size).toBe(0);
    expect(await readFile(path)).toBe("human draft");
  });

  test("a pending autosave keeps its old ownership ticket and cannot mark stale bytes saved", async () => {
    await initializeMemoryFileSystem();
    const path = "~/desktop/autosave-takeover.txt";
    await writeFile(path, "new owner", "system");
    const admission = captureMachineMutationAdmission("human");
    const { clock } = fakeClock();
    let pendingWrite = Promise.resolve();
    const autosave = scheduleAutosave(() => {
      pendingWrite = writeFile(path, "stale draft", admission);
    }, () => true, clock);

    useKernelStore.getState().setMachineOwnership("conflict");
    useKernelStore.getState().setMachineOwnership("owned");
    autosave.flush();

    await expect(pendingWrite).rejects.toThrow("machine ownership changed while action was pending");
    expect(await readFile(path)).toBe("new owner");
  });

  test("guard false makes debounce and flush no-ops", () => {
    const { clock, pending } = fakeClock();
    let saves = 0;
    const autosave = scheduleAutosave(() => { saves += 1; }, () => false, clock);

    autosave.flush();
    for (const callback of pending.values()) callback();

    expect(saves).toBe(0);
  });
});
