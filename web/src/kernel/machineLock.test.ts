import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  MACHINE_CONFLICT_REASON,
  MACHINE_LOCK,
  MACHINE_PENDING_REASON,
  MACHINE_TAKEN_OVER_REASON,
  machineOwnershipReason,
  resetMachineOwnershipForTests,
  startMachineOwnership,
  subscribeMachineOwnershipReason,
  takeOverMachine,
} from "./machineLock";
import { isHumanActivityContext } from "./activity";
import { resetKernelStore, useKernelStore } from "./store";
import { runAgentAction } from "../tools/agentAction";
import { machineTakeOverTool } from "../tools/systemTools";
import {
  resetTerminalSessions,
  setTerminalShellExecutor,
  terminalSession,
} from "./terminalSessions";
import { executeShell } from "./shell/engine";

function abortError(): Error {
  const error = new Error("Lock broken by another request with the 'steal' option.");
  error.name = "AbortError";
  return error;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("WebMCP Computer machine ownership", () => {
  beforeEach(() => {
    resetKernelStore();
    resetMachineOwnershipForTests();
    resetTerminalSessions();
  });

  afterEach(() => {
    resetMachineOwnershipForTests();
    resetTerminalSessions();
    setTerminalShellExecutor(executeShell);
  });

  test("has zero admission window while the initial lock request is pending", async () => {
    const locks = {
      async request<T>(): Promise<T> {
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });

    expect(useKernelStore.getState().machineOwnership).toBe("pending");
    expect(machineOwnershipReason()).toBe(MACHINE_PENDING_REASON);
    expect(isHumanActivityContext({ visibility: "visible", focused: true })).toBe(false);
    let called = false;
    await expect(runAgentAction("fs_write", { path: "~/note" }, () => {
      called = true;
    })).rejects.toThrow("machine ownership is still being acquired");
    expect(called).toBe(false);
  });

  test("marks a second tab only after a peer confirms the contended lock", async () => {
    const requests: { name: string; options: LockOptions }[] = [];
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        requests.push({ name, options });
        if (options.ifAvailable) return await callback(null);
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => true, close() {} });
    await settle();

    expect(useKernelStore.getState().machineOwnership).toBe("conflict");
    expect(requests).toEqual([
      { name: MACHINE_LOCK, options: { ifAvailable: true, mode: "exclusive" } },
      { name: MACHINE_LOCK, options: { mode: "exclusive" } },
    ]);
  });

  test("fails closed when a Web Locks request errors", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: { name: string; options: LockOptions }[] = [];
    const locks = {
      async request<T>(name: string, options: LockOptions): Promise<T> {
        requests.push({ name, options });
        throw new Error("lock manager unavailable");
      },
    } as unknown as LockManager;

    try {
      startMachineOwnership(locks, { findPeer: async () => false, close() {} });
      await settle();

      expect(useKernelStore.getState().machineOwnership).toBe("unavailable");
      expect(requests).toEqual([
        { name: MACHINE_LOCK, options: { ifAvailable: true, mode: "exclusive" } },
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  test("does not flash confirmed conflict while a reloading page releases the lock", async () => {
    const ownershipStates: string[] = [];
    const ownershipReasons: string[] = [];
    const unsubscribeReason = subscribeMachineOwnershipReason(() => {
      ownershipReasons.push(machineOwnershipReason());
    });
    const unsubscribe = useKernelStore.subscribe((state, previous) => {
      if (state.machineOwnership !== previous.machineOwnership) ownershipStates.push(state.machineOwnership);
    });
    let confirmPeer: (found: boolean) => void = () => {};
    const peerConfirmation = new Promise<boolean>((resolve) => { confirmPeer = resolve; });
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable) return await callback(null);
        return await callback({ name, mode: "exclusive" } as Lock);
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: () => peerConfirmation, close() {} });
    await settle();
    confirmPeer(true);
    await settle();
    unsubscribe();
    unsubscribeReason();

    expect(ownershipStates).not.toContain("conflict");
    expect(ownershipReasons).not.toContain(MACHINE_CONFLICT_REASON);
    expect(useKernelStore.getState().machineOwnership).toBe("owned");
  });

  test("successful initial acquisition clears pending and enables heartbeat eligibility", async () => {
    const locks = {
      async request<T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        return await callback({ name, mode: "exclusive" } as Lock);
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await settle();

    expect(useKernelStore.getState().machineOwnership).toBe("owned");
    expect(isHumanActivityContext({ visibility: "visible", focused: true })).toBe(true);
  });

  test("take over stays pending until steal acquisition and then clears blocking", async () => {
    const requests: LockOptions[] = [];
    let grantSteal: () => void = () => {};
    const locks = {
      async request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        requests.push(options);
        if (options.ifAvailable) return await callback(null);
        if (options.steal) {
          grantSteal = () => { void callback({ name, mode: "exclusive" } as Lock); };
        }
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => true, close() {} });
    await settle();
    expect(useKernelStore.getState().machineOwnership).toBe("conflict");
    expect(machineOwnershipReason()).toBe(MACHINE_CONFLICT_REASON);

    const takeover = takeOverMachine();
    expect(useKernelStore.getState().machineOwnership).toBe("pending");
    grantSteal();
    await expect(takeover).resolves.toBe(true);

    expect(requests.at(-1)).toEqual({ mode: "exclusive", steal: true });
    expect(useKernelStore.getState().machineOwnership).toBe("owned");
  });

  test("machine_take_over is transact-class and the only blocked acquisition action", async () => {
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
    await expect(machineTakeOverTool.execute({})).resolves.toEqual({ taken_over: true });
    expect(useKernelStore.getState().machineOwnership).toBe("owned");
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

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await settle();
    expect(useKernelStore.getState().machineOwnership).toBe("owned");
    const reasons: string[] = [];
    const unsubscribe = subscribeMachineOwnershipReason(() => reasons.push(machineOwnershipReason()));

    breakLock(abortError());
    await settle();
    unsubscribe();

    expect(useKernelStore.getState().machineOwnership).toBe("conflict");
    expect(machineOwnershipReason()).toBe(MACHINE_TAKEN_OVER_REASON);
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

  test("losing ownership interrupts active human terminals and cancels queued human work", async () => {
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

    const started: string[] = [];
    const signals = new Map<string, AbortSignal | undefined>();
    const finishes = new Map<string, () => void>();
    setTerminalShellExecutor(async (command, _session, _processes, options) => {
      started.push(command);
      signals.set(command, options?.signal);
      await new Promise<void>((resolve) => {
        finishes.set(command, resolve);
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const first = terminalSession(useKernelStore.getState().spawn("terminal").pid);
    const second = terminalSession(useKernelStore.getState().spawn("terminal").pid);
    const local = first.run("local-active", "human");
    const queued = first.run("queued-human", "human");
    const cloud = second.run("cloud-active", "human");
    await settle();

    try {
      expect(started).toEqual(["local-active", "cloud-active"]);
      breakLock(abortError());
      await settle();

      expect(signals.get("local-active")?.aborted).toBe(true);
      expect(signals.get("cloud-active")?.aborted).toBe(true);
      expect(started).not.toContain("queued-human");
      await expect(local).resolves.toEqual({ stdout: "", stderr: "", exitCode: 130 });
      await expect(cloud).resolves.toEqual({ stdout: "", stderr: "", exitCode: 130 });
      await expect(queued).rejects.toThrow("machine ownership was lost to another tab");
    } finally {
      for (const finish of finishes.values()) finish();
      await settle();
      for (const finish of finishes.values()) finish();
      await Promise.allSettled([local, queued, cloud]);
    }
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
    expect(useKernelStore.getState().machineOwnership).toBe("owned");

    breakSteal(abortError());
    await settle();
    expect(useKernelStore.getState().machineOwnership).toBe("conflict");
    expect(machineOwnershipReason()).toBe(MACHINE_TAKEN_OVER_REASON);
  });

  test("remains pending when an unconfirmed stale holder still owns the lock", async () => {
    const locks = {
      async request<T>(_name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable) return await callback(null);
        return await new Promise<T>(() => {});
      },
    } as unknown as LockManager;

    startMachineOwnership(locks, { findPeer: async () => false, close() {} });
    await settle();

    expect(useKernelStore.getState().machineOwnership).toBe("pending");
  });

  test("uses an honest degraded single-tab mode when Web Locks are unsupported", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      startMachineOwnership(null);

      expect(useKernelStore.getState().machineOwnership).toBe("unsupported");
      await expect(runAgentAction("sys_status", {}, () => ({ ok: true }))).resolves.toEqual({ ok: true });
      expect(isHumanActivityContext({ visibility: "visible", focused: true })).toBe(false);
      await expect(takeOverMachine()).resolves.toBe(false);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
