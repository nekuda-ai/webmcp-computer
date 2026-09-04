import { machineAdmissionError, machineInteractionBlocked } from "./machineOwnership";
import { useKernelStore } from "./store";

export type MachineMutationSource = "agent" | "human" | "system";

export type MachineMutationAdmission = Readonly<{
  source: MachineMutationSource;
  epoch: number;
}>;

export const MACHINE_OWNERSHIP_CHANGED_ERROR =
  "webmcp-computer: machine ownership changed while action was pending; retry";

/** Capture mutation authority synchronously, before an operation can enter a queue or await. */
export function captureMachineMutationAdmission(
  source: MachineMutationSource,
): MachineMutationAdmission {
  const state = useKernelStore.getState();
  if (source !== "system" && machineInteractionBlocked(state.machineOwnership)) {
    throw new Error(machineAdmissionError(state.machineOwnership));
  }
  return { source, epoch: state.machineOwnershipEpoch };
}

/** Recheck the original authority immediately before a durable or canonical mutation. */
export function assertMachineMutationAdmission(
  admission: MachineMutationAdmission,
): void {
  if (admission.source === "system") return;
  const state = useKernelStore.getState();
  if (admission.epoch !== state.machineOwnershipEpoch) {
    throw new Error(MACHINE_OWNERSHIP_CHANGED_ERROR);
  }
  if (machineInteractionBlocked(state.machineOwnership)) {
    throw new Error(machineAdmissionError(state.machineOwnership));
  }
}
