import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MACHINE_LOCK, resetMachineOwnershipForTests, startMachineOwnership } from "./machineLock";
import { resetKernelStore, useKernelStore } from "./store";

describe("VerbOS machine ownership", () => {
  beforeEach(() => {
    resetKernelStore();
    resetMachineOwnershipForTests();
  });

  afterEach(() => resetMachineOwnershipForTests());

  test("marks a second tab while another tab holds the machine lock", async () => {
    const requests: { name: string; options: LockOptions }[] = [];
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        requests.push({ name, options });
        if (options.ifAvailable) return await callback(null);
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks);
    await Promise.resolve();
    await Promise.resolve();

    expect(useKernelStore.getState().machineConflict).toBe(true);
    expect(requests).toEqual([
      { name: MACHINE_LOCK, options: { ifAvailable: true, mode: "exclusive" } },
      { name: MACHINE_LOCK, options: { mode: "exclusive" } },
    ]);
  });
});
