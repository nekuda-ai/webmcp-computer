import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MACHINE_LOCK,
  resetMachineOwnershipForTests,
  startMachineOwnership,
} from "./machineLock";
import { resetKernelStore, useKernelStore } from "./store";

describe("WebMCP Computer machine ownership", () => {
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

    startMachineOwnership(locks, { findPeer: async () => true, close() {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(useKernelStore.getState().machineConflict).toBe(true);
    expect(requests).toEqual([
      { name: MACHINE_LOCK, options: { ifAvailable: true, mode: "exclusive" } },
      { name: MACHINE_LOCK, options: { mode: "exclusive" } },
    ]);
  });

  test("does not report another tab when the lock API is unavailable", async () => {
    const requests: { name: string; options: LockOptions }[] = [];
    const locks = {
      async request<T>(name: string, options: LockOptions): Promise<T> {
        requests.push({ name, options });
        throw new Error("lock manager unavailable");
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useKernelStore.getState().machineConflict).toBe(false);
    expect(requests).toEqual([
      { name: MACHINE_LOCK, options: { ifAvailable: true, mode: "exclusive" } },
    ]);
  });

  test("does not flash another-tab conflict while a reloading page releases the lock", async () => {
    const conflictStates: boolean[] = [];
    const unsubscribe = useKernelStore.subscribe((state, previous) => {
      if (state.machineConflict !== previous.machineConflict) conflictStates.push(state.machineConflict);
    });
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable) return await callback(null);
        return await callback({ name, mode: "exclusive" } as Lock);
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();

    expect(conflictStates).not.toContain(true);
    expect(useKernelStore.getState().machineConflict).toBe(false);
  });

  test("ignores a stale lock holder that does not answer the tab-presence probe", async () => {
    const locks = {
      async request<T>(_name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable) return await callback(null);
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useKernelStore.getState().machineConflict).toBe(false);
  });
});
