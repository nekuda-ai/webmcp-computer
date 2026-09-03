import { beforeEach, describe, expect, test } from "bun:test";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { runAgentAction } from "./agentAction";

describe("runAgentAction machine ownership", () => {
  beforeEach(() => resetKernelStore());

  test("refuses agent work while another tab owns the machine", async () => {
    useKernelStore.setState({ machineConflict: true });
    let called = false;
    await expect(runAgentAction("fs_write", { path: "~/note" }, () => {
      called = true;
    })).rejects.toThrow("machine is active in another tab; select Take over here to continue");
    expect(called).toBe(false);
  });
});
