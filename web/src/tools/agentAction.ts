import {
  beginOwnedAgentAction,
  MACHINE_OWNERSHIP_LOST_ERROR,
} from "../kernel/agentActionLifecycle";
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

export async function runAgentAction<T>(
  verb: string,
  args: Readonly<Record<string, unknown>>,
  action: (signal: AbortSignal) => T | Promise<T>,
  options?: {
    resultArgs?: (result: T) => Record<string, unknown>;
    /** Reserved for the ownership-acquisition tool, which must be callable while blocked. */
    allowWhileBlocked?: boolean;
  },
): Promise<T> {
  const state = useKernelStore.getState();
  if (state.machineConflict && !options?.allowWhileBlocked) {
    throw new Error("webmcp-computer: machine is active in another tab; select Take over here to continue");
  }

  const actionLifecycle = beginOwnedAgentAction();
  const { controller } = actionLifecycle;
  state.recordActivity();
  state.wakeScreensaver();
  let event = state.osEvent("agent", verb, { ...args });
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortReason(controller.signal)), { once: true });
  });

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      aborted,
    ]);
    throwIfAborted(controller.signal);
    if (useKernelStore.getState().machineConflict && !options?.allowWhileBlocked) {
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
