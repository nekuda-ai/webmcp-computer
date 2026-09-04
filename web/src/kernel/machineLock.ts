import { abortInFlightAgentActions } from "./agentActionLifecycle";
import { useKernelStore } from "./store";

export const MACHINE_LOCK = "webmcp-computer-machine";
export const MACHINE_LOCK_CONFLICT_GRACE_MS = 500;
const MACHINE_PRESENCE_CHANNEL = "webmcp-computer-machine-presence";
const MACHINE_TAB_ID = "webmcp_computer.machine.tab-id";

type MachinePeerDetector = {
  findPeer(): Promise<boolean>;
  close(): void;
};

export const MACHINE_CONFLICT_REASON = "machine already running in another tab";
export const MACHINE_TAKEN_OVER_REASON = "machine taken over by another tab";

let started = false;
let releaseOwner: (() => void) | undefined;
let takeOver: (() => Promise<boolean>) | undefined;
let conflictReason = MACHINE_CONFLICT_REASON;
const reasonListeners = new Set<() => void>();

function setConflict(conflict: boolean, reason = MACHINE_CONFLICT_REASON): void {
  const wasConflict = useKernelStore.getState().machineConflict;
  if (conflict && !wasConflict) abortInFlightAgentActions();
  if (conflictReason !== reason) {
    conflictReason = reason;
    for (const listener of reasonListeners) listener();
  }
  useKernelStore.getState().setMachineConflict(conflict);
}

/** Why this tab is blocked; pairs with `machineConflict` in the kernel store. */
export function machineConflictReason(): string {
  return conflictReason;
}

export function subscribeMachineConflictReason(listener: () => void): () => void {
  reasonListeners.add(listener);
  return () => reasonListeners.delete(listener);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Steal the machine lock from the tab that holds it. That tab's lock request rejects
 * with AbortError and it moves to the blocked state; this tab becomes the owner.
 */
export async function takeOverMachine(): Promise<boolean> {
  if (!useKernelStore.getState().machineConflict) return false;
  if (!takeOver) throw new Error("webmcp-computer: machine take over is unavailable in this browser");
  return await takeOver();
}

function lockManager(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

function peerDetector(): MachinePeerDetector | undefined {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return undefined;
  let tabId: string;
  try {
    tabId = window.sessionStorage.getItem(MACHINE_TAB_ID) ?? crypto.randomUUID();
    window.sessionStorage.setItem(MACHINE_TAB_ID, tabId);
  } catch {
    return undefined;
  }

  const channel = new BroadcastChannel(MACHINE_PRESENCE_CHANNEL);
  const waiters = new Set<(found: boolean) => void>();
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data === null || typeof event.data !== "object") return;
    const message = event.data as { type?: unknown; from?: unknown; to?: unknown };
    if (typeof message.from !== "string" || message.from === tabId) return;
    if (message.type === "probe") {
      channel.postMessage({ type: "present", from: tabId, to: message.from });
      return;
    }
    if (message.type === "present" && message.to === tabId) {
      for (const finish of [...waiters]) finish(true);
    }
  });

  return {
    findPeer() {
      return new Promise<boolean>((resolve) => {
        let timeout: number | undefined;
        const finish = (found: boolean) => {
          if (timeout !== undefined) window.clearTimeout(timeout);
          waiters.delete(finish);
          resolve(found);
        };
        waiters.add(finish);
        timeout = window.setTimeout(() => finish(false), MACHINE_LOCK_CONFLICT_GRACE_MS);
        channel.postMessage({ type: "probe", from: tabId });
      });
    },
    close() {
      for (const finish of [...waiters]) finish(false);
      channel.close();
    },
  };
}

export function startMachineOwnership(
  locks: LockManager | undefined = lockManager(),
  injectedPeerDetector?: MachinePeerDetector,
): void {
  if (started || !locks) return;
  started = true;
  const peers = injectedPeerDetector ?? peerDetector();

  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const releaseOwnership = () => {
    peers?.close();
    release();
  };
  releaseOwner = releaseOwnership;

  // A granted request that later rejects means another tab stole the lock.
  const holdLock = async () => {
    setConflict(false);
    await hold;
  };
  const stolen = (error: unknown): boolean => {
    if (!isAbort(error)) return false;
    setConflict(true, MACHINE_TAKEN_OVER_REASON);
    return true;
  };

  let owned = false;
  const availability = new Promise<"owned" | "contended" | "unavailable">((resolve) => {
    void locks.request(
      MACHINE_LOCK,
      { ifAvailable: true, mode: "exclusive" },
      async (lock) => {
        resolve(lock === null ? "contended" : "owned");
        if (lock === null) return;
        owned = true;
        await holdLock();
      },
    ).catch((error: unknown) => {
      if (owned && stolen(error)) return;
      resolve("unavailable");
      console.warn("WebMCP Computer machine lock unavailable", error);
    });
  });

  takeOver = async () => {
    if (!useKernelStore.getState().machineConflict) return false;
    let granted = false;
    let resolveAcquired: (value: boolean) => void = () => {};
    let rejectAcquired: (error: unknown) => void = () => {};
    const acquired = new Promise<boolean>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    void locks.request(MACHINE_LOCK, { mode: "exclusive", steal: true }, async (lock) => {
      if (lock === null) {
        resolveAcquired(false);
        return;
      }
      granted = true;
      setConflict(false);
      resolveAcquired(true);
      await hold;
    }).catch((error: unknown) => {
      if (granted && stolen(error)) return;
      const detail = error instanceof Error ? error.message : String(error);
      rejectAcquired(new Error(`webmcp-computer: machine take over failed: ${detail}`));
    });
    return await acquired;
  };

  void availability.then((status) => {
    if (status !== "contended") return;
    let waitingForLock = true;
    const peerConfirmation = peers?.findPeer() ?? new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), MACHINE_LOCK_CONFLICT_GRACE_MS);
    });
    void peerConfirmation.then((found) => {
      if (found && waitingForLock) setConflict(true);
    }).catch((error: unknown) => {
      console.warn("WebMCP Computer machine peer check unavailable", error);
    });
    let granted = false;
    void locks.request(MACHINE_LOCK, { mode: "exclusive" }, async () => {
      waitingForLock = false;
      granted = true;
      await holdLock();
    }).catch((error: unknown) => {
      waitingForLock = false;
      if (granted && stolen(error)) return;
      setConflict(false);
      console.warn("WebMCP Computer machine lock wait failed", error);
    });
  });

  if (typeof window !== "undefined") window.addEventListener("pagehide", releaseOwnership, { once: true });
}

export function resetMachineOwnershipForTests(): void {
  releaseOwner?.();
  releaseOwner = undefined;
  takeOver = undefined;
  conflictReason = MACHINE_CONFLICT_REASON;
  reasonListeners.clear();
  started = false;
}
