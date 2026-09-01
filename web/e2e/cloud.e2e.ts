import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import type { FakeComputer } from "./fakeComputer";
import {
  executeWebMcpTool,
  reloadVerbOS,
  waitForFileSystemReady,
  waitForText,
} from "./harness";

type SettingsResult = { cloud_kernel: boolean; note?: string };
type StatusResult = { fs_backend: string | null };
type ExecResult = { stdout: string; stderr: string; exit_code: number; truncated: boolean };
type PublishResult = { url: string; files: number; bytes: number };
type ListResult = { entries: Array<{ name: string }> };

export async function cloudKernelScenario(page: Page, fake: FakeComputer): Promise<void> {
  await waitForFileSystemReady(page);

  const enabled = await executeWebMcpTool<SettingsResult>(page, "settings_set", {
    key: "cloud_kernel",
    value: true,
  });
  expect(enabled).toEqual(expect.objectContaining({
    cloud_kernel: true,
    note: "reboot required — the machine restarts to remount its filesystem",
  }));

  await reloadVerbOS(page, BOOT_TOOL_NAMES);
  await waitForFileSystemReady(page);
  expect((await executeWebMcpTool<StatusResult>(page, "sys_status")).fs_backend).toBe("cloud");
  await waitForText(page, ".menu-bar__cloud", "CLOUD");

  await executeWebMcpTool(page, "fs_write", {
    path: "~/notes/proof.txt",
    content: "from fs_write\n",
  });
  const shell = await executeWebMcpTool<ExecResult>(page, "term_exec", {
    command: "echo cloud > ~/notes/proof.txt; cat ~/notes/proof.txt",
  });
  expect(shell).toEqual(expect.objectContaining({ stdout: "cloud\n", stderr: "", exit_code: 0 }));
  expect(fake.readWorkspaceText("/workspace/notes/proof.txt")).toBe("cloud\n");

  const html = "<!doctype html><title>M10 cloud</title><h1>Published from VerbOS</h1>";
  await executeWebMcpTool(page, "fs_write", { path: "~/site/index.html", content: html });
  const published = await executeWebMcpTool<PublishResult>(page, "os_publish", {});
  expect(published).toEqual(expect.objectContaining({ files: 1, bytes: new TextEncoder().encode(html).byteLength }));
  expect(published.url.startsWith(`${fake.origin}/s/fake`)).toBe(true);
  expect(await (await fetch(published.url)).text()).toBe(html);
  await page.waitForSelector(".agent-toast.is-publish.is-visible .agent-toast__qr svg", { visible: true });

  const dmesg = await executeWebMcpTool<ExecResult>(page, "term_exec", { command: "dmesg" });
  expect(dmesg.stdout).toContain("[agent] os_publish");

  const disabled = await executeWebMcpTool<SettingsResult>(page, "settings_set", {
    key: "cloud_kernel",
    value: false,
  });
  expect(disabled.cloud_kernel).toBe(false);
  await reloadVerbOS(page, BOOT_TOOL_NAMES);
  await waitForFileSystemReady(page);
  expect((await executeWebMcpTool<StatusResult>(page, "sys_status")).fs_backend).toBe("local (opfs)");
  expect(await page.$(".menu-bar__cloud")).toBeNull();
  const localNotes = await executeWebMcpTool<ListResult>(page, "fs_list", { path: "~/notes" });
  expect(localNotes.entries.some(({ name }) => name === "proof.txt")).toBe(false);

  await executeWebMcpTool<SettingsResult>(page, "settings_set", {
    key: "cloud_kernel",
    value: true,
  });
  await fake.stop();
  await reloadVerbOS(page, BOOT_TOOL_NAMES);
  await waitForFileSystemReady(page);
  expect((await executeWebMcpTool<StatusResult>(page, "sys_status")).fs_backend).toBe("local (opfs)");
  await waitForText(page, ".machine-banner", "FILESYSTEM: cloud backend unavailable");
}
