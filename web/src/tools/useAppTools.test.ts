import { describe, expect, test } from "bun:test";
import { shouldWarnAppToolRegistration } from "./useAppTools";

describe("useAppTools", () => {
  test("suppresses stale registration warnings after StrictMode cleanup", () => {
    const incomplete = [{ state: "failed" }];
    expect(shouldWarnAppToolRegistration(true, incomplete)).toBe(true);
    expect(shouldWarnAppToolRegistration(false, incomplete)).toBe(false);
    expect(shouldWarnAppToolRegistration(true, [{ state: "registered" }])).toBe(false);
  });
});
