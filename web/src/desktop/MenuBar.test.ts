import { describe, expect, test } from "bun:test";
import { agentSurfaceLabel } from "./MenuBar";

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
