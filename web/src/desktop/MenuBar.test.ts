import { describe, expect, test } from "bun:test";
import { agentSurfaceLabel, formatLeaseRemaining, friendlyMachineId } from "./MenuBar";

describe("menu bar agent surface status", () => {
  test("shows none, partial count, and hides a complete registration", () => {
    expect(agentSurfaceLabel([{ name: "one", state: "failed" }])).toBe("AGENT SURFACE: NONE");
    expect(
      agentSurfaceLabel([
        { name: "one", state: "registered" },
        { name: "two", state: "failed" },
      ]),
    ).toBe("AGENT SURFACE: 1/2");
    expect(agentSurfaceLabel([{ name: "one", state: "registered" }])).toBeUndefined();
  });
});

describe("menu bar anonymous machine identity", () => {
  test("shows a compact stable machine ID and lease countdown", () => {
    expect(friendlyMachineId("0123456789abcdef0123456789abcdef")).toBe("012-34");
    expect(formatLeaseRemaining(1_900, 1_000_000)).toBe("15:00");
    expect(formatLeaseRemaining(1_900, 1_899_001)).toBe("00:01");
    expect(formatLeaseRemaining(1_900, 1_901_000)).toBe("ENDED");
  });
});
