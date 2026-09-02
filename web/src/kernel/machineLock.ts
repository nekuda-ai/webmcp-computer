import { useKernelStore } from "./store";

export const MACHINE_LOCK = "webmcp-computer-machine";
export const MACHINE_LOCK_CONFLICT_GRACE_MS = 500;
const MACHINE_PRESENCE_CHANNEL = "webmcp-computer-machine-presence";
const MACHINE_TAB_ID = "webmcp_computer.machine.tab-id";

type MachinePeerDetector = {
  findPeer(): Promise<boolean>;
  close(): void;
};

let started = false;
let releaseOwner: (() => void) | undefined;

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

  const availability = new Promise<"owned" | "contended" | "unavailable">((resolve) => {
    void locks.request(
      MACHINE_LOCK,
      { ifAvailable: true, mode: "exclusive" },
      async (lock) => {
        resolve(lock === null ? "contended" : "owned");
        if (lock === null) return;
        useKernelStore.getState().setMachineConflict(false);
        await hold;
      },
    ).catch((error: unknown) => {
      resolve("unavailable");
      console.warn("WebMCP Computer machine lock unavailable", error);
    });
  });

  void availability.then((status) => {
    if (status !== "contended") return;
    let waitingForLock = true;
    const peerConfirmation = peers?.findPeer() ?? new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), MACHINE_LOCK_CONFLICT_GRACE_MS);
    });
    void peerConfirmation.then((found) => {
      if (found && waitingForLock) useKernelStore.getState().setMachineConflict(true);
    }).catch((error: unknown) => {
      console.warn("WebMCP Computer machine peer check unavailable", error);
    });
    void locks.request(MACHINE_LOCK, { mode: "exclusive" }, async () => {
      waitingForLock = false;
      useKernelStore.getState().setMachineConflict(false);
      await hold;
    }).catch((error: unknown) => {
      waitingForLock = false;
      useKernelStore.getState().setMachineConflict(false);
      console.warn("WebMCP Computer machine lock wait failed", error);
    });
  });

  if (typeof window !== "undefined") window.addEventListener("pagehide", releaseOwnership, { once: true });
}

export function resetMachineOwnershipForTests(): void {
  releaseOwner?.();
  releaseOwner = undefined;
  started = false;
}
