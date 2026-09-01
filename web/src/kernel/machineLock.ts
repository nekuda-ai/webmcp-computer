import { useKernelStore } from "./store";

export const MACHINE_LOCK = "verbos-machine";

let started = false;
let releaseOwner: (() => void) | undefined;

function lockManager(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

export function startMachineOwnership(locks: LockManager | undefined = lockManager()): void {
  if (started || !locks) return;
  started = true;

  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseOwner = release;

  const availability = new Promise<boolean>((resolve) => {
    void locks.request(
      MACHINE_LOCK,
      { ifAvailable: true, mode: "exclusive" },
      async (lock) => {
        resolve(lock !== null);
        if (lock === null) return;
        useKernelStore.getState().setMachineConflict(false);
        await hold;
      },
    ).catch((error: unknown) => {
      resolve(false);
      console.warn("VerbOS machine lock unavailable", error);
    });
  });

  void availability.then((owned) => {
    if (owned) return;
    useKernelStore.getState().setMachineConflict(true);
    void locks.request(MACHINE_LOCK, { mode: "exclusive" }, async () => {
      useKernelStore.getState().setMachineConflict(false);
      await hold;
    }).catch((error: unknown) => {
      console.warn("VerbOS machine lock wait failed", error);
    });
  });

  if (typeof window !== "undefined") window.addEventListener("pagehide", release, { once: true });
}

export function resetMachineOwnershipForTests(): void {
  releaseOwner?.();
  releaseOwner = undefined;
  started = false;
}
