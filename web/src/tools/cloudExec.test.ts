import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { initializeMemoryFileSystem } from "../kernel/fs";
import { executeShell } from "../kernel/shell/engine";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import {
  resetTerminalSessions,
  setTerminalShellExecutor,
  terminalSession,
  type TerminalSessionEvent,
} from "../kernel/terminalSessions";
import type { CloudExecDependencies, CloudExecResult } from "../kernel/cloudExec";
import { createCloudExecTool } from "./cloudExec";

const WSID = "0123456789abcdef0123456789abcdef";

setTerminalShellExecutor(executeShell);

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

function dependencies(fetcher: CloudExecDependencies["fetch"]): CloudExecDependencies {
  return {
    fetch: fetcher,
    workerBaseUrl: "https://computer.test",
    workspaceId: WSID,
  };
}

describe("cloud_exec", () => {
  beforeEach(async () => {
    resetKernelStore();
    resetTerminalSessions();
    await initializeMemoryFileSystem();
    useKernelStore.getState().setFileSystemState("ready", "cloud");
  });

  afterEach(resetTerminalSessions);

  test("visibly streams ordered output and returns the structured remote result", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    const events: TerminalSessionEvent[] = [];
    terminalSession(process.pid).attach((event) => events.push(event));
    let requestUrl = "";
    let requestBody: unknown;
    const payload = [
      sse("stdout", "first\n"),
      sse("stderr", "warning\n"),
      sse("stdout", "last\n"),
      sse("exit", { code: 7, pushed: 2, pulled: 3, applied: 0, syncStatus: "complete" }),
    ].join("");
    const tool = createCloudExecTool(dependencies(async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return streamResponse([payload.slice(0, 19), payload.slice(19, 57), payload.slice(57)]);
    }));

    expect(await tool.execute({
      command: "printf first",
      cwd: "/workspace/project",
      timeoutMs: 12_345,
    })).toEqual({
      exitCode: 7,
      stdout: "first\nlast\n",
      stderr: "warning\n",
      pushed: 2,
      pulled: 3,
      truncated: false,
    });
    expect(requestUrl).toBe(`https://computer.test/ws/${WSID}/exec`);
    expect(requestBody).toEqual({
      command: "printf first",
      cwd: "/workspace/project",
      timeoutMs: 12_345,
    });
    expect(events.find((event) => event.type === "input")).toEqual(expect.objectContaining({
      type: "input",
      command: "cloud 'printf first'",
      source: "agent",
    }));
    expect(events.filter((event) => event.type === "output")).toEqual([
      { type: "output", text: "first\n", tone: "output" },
      { type: "output", text: "warning\n", tone: "error" },
      { type: "output", text: "last\n", tone: "output" },
    ]);
  });

  test("caps stdout and stderr independently at 256 KB", async () => {
    const chunk = "x".repeat(100 * 1_024);
    const tool = createCloudExecTool(dependencies(async () => streamResponse([
      sse("stdout", chunk),
      sse("stdout", chunk),
      sse("stdout", chunk),
      sse("stderr", chunk),
      sse("stderr", chunk),
      sse("stderr", chunk),
      sse("exit", { code: 0, pushed: 0, pulled: 0, applied: 0, syncStatus: "complete" }),
    ])));

    const result = await tool.execute({ command: "large-output" });
    expect(result).toEqual({
      exitCode: 0,
      stdout: "x".repeat(256 * 1_024),
      stderr: "x".repeat(256 * 1_024),
      pushed: 0,
      pulled: 0,
      truncated: true,
    });
  });

  test("adds a 30-second local grace window to the remote timeout", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    const session = terminalSession(process.pid);
    const remoteResult: CloudExecResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      pushed: 0,
      pulled: 0,
      applied: 0,
      syncStatus: "complete",
      truncated: false,
    };
    const run = spyOn(session, "run").mockImplementation(async (_command, _source, options) => {
      options?.onCloudExecResult?.(remoteResult);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createCloudExecTool(dependencies(async () => {
      throw new Error("test: terminal run owns fetch");
    }));

    await tool.execute({ command: "pwd", timeoutMs: 12_345 });

    expect(run.mock.calls[0]?.[2]?.timeoutMs).toBe(42_345);
  });

  test("rejects invalid input before contacting the Worker", async () => {
    let fetches = 0;
    const tool = createCloudExecTool(dependencies(async () => {
      fetches += 1;
      return new Response();
    }));

    await expect(tool.execute({ command: "   " })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: command must be a non-empty string",
    );
    await expect(tool.execute({ command: "é".repeat(4_097) })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: command exceeds 8192-byte cap",
    );
    await expect(tool.execute({ command: "pwd", cwd: "/tmp" })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cwd must be /workspace or a directory below it",
    );
    await expect(tool.execute({ command: "pwd", timeoutMs: 0 })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: timeoutMs must be an integer from 1 to 600000",
    );
    await expect(tool.execute({ command: "pwd", unexpected: true } as never)).rejects.toThrow(
      "webmcp-computer: cloud exec failed: input contains unknown field: unexpected",
    );
    expect(fetches).toBe(0);
  });

  test("surfaces Worker limit codes as explanations the agent can relay", async () => {
    const tool = createCloudExecTool(dependencies(async () => Response.json(
      { error: "budget exhausted", code: "EBUDGET", retryAfterMs: 90 * 60_000 },
      { status: 429 },
    )));
    await expect(tool.execute({ command: "pwd" })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud time budget (2 h per 24 h) is used up; resets in 1 h 30 min",
    );

    const busy = createCloudExecTool(dependencies(async () => streamResponse([
      sse("error", { error: "no slot", code: "ECAPACITY" }),
    ])));
    await expect(busy.execute({ command: "pwd" })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud is busy or at capacity right now; try again in a minute or keep working locally",
    );
  });

  test("requires cloud kernel and preserves cloud failure voice", async () => {
    const tool = createCloudExecTool(dependencies(async () => {
      throw new Error("should not fetch");
    }));
    useKernelStore.getState().setFileSystemState("ready", "opfs");
    await expect(tool.execute({ command: "pwd" })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud requires the cloud kernel (enable it in Settings, the machine reboots)",
    );

    useKernelStore.getState().setFileSystemState("ready", "cloud");
    await expect(tool.execute({ command: "pwd" })).rejects.toThrow(
      "webmcp-computer: cloud exec failed: should not fetch",
    );
  });
});
