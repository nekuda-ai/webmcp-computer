import { beforeEach, describe, expect, test } from "bun:test";
import { initializeMemoryFileSystem, readFile, updateFile, writeFile } from "../kernel/fs";
import { loadSettings, SETTINGS_PATH, setSetting } from "../kernel/settings";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { abortInFlightAgentActions, runAgentAction } from "./agentAction";

describe("runAgentAction machine ownership", () => {
  beforeEach(() => resetKernelStore());

  test("refuses agent work while another tab owns the machine", async () => {
    useKernelStore.setState({ machineOwnership: "conflict" });
    let called = false;
    await expect(runAgentAction("fs_write", { path: "~/note" }, () => {
      called = true;
    })).rejects.toThrow("machine is active in another tab; select Take over here to continue");
    expect(called).toBe(false);
  });

  test("does not let ordinary verbs opt into the takeover-only exception", async () => {
    useKernelStore.setState({ machineOwnership: "pending" });
    let called = false;
    await expect(runAgentAction("fs_write", { path: "~/note" }, () => {
      called = true;
    }, { allowWhileBlocked: true })).rejects.toThrow("machine ownership is still being acquired");
    expect(called).toBe(false);
  });

  test("agent calls wake the screensaver without authorizing paid-resource heartbeats", async () => {
    useKernelStore.setState({ lastHumanActivityAt: 0 });
    await runAgentAction("sys_status", {}, () => ({ ok: true }));
    expect(useKernelStore.getState().screensaverActive).toBe(false);
    expect(useKernelStore.getState().lastHumanActivityAt).toBe(0);
  });

  test("a stale agent callback cannot write after ownership is reacquired", async () => {
    await initializeMemoryFileSystem();
    const path = "~/site/ownership-race.txt";
    await writeFile(path, "initial", "system");

    let releaseCallback = () => {};
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let markCallbackStarted = () => {};
    const callbackStarted = new Promise<void>((resolve) => { markCallbackStarted = resolve; });
    let markCallbackSettled = () => {};
    const callbackSettled = new Promise<void>((resolve) => { markCallbackSettled = resolve; });
    const action = runAgentAction("fs_write", { path }, async (_signal, mutationAdmission) => {
      markCallbackStarted();
      await callbackGate;
      try {
        await writeFile(path, "stale agent", mutationAdmission);
      } finally {
        markCallbackSettled();
      }
    });

    await callbackStarted;
    useKernelStore.getState().setMachineOwnership("conflict");
    abortInFlightAgentActions();
    await expect(action).rejects.toThrow("machine ownership was lost to another tab");
    useKernelStore.getState().setMachineOwnership("owned");
    await writeFile(path, "new owner", "system");

    releaseCallback();
    await callbackSettled;
    expect(await readFile(path)).toBe("new owner");
  });

  test("a delayed agent update keeps its original admission", async () => {
    await initializeMemoryFileSystem();
    const path = "~/site/delayed-edit.txt";
    await writeFile(path, "initial", "system");

    let releaseUpdate = () => {};
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let markUpdateStarted = () => {};
    const updateStarted = new Promise<void>((resolve) => { markUpdateStarted = resolve; });
    let markUpdateSettled = () => {};
    const updateSettled = new Promise<void>((resolve) => { markUpdateSettled = resolve; });
    const action = runAgentAction("fs_edit", { path }, async (_signal, mutationAdmission) => {
      try {
        await updateFile(path, async () => {
          markUpdateStarted();
          await updateGate;
          return "stale edit";
        }, mutationAdmission);
      } finally {
        markUpdateSettled();
      }
    });

    await updateStarted;
    useKernelStore.getState().setMachineOwnership("conflict");
    abortInFlightAgentActions();
    await expect(action).rejects.toThrow("machine ownership was lost to another tab");
    useKernelStore.getState().setMachineOwnership("owned");
    const newOwnerWrite = writeFile(path, "new owner", "human");

    releaseUpdate();
    await updateSettled;
    await newOwnerWrite;
    expect(await readFile(path)).toBe("new owner");
  });

  test("a delayed settings action cannot apply after ownership is reacquired", async () => {
    await initializeMemoryFileSystem();
    await loadSettings();

    let releaseCallback = () => {};
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let markCallbackStarted = () => {};
    const callbackStarted = new Promise<void>((resolve) => { markCallbackStarted = resolve; });
    let markCallbackSettled = () => {};
    const callbackSettled = new Promise<void>((resolve) => { markCallbackSettled = resolve; });
    const action = runAgentAction("settings_set", { key: "theme" }, async (_signal, mutationAdmission) => {
      markCallbackStarted();
      await callbackGate;
      try {
        await setSetting("theme", "dark", mutationAdmission);
      } finally {
        markCallbackSettled();
      }
    });

    await callbackStarted;
    useKernelStore.getState().setMachineOwnership("conflict");
    abortInFlightAgentActions();
    await expect(action).rejects.toThrow("machine ownership was lost to another tab");
    useKernelStore.getState().setMachineOwnership("owned");
    await setSetting("hostname", "owner@new", "human");

    releaseCallback();
    await callbackSettled;
    expect(JSON.parse(await readFile(SETTINGS_PATH))).toEqual(expect.objectContaining({
      theme: "light",
      hostname: "owner@new",
    }));
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
