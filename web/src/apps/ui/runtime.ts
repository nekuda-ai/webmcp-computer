import { useKernelStore } from "../../kernel/store";

const grants = new Map<number, readonly string[]>();
let unsubscribe: (() => void) | undefined;

function watchProcessLifetime(): void {
  if (unsubscribe !== undefined) return;
  unsubscribe = useKernelStore.subscribe((state) => {
    const livePids = new Set(state.processes.map(({ pid }) => pid));
    for (const pid of grants.keys()) {
      if (!livePids.has(pid)) grants.delete(pid);
    }
    if (grants.size !== 0) return;
    unsubscribe?.();
    unsubscribe = undefined;
  });
}

export function setUiToolGrant(pid: number, names: readonly string[]): void {
  grants.set(pid, Object.freeze([...new Set(names)]));
  watchProcessLifetime();
}

export function getUiToolGrant(pid: number): readonly string[] {
  return grants.get(pid) ?? [];
}

export function resetUiToolGrants(): void {
  grants.clear();
  unsubscribe?.();
  unsubscribe = undefined;
}
