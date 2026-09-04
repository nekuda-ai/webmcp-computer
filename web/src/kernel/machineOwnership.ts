export type MachineOwnership =
  | "pending"
  | "owned"
  | "conflict"
  | "unsupported"
  | "unavailable";

/** States in which local human and ordinary agent interaction must not start. */
export function machineInteractionBlocked(ownership: MachineOwnership): boolean {
  return ownership === "pending" || ownership === "conflict" || ownership === "unavailable";
}

/** Paid Browser leases are kept alive only under a confirmed exclusive lock. */
export function machineHeartbeatEligible(ownership: MachineOwnership): boolean {
  return ownership === "owned";
}

export function machineAdmissionError(ownership: MachineOwnership): string {
  switch (ownership) {
    case "pending":
      return "webmcp-computer: machine ownership is still being acquired; retry shortly";
    case "conflict":
      return "webmcp-computer: machine is active in another tab; select Take over here to continue";
    case "unavailable":
      return "webmcp-computer: machine ownership could not be established; reload to retry";
    case "owned":
    case "unsupported":
      return "webmcp-computer: machine action admission failed";
  }
}
