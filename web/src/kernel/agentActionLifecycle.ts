const inFlightAgentActions = new Set<AbortController>();

export const MACHINE_OWNERSHIP_LOST_ERROR =
  "webmcp-computer: machine ownership was lost to another tab";

function ownershipError(): Error {
  return new Error(MACHINE_OWNERSHIP_LOST_ERROR);
}

/** Register one action admitted under the current machine owner. */
export function beginOwnedAgentAction(): {
  controller: AbortController;
  release(): void;
} {
  const controller = new AbortController();
  inFlightAgentActions.add(controller);
  return {
    controller,
    release: () => inFlightAgentActions.delete(controller),
  };
}

/** Abort all work admitted under the previous machine owner. */
export function abortInFlightAgentActions(): void {
  for (const controller of [...inFlightAgentActions]) {
    controller.abort(ownershipError());
  }
}
