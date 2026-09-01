import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  textContent,
  typeInTerminal,
  waitForText,
  waitForWindow,
  waitForWindowGone,
} from "./harness";

type Process = {
  pid: number;
  kind: "window" | "command";
  command: string;
  appId?: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
};

export async function terminalScenario(page: Page): Promise<void> {
  const command = "echo shalom > ~/hi.txt && cat ~/hi.txt";
  const executing = executeWebMcpTool<ExecResult>(page, "term_exec", { command });

  await page.waitForSelector(".terminal-agent-row", { visible: true });
  await waitForText(page, ".terminal-agent-row", "CODEX");
  await waitForText(page, ".terminal-agent-command", "echo sh");
  expect(await textContent(page, ".terminal-agent-row")).toContain("codex@verbos:~$");

  expect(await executing).toEqual({
    stdout: "shalom\n",
    stderr: "",
    exit_code: 0,
    truncated: false,
  });
  expect(await executeWebMcpTool(page, "fs_read", { path: "~/hi.txt" })).toEqual({
    path: "~/hi.txt",
    content: "shalom\n",
  });

  const initialPs = await executeWebMcpTool<{ processes: Process[] }>(page, "ps");
  const terminal = initialPs.processes.find((process) => process.appId === "terminal");
  if (!terminal) throw new Error("VerbOS e2e terminal process not found");
  await waitForWindow(page, "Terminal", terminal.pid);

  await executeWebMcpTool(page, "window_resize", {
    pid: terminal.pid,
    width: 300,
    height: 210,
  });
  await page.waitForFunction(
    (pid) => {
      const shell = document.querySelector(`[aria-label="Terminal window, PID ${pid}"]`);
      const host = shell?.querySelector<HTMLElement>(".terminal-host");
      const rows = shell?.querySelector<HTMLElement>(".xterm-rows");
      if (!shell || !host || !rows) return false;
      const windowRect = shell.getBoundingClientRect();
      return windowRect.width === 300 && windowRect.height === 210 && rows.children.length === 6;
    },
    {},
    terminal.pid,
  );
  const minimumGeometry = await page.$eval(
    `[aria-label="Terminal window, PID ${terminal.pid}"]`,
    (shell) => {
      const host = shell.querySelector<HTMLElement>(".terminal-host");
      const rows = shell.querySelector<HTMLElement>(".xterm-rows");
      if (!host || !rows) throw new Error("terminal geometry unavailable");
      const hostRect = host.getBoundingClientRect();
      const rowsRect = rows.getBoundingClientRect();
      return {
        hostBottom: hostRect.bottom,
        rowsBottom: rowsRect.bottom,
        rowCount: rows.children.length,
      };
    },
  );
  expect(minimumGeometry).toEqual(expect.objectContaining({ rowCount: 6 }));
  expect(minimumGeometry.rowsBottom).toBeLessThanOrEqual(minimumGeometry.hostBottom - 8);
  await executeWebMcpTool(page, "window_resize", {
    pid: terminal.pid,
    width: 600,
    height: 350,
  });

  expect(
    await executeWebMcpTool<ExecResult>(page, "term_exec", {
      command: "uname -a",
      term_pid: terminal.pid,
    }),
  ).toEqual({
    stdout: "VerbOS 1.0 wasm32 (browser)\n",
    stderr: "",
    exit_code: 0,
    truncated: false,
  });

  await typeInTerminal(page, terminal.pid, "ls ~");
  const scrollback = await executeWebMcpTool<{ term_pid: number; lines: string[] }>(
    page,
    "term_read",
    { term_pid: terminal.pid, lines: 30 },
  );
  expect(scrollback.lines.some((line) => line.includes("hi.txt"))).toBe(true);

  const humanPipeline = "printf 'beta\\nalpha\\nbeta\\n' | grep beta | sort -u";
  await typeInTerminal(page, terminal.pid, humanPipeline);
  await page.waitForFunction(
    (pid) => [...document.querySelectorAll(
      `.terminal-app[data-terminal-pid="${pid}"] .xterm-rows > div`,
    )].some((row) => row.textContent?.trim() === "beta"),
    {},
    String(terminal.pid),
  );

  await executeWebMcpTool(page, "fs_write", {
    path: "~/site/trails.json",
    content: '{"trails":[{"name":"Ridge","price":89},{"name":"Summit","price":189}]}',
  });
  expect(
    await executeWebMcpTool<ExecResult>(page, "term_exec", {
      command: "jq -r '.trails[] | select(.price > 100) | .name' ~/site/trails.json",
      term_pid: terminal.pid,
    }),
  ).toEqual({
    stdout: "Summit\n",
    stderr: "",
    exit_code: 0,
    truncated: false,
  });

  await typeInTerminal(page, terminal.pid, "echo shared-kernel > ~/site/from-terminal.txt");
  expect(await executeWebMcpTool(page, "fs_read", { path: "~/site/from-terminal.txt" })).toEqual({
    path: "~/site/from-terminal.txt",
    content: "shared-kernel\n",
  });

  const files = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "files" });
  await waitForWindow(page, "Files", files.pid);
  const beforeKill = await executeWebMcpTool<{ processes: Process[] }>(page, "ps");
  expect(beforeKill.processes).toContainEqual(
    expect.objectContaining({ pid: files.pid, kind: "window", appId: "files" }),
  );
  expect(await executeWebMcpTool(page, "kill", { pid: files.pid })).toEqual(
    expect.objectContaining({ killed: true, pid: files.pid, kind: "window", appId: "files" }),
  );
  await waitForWindowGone(page, "Files", files.pid);
  const afterKill = await executeWebMcpTool<{ processes: Process[] }>(page, "ps");
  expect(afterKill.processes.some(({ pid }) => pid === files.pid)).toBe(false);

  const dmesg = await executeWebMcpTool<ExecResult>(page, "term_exec", {
    command: "dmesg",
    term_pid: terminal.pid,
  });
  expect(dmesg.exit_code).toBe(0);
  expect(dmesg.stdout).toContain("[agent] term_exec");
  expect(dmesg.stdout).toContain("[agent] fs_read");
  expect(dmesg.stdout).toContain("[agent] kill");
}
