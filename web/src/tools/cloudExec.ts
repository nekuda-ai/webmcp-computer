import { defineTool } from "@nekuda/webmcp-sdk";
import {
  type CloudExecDependencies,
  type CloudExecRequest,
  type CloudExecResult,
  shellQuote,
} from "../kernel/cloudExec";
import { useKernelStore } from "../kernel/store";
import { assertMachineMutationAdmission } from "../kernel/ownershipAdmission";
import { terminalSession } from "../kernel/terminalSessions";
import { runAgentAction } from "./agentAction";
import { TRANSACT_ANNOTATIONS } from "./taxonomy";
import { resolveTermExecPid, truncateTerminalOutput } from "./terminalTools";

type CloudExecToolInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

const MAX_COMMAND_BYTES = 8 * 1_024;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const LOCAL_TIMEOUT_GRACE_MS = 30_000;
const encoder = new TextEncoder();

function cloudExecFailure(reason: string): Error {
  const detail = reason.replace(/^webmcp-computer:\s*/, "").replace(/[\r\n]+/g, " ").trim();
  return new Error(`webmcp-computer: cloud exec failed: ${detail || "unknown error"}`);
}

function requireInput(input: unknown): CloudExecRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw cloudExecFailure("input must be an object");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["command", "cwd", "timeoutMs"]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw cloudExecFailure(`input contains unknown field: ${unknown}`);
  if (typeof record.command !== "string" || record.command.trim() === "") {
    throw cloudExecFailure("command must be a non-empty string");
  }
  if (encoder.encode(record.command).byteLength > MAX_COMMAND_BYTES) {
    throw cloudExecFailure("command exceeds 8192-byte cap");
  }
  const cwd = record.cwd ?? "/workspace";
  if (
    typeof cwd !== "string" || cwd.includes("\0") ||
    (cwd !== "/workspace" && !cwd.startsWith("/workspace/")) ||
    cwd.endsWith("/") || cwd.includes("//") ||
    cwd.split("/").some((part) => part === "." || part === "..")
  ) {
    throw cloudExecFailure("cwd must be /workspace or a directory below it");
  }
  if (
    record.timeoutMs !== undefined &&
    (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 1 ||
      (record.timeoutMs as number) > MAX_TIMEOUT_MS)
  ) {
    throw cloudExecFailure("timeoutMs must be an integer from 1 to 600000");
  }
  return {
    command: record.command,
    cwd,
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs as number }),
  };
}

export function createCloudExecTool(dependencies?: CloudExecDependencies) {
  return defineTool<CloudExecToolInput>({
    stableKey: "webmcp_computer.cloud_exec",
    name: "cloud_exec",
    title: "Execute cloud command",
    description:
      "Visibly execute one command in the WebMCP Computer cloud container when the cloud kernel is active. Returns exitCode, stdout, stderr, pushed, pulled, and truncated after ordered output appears in Terminal; stdout and stderr are each capped at 256 KB. cwd defaults to /workspace and must stay below it; timeoutMs defaults to 300000 and caps at 600000. node_modules is container-only and is lost when the container restarts.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_BYTES,
          description: "Command string to execute in the cloud container.",
        },
        cwd: {
          type: "string",
          pattern: "^/workspace(?:/[^/]+)*$",
          description: "Absolute cloud working directory below /workspace; defaults to /workspace.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: "Execution timeout in milliseconds; defaults to 300000 and caps at 600000.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: TRANSACT_ANNOTATIONS,
    intent: "transact",
    execute(input) {
      return runAgentAction(
        "cloud_exec",
        {
          command: input?.command,
          ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input?.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          appId: "terminal",
        },
        async (signal, mutationAdmission) => {
          const request = requireInput(input);
          assertMachineMutationAdmission(mutationAdmission);
          const pid = resolveTermExecPid(undefined);
          useKernelStore.getState().focus(pid);
          const session = terminalSession(pid);
          await session.waitForView();
          const remote: { result?: CloudExecResult } = {};
          const result = await session.run(`cloud ${shellQuote(request.command)}`, "agent", {
            timeoutMs: (request.timeoutMs ?? DEFAULT_TIMEOUT_MS) + LOCAL_TIMEOUT_GRACE_MS,
            signal,
            ownershipAdmission: mutationAdmission,
            ...(dependencies === undefined ? {} : { cloudExecDependencies: dependencies }),
            cloudExecRequest: request,
            onCloudExecResult(value) {
              remote.result = value;
            },
          });
          const remoteResult = remote.result;
          if (!remoteResult) {
            const message = result.stderr.trim();
            if (message.startsWith("webmcp-computer: cloud exec failed:")) throw new Error(message);
            throw cloudExecFailure(message || "command ended without an exit event");
          }
          const stdout = truncateTerminalOutput(remoteResult.stdout);
          const stderr = truncateTerminalOutput(remoteResult.stderr);
          return {
            exitCode: remoteResult.exitCode,
            stdout: stdout.value,
            stderr: stderr.value,
            pushed: remoteResult.pushed,
            pulled: remoteResult.pulled,
            truncated: remoteResult.truncated || stdout.truncated || stderr.truncated,
          };
        }
      );
    },
  });
}

export const cloudExecTool = createCloudExecTool();
