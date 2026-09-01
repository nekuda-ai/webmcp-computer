import { describe, expect, test } from "bun:test";
import { machineIdentity } from "./identity";

describe("machine identity", () => {
  test("derives user and host from the persisted hostname setting", () => {
    expect(machineIdentity("builder@aurora")).toEqual({ user: "builder", host: "aurora" });
  });
});
