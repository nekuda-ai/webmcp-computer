import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MACHINE_CONFLICT_REASON,
  MACHINE_LOCK,
  MACHINE_TAKEN_OVER_REASON,
  machineConflictReason,
  resetMachineOwnershipForTests,
  startMachineOwnership,
  subscribeMachineConflictReason,
  takeOverMachine,
} from "./machineLock";

function abortError(): Error {
  const error = new Error("Lock broken by another request with the 'steal' option.");
  error.name = "AbortError";
  return error;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}
import { resetKernelStore, useKernelStore } from "./store";
import { runAgentAction } from "../tools/agentAction";
import { machineTakeOverTool } from "../tools/systemTools";

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

  test("take over steals the lock and clears the conflict in the blocked tab", async () => {
    const requests: LockOptions[] = [];
    const locks = {
      async request<T>(_name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        requests.push(options);
        if (options.ifAvailable) return await callback(null);
        if (options.steal) return await callback({ name: MACHINE_LOCK, mode: "exclusive" } as Lock);
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => true, close() {} });
    await settle();
    expect(useKernelStore.getState().machineConflict).toBe(true);
    expect(machineConflictReason()).toBe(MACHINE_CONFLICT_REASON);

    void takeOverMachine();
    await settle();

    expect(requests.at(-1)).toEqual({ mode: "exclusive", steal: true });
    expect(useKernelStore.getState().machineConflict).toBe(false);
  });

  test("machine_take_over is transact-class and can acquire ownership while blocked", async () => {
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable) return await callback(null);
        if (options.steal) return await callback({ name, mode: "exclusive" } as Lock);
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;
    startMachineOwnership(locks, { findPeer: async () => true, close() {} });
    await settle();

    expect(machineTakeOverTool.intent).toBe("transact");
    expect(machineTakeOverTool.annotations?.consequentialHint).toBe(true);
    await expect(machineTakeOverTool.execute({})).resolves.toEqual({ takenOver: true });
    expect(useKernelStore.getState().machineConflict).toBe(false);
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      verb: "machine_take_over",
      ok: true,
    }));
  });

  test("take over is a no-op while this tab owns the machine", async () => {
    const requests: LockOptions[] = [];
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        requests.push(options);
        return await callback({ name, mode: "exclusive" } as Lock);
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await settle();
    await takeOverMachine();
    expect(requests).toEqual([{ ifAvailable: true, mode: "exclusive" }]);
  });

  test("an owner whose lock is stolen becomes blocked with a take-over reason", async () => {
    let breakLock: (error: Error) => void = () => {};
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (!options.ifAvailable) return await new Promise<T>(() => {});
        const held = callback({ name, mode: "exclusive" } as Lock);
        return await new Promise<T>((_resolve, reject) => {
          breakLock = reject;
          void held;
        });
      },
    } as unknown as LockManager;
    const reasons: string[] = [];
    const unsubscribe = subscribeMachineConflictReason(() => reasons.push(machineConflictReason()));

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await settle();
    expect(useKernelStore.getState().machineConflict).toBe(false);

    breakLock(abortError());
    await settle();
    unsubscribe();

    expect(useKernelStore.getState().machineConflict).toBe(true);
    expect(machineConflictReason()).toBe(MACHINE_TAKEN_OVER_REASON);
    expect(reasons).toEqual([MACHINE_TAKEN_OVER_REASON]);
  });

  test("losing an owned lock aborts old-owner agent work before it can report success", async () => {
    let breakLock: (error: Error) => void = () => {};
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (!options.ifAvailable) return await new Promise<T>(() => {});
        void callback({ name, mode: "exclusive" } as Lock);
        return await new Promise<T>((_resolve, reject) => { breakLock = reject; });
      },
    } as unknown as LockManager;
    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await settle();

    let signal: AbortSignal | undefined;
    const action = runAgentAction("cloud_exec", {}, async (ownershipSignal) => {
      signal = ownershipSignal;
      return await new Promise<string>(() => {});
    });
    breakLock(abortError());

    await expect(action).rejects.toThrow("machine ownership was lost to another tab");
    expect(signal?.aborted).toBe(true);
    expect(useKernelStore.getState().events.at(-1)?.ok).toBe(false);
  });

  test("a tab that took over can itself be taken over again", async () => {
    let breakSteal: (error: Error) => void = () => {};
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable) return await callback(null);
        if (options.steal) {
          void callback({ name, mode: "exclusive" } as Lock);
          return await new Promise<T>((_resolve, reject) => {
            breakSteal = reject;
          });
        }
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => true, close() {} });
    await settle();
    void takeOverMachine();
    await settle();
    expect(useKernelStore.getState().machineConflict).toBe(false);

    breakSteal(abortError());
    await settle();
    expect(useKernelStore.getState().machineConflict).toBe(true);
    expect(machineConflictReason()).toBe(MACHINE_TAKEN_OVER_REASON);
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
