import { beforeEach, describe, expect, test } from "bun:test";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { abortInFlightAgentActions, runAgentAction } from "./agentAction";

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

  test("agent calls wake the screensaver without authorizing paid-resource heartbeats", async () => {
    useKernelStore.setState({ lastHumanActivityAt: 0 });
    await runAgentAction("sys_status", {}, () => ({ ok: true }));
    expect(useKernelStore.getState().screensaverActive).toBe(false);
    expect(useKernelStore.getState().lastHumanActivityAt).toBe(0);
  });

  test("ownership loss promptly rejects an in-flight action and marks its trace failed", async () => {
    let actionSignal: AbortSignal | undefined;
    let finish = () => {};
    const remote = new Promise<void>((resolve) => { finish = resolve; });
    const action = runAgentAction("browser_goto", {}, async (signal) => {
      actionSignal = signal;
      await remote;
      return "stale success";
    });

    abortInFlightAgentActions();
    await expect(action).rejects.toThrow("machine ownership was lost to another tab");
    expect(actionSignal?.aborted).toBe(true);
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      verb: "browser_goto",
      ok: false,
    }));
    finish();
    await Promise.resolve();
    expect(useKernelStore.getState().events.at(-1)?.ok).toBe(false);
  });
});
