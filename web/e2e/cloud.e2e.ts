import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import type { FakeComputer } from "./fakeComputer";
import {
  executeWebMcpTool,
  reloadWebMCPComputer,
  waitForFileSystemReady,
  waitForText,
} from "./harness";

type StatusResult = { fs_backend: string | null };
type ExecResult = { stdout: string; stderr: string; exit_code: number; truncated: boolean };
type PublishResult = { url: string; files: number; bytes: number };
type ListResult = { entries: Array<{ name: string }> };

export async function cloudKernelScenario(page: Page, fake: FakeComputer): Promise<void> {
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

  const html = "<!doctype html><title>M10 cloud</title><h1>Published from WebMCP Computer</h1>";
  await executeWebMcpTool(page, "fs_write", { path: "~/site/index.html", content: html });
  const published = await executeWebMcpTool<PublishResult>(page, "os_publish", {});
  expect(published).toEqual(expect.objectContaining({ files: 1, bytes: new TextEncoder().encode(html).byteLength }));
  expect(published.url.startsWith(`${fake.origin}/s/fake`)).toBe(true);
  expect(await (await fetch(published.url)).text()).toBe(html);
  await page.waitForSelector(".agent-toast.is-publish.is-visible .agent-toast__qr svg", { visible: true });

  const dmesg = await executeWebMcpTool<ExecResult>(page, "term_exec", { command: "dmesg" });
  expect(dmesg.stdout).toContain("[agent] os_publish");

  // Same signed-in identity remounts same cloud workspace after reload.
  await reloadWebMCPComputer(page, BOOT_TOOL_NAMES);
  await waitForFileSystemReady(page);
  expect((await executeWebMcpTool<StatusResult>(page, "sys_status")).fs_backend).toBe("cloud");
  const cloudNotes = await executeWebMcpTool<ListResult>(page, "fs_list", { path: "~/notes" });
  expect(cloudNotes.entries.some(({ name }) => name === "proof.txt")).toBe(true);

  // Auth remains valid, but an unavailable Computer Worker fails visibly to local.
  await fake.stop();
  await reloadWebMCPComputer(page, BOOT_TOOL_NAMES);
  await waitForFileSystemReady(page);
  expect((await executeWebMcpTool<StatusResult>(page, "sys_status")).fs_backend).toBe("local (opfs)");
  await waitForText(page, ".machine-banner", "FILESYSTEM: cloud backend unavailable");
}
