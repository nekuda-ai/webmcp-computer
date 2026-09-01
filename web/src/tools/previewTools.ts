import { defineTool } from "@nekuda/webmcp-sdk";
import { getPreviewRuntime } from "../apps/preview/runtime";
import { resolveAppTarget } from "./appTarget";
import { runAgentAction } from "./agentAction";
import { ACT_ANNOTATIONS, ASK_ANNOTATIONS } from "./taxonomy";

type PreviewInput = { pid?: number };

function targetPreview(rawPid: unknown) {
  const process = resolveAppTarget("preview", rawPid);
  return { process, runtime: getPreviewRuntime(process.pid) };
}

const inputSchema = {
  type: "object",
  properties: {
    pid: { type: "integer", minimum: 2, description: "Optional PID of an open Preview window." },
  },
  additionalProperties: false,
} as const;

export const previewGetConsoleTool = defineTool<PreviewInput>({
  stableKey: "verbos.preview_get_console",
  name: "preview_get_console",
  title: "Read Preview console",
  description:
    "Return a snapshot of the 200 most recent console lines, uncaught errors, and unhandled rejections from the frontmost Preview. Returns truncated and dropped when older or rate-limited lines are outside that window. Pass pid when multiple Preview windows exist.",
  inputSchema,
  annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
  intent: "answer",
  execute(input) {
    const rawPid = input?.pid;
    return runAgentAction("preview_get_console", {
      appId: "preview",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, () => {
      const { process, runtime } = targetPreview(rawPid);
      return {
        pid: process.pid,
        url: runtime.url,
        lines: runtime.lines.map((line) => ({ ...line })),
        truncated: runtime.dropped > 0,
        dropped: runtime.dropped,
      };
    });
  },
});

export const previewReloadTool = defineTool<PreviewInput>({
  stableKey: "verbos.preview_reload",
  name: "preview_reload",
  title: "Reload Preview",
  description:
    "Reload the frontmost Preview from its served VerbOS directory. Pass pid when multiple Preview windows exist.",
  inputSchema,
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute(input) {
    const rawPid = input?.pid;
    return runAgentAction("preview_reload", {
      appId: "preview",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, async () => {
      const { process, runtime } = targetPreview(rawPid);
      await runtime.reload();
      return { reloaded: true, pid: process.pid, url: runtime.url };
    });
  },
});

export const previewGetUrlTool = defineTool<PreviewInput>({
  stableKey: "verbos.preview_get_url",
  name: "preview_get_url",
  title: "Read Preview URL",
  description:
    "Read the verbos:// address and served filesystem root of the frontmost Preview. Pass pid when multiple Preview windows exist.",
  inputSchema,
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    const rawPid = input?.pid;
    return runAgentAction("preview_get_url", {
      appId: "preview",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, () => {
      const { process, runtime } = targetPreview(rawPid);
      return { pid: process.pid, url: runtime.url, root: runtime.root };
    });
  },
});

export const previewTools = [
  previewGetConsoleTool,
  previewReloadTool,
  previewGetUrlTool,
] as const;
