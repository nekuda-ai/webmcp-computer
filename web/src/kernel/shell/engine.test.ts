import { beforeEach, describe, expect, test } from "bun:test";
import {
  initializeMemoryFileSystem,
  readFile,
  watch,
  writeFile,
  type FileSystemChange,
} from "../fs";
import { kernelProcessContext } from "../processContext";
import { resetKernelStore, useKernelStore } from "../store";
import { setTerminalShellExecutor, TerminalSessionController } from "../terminalSessions";
import { executeShell } from "./engine";
import { getShellCommand } from "./registry";
import { createShellSession, type ShellSession } from "./types";

setTerminalShellExecutor(executeShell);

describe("M8 just-bash shell engine", () => {
  let session: ShellSession;

  beforeEach(async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();
    session = createShellSession();
  });

  const run = (command: string) => executeShell(command, session, kernelProcessContext);

  test("executes quoting, redirects, append, and shared filesystem reads", async () => {
    const result = await run(
      "printf '%s\\n' 'quiet sky' > ~/site/log.txt; echo aurora >> ~/site/log.txt; cat < ~/site/log.txt",
    );

    expect(result).toEqual({ stdout: "quiet sky\naurora\n", stderr: "", exitCode: 0 });
    expect(await readFile("~/site/log.txt")).toBe("quiet sky\naurora\n");
  });

  test("pipes through native grep, sort, and wc", async () => {
    const result = await run("printf 'beta\\nalpha\\nbeta\\n' | grep beta | sort -u | wc -l");

    expect(result).toEqual({ stdout: "1\n", stderr: "", exitCode: 0 });
  });

  test("short-circuits && and || with native exit status", async () => {
    expect(await run("false && echo hidden || echo recovered")).toEqual({
      stdout: "recovered\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await run("true || echo hidden")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test("persists exported variables and last status between session executions", async () => {
    expect((await run("export TRAIL=aurora; false; echo $TRAIL:$?")).stdout).toBe("aurora:1\n");
    expect((await run("echo $TRAIL:$?")).stdout).toBe("aurora:0\n");
    expect(session.env.TRAIL).toBe("aurora");
    expect((await run("false")).exitCode).toBe(1);
    expect((await run("echo $?")).stdout).toBe("1\n");
  });

  test("keeps the status parameter out of env output and persisted session env", async () => {
    const result = await run("env");

    expect(result.stdout.split("\n")).not.toContain("?=0");
    expect(session.env).not.toHaveProperty("?");
  });

  test("supports command substitution and isolated subshell cwd", async () => {
    expect((await run("echo \"trail=$(printf north)\"")).stdout).toBe("trail=north\n");
    const result = await run("(cd ~/site; printf '%s' \"$PWD\"); printf '|%s\\n' \"$PWD\"");
    expect(result).toEqual({
      stdout: "/site|/\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("keeps WebMCP Computer home at the single POSIX root", async () => {
    expect((await run("cd ..; pwd")).stdout).toBe("/\n");
    expect(session.cwd).toBe("~");
    expect((await run("cd /; pwd")).stdout).toBe("/\n");
    expect(session.cwd).toBe("~");
    expect((await run("cd ../..; pwd")).stdout).toBe("/\n");
    expect(session.cwd).toBe("~");

    expect((await run("mkdir -p /etc; echo absolute > /etc/x")).exitCode).toBe(0);
    expect(await readFile("~/etc/x")).toBe("absolute\n");
    expect(await run("pwd; cat /etc/x")).toEqual({
      stdout: "/\nabsolute\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("round-trips kernel JSON through jq and awk", async () => {
    await writeFile(
      "~/site/trails.json",
      JSON.stringify({ trails: [{ name: "Ridge", price: 89 }, { name: "Summit", price: 189 }] }),
      "system",
    );

    const result = await run(
      "jq -r '.trails[] | [.name, .price] | @tsv' ~/site/trails.json | awk -F '\\t' '$2 >= 100 { print $1 }'",
    );
    expect(result).toEqual({ stdout: "Summit\n", stderr: "", exitCode: 0 });

    expect((await run("jq '.trails | map(.price)' ~/site/trails.json > ~/site/prices.json")).exitCode)
      .toBe(0);
    expect(JSON.parse(await readFile("~/site/prices.json"))).toEqual([89, 189]);
  });

  test("runs grep, sed, and awk directly against kernel files", async () => {
    await writeFile("~/notes/lines.txt", "Alpha 2\nbeta 7\nGamma 11\n", "system");
    const result = await run(
      "grep -i 'a' ~/notes/lines.txt | sed 's/^/row:/' | awk '$2 >= 7 { print $1, $2 }'",
    );
    expect(result).toEqual({ stdout: "row:beta 7\nrow:Gamma 11\n", stderr: "", exitCode: 0 });
  });

  test("syncs native cwd back to session and terminal process store", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    useKernelStore.getState().setProcessCwd(process.pid, "~/notes");
    const controller = new TerminalSessionController(process.pid);

    expect((await controller.run("cd ~/site; pwd", "human", { typeDelayMs: 0 })).stdout).toBe(
      "/site\n",
    );
    expect(controller.shell.cwd).toBe("~/site");
    expect(useKernelStore.getState().processes.find(({ pid }) => pid === process.pid)?.cwd).toBe(
      "~/site",
    );
  });

  test("pins native command-not-found and syntax exit codes", async () => {
    expect(await run("missing-command")).toEqual({
      stdout: "",
      stderr: "bash: missing-command: command not found\n",
      exitCode: 127,
    });
    expect(await run("if then")).toEqual({
      stdout: "",
      stderr: expect.stringContaining("bash: syntax error:"),
      exitCode: 2,
    });
  });

  test("resolves bundled commands through the standard PATH", async () => {
    expect(await run("which jq")).toEqual({
      stdout: "/usr/bin/jq\n",
      stderr: "",
      exitCode: 0,
    });
    expect(session.env).toEqual(expect.objectContaining({
      OSTYPE: expect.any(String),
      MACHTYPE: expect.any(String),
      HOSTTYPE: expect.any(String),
    }));
  });

  test("reports directories truthfully through cat", async () => {
    const result = await run("cat /site");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("is a directory");
  });

  test("aborts a running pipeline and removes its transient process", async () => {
    const controller = new AbortController();
    const running = executeShell("sleep 5 | cat", session, kernelProcessContext, {
      signal: controller.signal,
    });
    controller.abort();

    expect(await running).toEqual({
      stdout: "",
      stderr: "bash: execution aborted\n",
      exitCode: 124,
    });
    expect(useKernelStore.getState().commandProcesses).toEqual([]);
  });

  test("keeps WebMCP Computer commands registered and opens a real app", async () => {
    const opened = await run("open files");
    const pid = Number(opened.stdout.match(/PID (\d+)/)?.[1]);

    expect(pid).toBeGreaterThanOrEqual(2);
    expect(useKernelStore.getState().processes).toContainEqual(
      expect.objectContaining({ pid, appId: "files" }),
    );
    expect((await run("ps")).stdout).toContain(`${String(pid).padStart(5, " ")} window  files`);
    useKernelStore.getState().minimize(pid);
    expect((await run("ps")).stdout).toContain(`${String(pid).padStart(5, " ")} window  files (minimized)`);
    useKernelStore.getState().focus(pid);
    expect((await run("ps")).stdout).not.toContain("(minimized)");
    expect((await run("kill 1")).stderr).toBe(
      "webmcp-computer: pid 1 is the screensaver; window pids start at 2\n",
    );
  });

  test("help lists native and WebMCP Computer command surfaces", async () => {
    const result = await run("help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/just-bash commands \(\d+\):/);
    expect(result.stdout).toContain("jq");
    expect(result.stdout).toContain("WebMCP Computer commands");
    expect(result.stdout).toContain("open");
    expect(result.stdout).toContain("standalone 'help [COMMAND]' is its alias");
    expect(result.stdout).not.toMatch(/\b(?:tar|yq|xan|sqlite3)\b/);
    expect((await run("help open")).stdout).toContain("Usage: open APP|PATH");
    expect((await run("help cd")).stdout).toContain("Change the shell working directory.");
    expect((await run("help jq")).stdout).toContain("Usage: jq");
    expect((await run("help | tail -4")).stdout).not.toContain("WebMCP Computer commands");
    expect((await run("os_help | tail -5")).stdout).toContain("WebMCP Computer commands");
  });

  test("clear preserves callback contract", async () => {
    let clears = 0;
    const result = await executeShell("clear", session, kernelProcessContext, {
      onClear: () => clears += 1,
    });

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0, clear: true });
    expect(clears).toBe(1);
  });

  test("attributes every shell write to execution source", async () => {
    const changes: FileSystemChange[] = [];
    const unwatch = watch((change) => changes.push(change));
    try {
      await executeShell("echo human > ~/site/human.txt", session, kernelProcessContext, {
        source: "human",
      });
      await executeShell("echo agent > ~/site/agent.txt", session, kernelProcessContext, {
        source: "agent",
      });
    } finally {
      unwatch();
    }

    expect(changes).toContainEqual({ operation: "write", path: "~/site/human.txt", source: "human" });
    expect(changes).toContainEqual({ operation: "write", path: "~/site/agent.txt", source: "agent" });
  });

  test("rejects concurrent execution on one shell session", async () => {
    const controller = new AbortController();
    const first = executeShell("sleep 5", session, kernelProcessContext, {
      signal: controller.signal,
    });

    await expect(run("echo overlapping")).rejects.toThrow(
      "webmcp-computer: shell session is already executing",
    );
    controller.abort();
    expect((await first).exitCode).toBe(124);
  });

  test("keeps command history bounded and streams combined output through same seam", async () => {
    session.history = Array.from({ length: 1_000 }, (_, index) => `old-${index}`);
    const chunks: string[] = [];
    const result = await executeShell("echo first; echo second", session, kernelProcessContext, {
      onStdout: (chunk) => chunks.push(chunk),
    });

    expect(result.stdout).toBe("first\nsecond\n");
    expect(chunks).toEqual(["first\nsecond\n"]);
    expect(session.history).toHaveLength(1_000);
    expect(session.history[0]).toBe("old-1");
    expect(session.history.at(-1)).toBe("echo first; echo second");
  });

  test("serves one Preview per kernel directory and records attributed events", async () => {
    await writeFile("~/site/index.html", "<h1>Aurora</h1>", "system");
    const first = await executeShell("serve ~/site", session, kernelProcessContext, { source: "agent" });
    const second = await executeShell("serve ~/site", session, kernelProcessContext, { source: "human" });

    expect(first.stdout).toBe("serving ~/site/ → preview (pid 3)\n");
    expect(second.stdout).toBe("serving ~/site/ → preview (pid 3)\n");
    // Non-cloud WebMCP Computer commands still map just-bash absolute paths into kernel
    // paths (the cloud passthrough is the only opt-out).
    const rewritten = await executeShell("serve /site", session, kernelProcessContext, { source: "human" });
    expect(rewritten.stdout).toBe("serving ~/site/ → preview (pid 3)\n");
    expect(useKernelStore.getState().processes.filter(({ appId }) => appId === "preview")).toHaveLength(1);
    expect(useKernelStore.getState().events.filter(({ verb }) => verb === "serve").map(({ source }) => source))
      .toEqual(["agent", "human", "human"]);
  });

  test("gates cloud execution on active cloud backend while help stays available", async () => {
    expect(await run("cloud echo hello")).toEqual({
      stdout: "",
      stderr: "webmcp-computer: cloud requires the cloud kernel (enable it in Settings, the machine reboots)\n",
      exitCode: 2,
    });
    expect((await run("cloud --help")).stdout).toContain("Usage: cloud <command...>");
  });

  test("passes cloud absolute paths unchanged and keeps only leading help flags local", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    const requests: unknown[] = [];
    const runCloud = (command: string) => executeShell(command, session, kernelProcessContext, {
      cloudExecDependencies: {
        async fetch(_input, init) {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            "event: exit\ndata: {\"code\":0,\"pushed\":0,\"pulled\":0,\"applied\":0,\"syncStatus\":\"complete\"}\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
        workerBaseUrl: "https://computer.test",
        workspaceId: "0123456789abcdef0123456789abcdef",
      },
    });

    expect((await runCloud("cloud --help")).stdout).toContain("Usage: cloud <command...>");
    expect((await runCloud("cloud -h")).stdout).toContain("Usage: cloud <command...>");
    expect(requests).toEqual([]);

    expect((await runCloud("cloud npm install --help")).exitCode).toBe(0);
    expect((await runCloud("cloud ls /workspace/site")).exitCode).toBe(0);
    expect(requests).toEqual([
      { command: "npm install --help", cwd: "/workspace" },
      { command: "ls /workspace/site", cwd: "/workspace" },
    ]);
  });

  test("emits exactly one filesystem refresh per completed cloud command and none on failure", async () => {
    // SDK 0.2.1 zeroes sync counts on resumed handles, so the shell refreshes
    // once per completed command regardless of the reported counts.
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    const changes: FileSystemChange[] = [];
    const unwatch = watch((change) => changes.push(change));
    try {
      const result = await executeShell("cloud echo unchanged", session, kernelProcessContext, {
        cloudExecDependencies: {
          async fetch() {
            return new Response(
              "event: exit\ndata: {\"code\":0,\"pushed\":0,\"pulled\":0,\"applied\":0,\"syncStatus\":\"complete\"}\n\n",
              { headers: { "Content-Type": "text/event-stream" } },
            );
          },
          workerBaseUrl: "https://computer.test",
          workspaceId: "0123456789abcdef0123456789abcdef",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(changes).toEqual([
        expect.objectContaining({ operation: "write", path: "~" }),
      ]);

      changes.length = 0;
      const failed = await executeShell("cloud echo broken", session, kernelProcessContext, {
        cloudExecDependencies: {
          async fetch() {
            return new Response("boom", { status: 500 });
          },
          workerBaseUrl: "https://computer.test",
          workspaceId: "0123456789abcdef0123456789abcdef",
        },
      });

      expect(failed.exitCode).not.toBe(0);
      expect(changes).toEqual([]);
    } finally {
      unwatch();
    }
  });

  test("caps streamed cloud output incrementally while forwarding every visible chunk", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    const chunk = "x".repeat(100 * 1_024);
    const visible: string[] = [];
    const payload = [chunk, chunk, chunk]
      .map((value) => `event: stdout\ndata: ${JSON.stringify(value)}\n\n`)
      .join("") +
      "event: exit\ndata: {\"code\":0,\"pushed\":0,\"pulled\":0,\"applied\":0,\"syncStatus\":\"complete\"}\n\n";

    const result = await executeShell("cloud large-output", session, kernelProcessContext, {
      onStdout: (value) => visible.push(value),
      cloudExecDependencies: {
        async fetch() {
          return new Response(payload, { headers: { "Content-Type": "text/event-stream" } });
        },
        workerBaseUrl: "https://computer.test",
        workspaceId: "0123456789abcdef0123456789abcdef",
      },
    });

    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(256 * 1_024);
    expect(visible).toEqual([chunk, chunk, chunk]);
  });

  test("maps cloud cwd, parses split SSE frames in order, and emits one coarse home change", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    session.cwd = "~/site";
    const requests: Array<{ url: string; body: unknown }> = [];
    const output: Array<{ tone: "output" | "error"; text: string }> = [];
    const changes: FileSystemChange[] = [];
    const unwatch = watch((change) => changes.push(change));
    const chunks = [
      "event: stdout\ndata: \"one\\n\"\n",
      "\nevent: stderr\ndata: \"warning\\n\"\n\nevent: std",
      "out\ndata: \"two\\n\"\n\nevent: exit\ndata: {\"code\":7,\"pushed\":2,",
      "\"pulled\":1,\"applied\":0,\"syncStatus\":\"complete\"}\n\n",
    ];

    try {
      const result = await executeShell("cloud printf remote", session, kernelProcessContext, {
        source: "agent",
        onStdout: (text) => output.push({ tone: "output", text }),
        onStderr: (text) => output.push({ tone: "error", text }),
        cloudExecDependencies: {
          async fetch(input, init) {
            requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return new Response(new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
              },
            }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
          },
          workerBaseUrl: "https://computer.test",
          workspaceId: "0123456789abcdef0123456789abcdef",
        },
      });

      expect(result).toEqual({
        stdout: "one\ntwo\n",
        stderr: "warning\n",
        exitCode: 7,
      });
      expect(output).toEqual([
        { tone: "output", text: "one\n" },
        { tone: "error", text: "warning\n" },
        { tone: "output", text: "two\n" },
      ]);
      expect(requests).toEqual([{
        url: "https://computer.test/ws/0123456789abcdef0123456789abcdef/exec",
        body: { command: "printf remote", cwd: "/workspace/site" },
      }]);
      expect(changes).toEqual([{ operation: "write", path: "~", source: "agent" }]);
    } finally {
      unwatch();
    }
  });

  test("rejects cloud cwd outside home before fetching", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    session.cwd = "/outside";
    let fetches = 0;
    const command = getShellCommand("cloud");
    expect(command).toBeDefined();
    if (!command) return;
    const running = command.run({
      session,
      stdin: "",
      source: "human",
      processes: kernelProcessContext,
      cloudExecDependencies: {
        async fetch() {
          fetches += 1;
          throw new Error("test: fetch must not run");
        },
        workerBaseUrl: "https://computer.test",
        workspaceId: "0123456789abcdef0123456789abcdef",
      },
      writeStdout() {},
      writeStderr() {},
    }, ["pwd"]);
    await expect(running).rejects.toThrow("webmcp-computer: cloud can only run inside the home directory");
    expect(fetches).toBe(0);
  });

  test("renders cloud SSE errors in house voice", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    const result = await executeShell("cloud pwd", session, kernelProcessContext, {
      cloudExecDependencies: {
        async fetch() {
          return new Response(
            "event: error\ndata: {\"error\":\"container unavailable\"}\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
        workerBaseUrl: "https://computer.test",
        workspaceId: "0123456789abcdef0123456789abcdef",
      },
    });
    expect(result).toEqual({
      stdout: "",
      stderr: "webmcp-computer: cloud exec failed: container unavailable\n",
      exitCode: 1,
    });
  });

  test("wraps a broken cloud response stream in house voice", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    const result = await executeShell("cloud pwd", session, kernelProcessContext, {
      cloudExecDependencies: {
        async fetch() {
          return new Response(new ReadableStream({
            start(controller) {
              controller.error(new Error("stream dropped"));
            },
          }), { headers: { "Content-Type": "text/event-stream" } });
        },
        workerBaseUrl: "https://computer.test",
        workspaceId: "0123456789abcdef0123456789abcdef",
      },
    });

    expect(result).toEqual({
      stdout: "",
      stderr: "webmcp-computer: cloud exec failed: stream dropped\n",
      exitCode: 1,
    });
  });

  test("aborts the cloud stream without leaving the shell busy", async () => {
    useKernelStore.setState({ fileSystemBackend: "cloud", fileSystemStatus: "ready" });
    const controller = new AbortController();
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const running = executeShell("cloud sleep 60", session, kernelProcessContext, {
      signal: controller.signal,
      cloudExecDependencies: {
        fetch(_input, init) {
          expect(init?.signal).toBe(controller.signal);
          markStarted();
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("stream aborted")), {
              once: true,
            });
          });
        },
        workerBaseUrl: "https://computer.test",
        workspaceId: "0123456789abcdef0123456789abcdef",
      },
    });
    await started;
    controller.abort();

    expect((await running).exitCode).not.toBe(0);
    expect(useKernelStore.getState().commandProcesses).toEqual([]);
  });

  test("Ctrl-C suppresses cloud abort errors and keeps exit 130", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    const controller = new TerminalSessionController(process.pid);
    const output: string[] = [];
    controller.attach((event) => {
      if (event.type === "output") output.push(event.text);
    });
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    setTerminalShellExecutor(async (_source, _session, _processes, options) => {
      markStarted();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const stderr = "webmcp-computer: cloud exec failed: This operation was aborted\n";
      options?.onStderr?.(stderr);
      return { stdout: "", stderr, exitCode: 1 };
    });
    try {
      const running = controller.run("cloud sleep 60", "human");
      await started;
      expect(controller.interrupt()).toBe(true);
      expect(await running).toEqual({ stdout: "", stderr: "", exitCode: 130 });
      expect(output).toEqual([]);
    } finally {
      setTerminalShellExecutor(executeShell);
    }
  });
});
