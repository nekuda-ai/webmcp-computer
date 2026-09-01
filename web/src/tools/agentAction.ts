import { useKernelStore } from "../kernel/store";

export async function runAgentAction<T>(
  verb: string,
  args: Readonly<Record<string, unknown>>,
  action: () => T | Promise<T>,
  options?: { resultArgs?: (result: T) => Record<string, unknown> },
): Promise<T> {
  const state = useKernelStore.getState();
  state.recordActivity();
  state.wakeScreensaver();
  let event = state.osEvent("agent", verb, { ...args });
  try {
    const result = await action();
    if (options?.resultArgs) {
      event = useKernelStore.getState().annotateEvent(event, options.resultArgs(result));
    }
    useKernelStore.getState().settleEvent(event, true);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    useKernelStore.getState().settleEvent(event, false, reason);
    throw error;
  }
}
