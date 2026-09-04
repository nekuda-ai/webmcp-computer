import {
  beginOwnedAgentAction,
  MACHINE_OWNERSHIP_LOST_ERROR,
} from "../kernel/agentActionLifecycle";
import {
  machineAdmissionError,
  machineInteractionBlocked,
} from "../kernel/machineOwnership";
import {
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "../kernel/ownershipAdmission";
import { useKernelStore } from "../kernel/store";

export {
  abortInFlightAgentActions,
  MACHINE_OWNERSHIP_LOST_ERROR,
} from "../kernel/agentActionLifecycle";

function ownershipError(): Error {
  return new Error(MACHINE_OWNERSHIP_LOST_ERROR);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : ownershipError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

type AgentActionOptions<T> = {
  resultArgs?: (result: T) => Record<string, unknown>;
  /** Reserved for the ownership-acquisition tool, which must be callable while blocked. */
  allowWhileBlocked?: boolean;
};

type AgentAction<T> = (
  signal: AbortSignal,
  mutationAdmission: MachineMutationAdmission,
) => T | Promise<T>;

export async function runAgentAction<T>(
  verb: string,
  args: Readonly<Record<string, unknown>>,
  action: AgentAction<T>,
  options?: AgentActionOptions<T>,
): Promise<T> {
  const state = useKernelStore.getState();
  const ownershipAcquisition = options?.allowWhileBlocked === true && verb === "machine_take_over";
  if (machineInteractionBlocked(state.machineOwnership) && !ownershipAcquisition) {
    throw new Error(machineAdmissionError(state.machineOwnership));
  }
  // Takeover is the sole blocked exception and does not receive ordinary mutation authority.
  const mutationAdmission = ownershipAcquisition
    ? undefined
    : captureMachineMutationAdmission("agent");

  const actionLifecycle = beginOwnedAgentAction();
  const { controller } = actionLifecycle;
  state.recordActivity();
  state.wakeScreensaver();
  let event = state.osEvent("agent", verb, { ...args });
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortReason(controller.signal)), { once: true });
  });

  try {
    const invokeAction = () => mutationAdmission === undefined
      ? (action as (signal: AbortSignal) => T | Promise<T>)(controller.signal)
      : action(controller.signal, mutationAdmission);
    const result = await Promise.race([
      Promise.resolve().then(invokeAction),
      aborted,
    ]);
    throwIfAborted(controller.signal);
    const currentOwnership = useKernelStore.getState().machineOwnership;
    if (machineInteractionBlocked(currentOwnership) && !ownershipAcquisition) {
      throw ownershipError();
    }
    if (options?.resultArgs) {
      event = useKernelStore.getState().annotateEvent(event, options.resultArgs(result));
    }
    useKernelStore.getState().settleEvent(event, true);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    useKernelStore.getState().settleEvent(event, false, reason);
    throw error;
  } finally {
    actionLifecycle.release();
  }
}
