import { defineTool, type AnyWebMCPTool } from "@nekuda/webmcp-sdk";
import {
  exists,
  joinPath,
  mkdir,
  normalizePath,
  stat,
  writeFile,
} from "../kernel/fs";
import { useKernelStore } from "../kernel/store";
import {
  assertMachineMutationAdmission,
  type MachineMutationAdmission,
} from "../kernel/ownershipAdmission";
import type { WindowRect } from "../kernel/types";
import { currentViewport } from "../kernel/windowGeometry";
import { setUiToolGrant } from "../apps/ui/runtime";
import { runAgentAction } from "./agentAction";
import { ACT_ANNOTATIONS } from "./taxonomy";
import { activeToolDefinitions } from "./toolCatalog";
import { requireFinite } from "../shared";

export const MAX_UI_HTML_BYTES = 256 * 1_024;
export const MAX_UI_GRANT_TOOLS = 16;

export function isUiToolAllowedDefinition(tool: AnyWebMCPTool): boolean {
  return tool.intent !== "transact" &&
    !tool.name.startsWith("site_") &&
    tool.name !== "ui_open";
}

type UiOpenInput = {
  name: string;
  html?: string;
  path?: string;
  allowTools?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  focus?: boolean;
};

function requireName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 40 ||
    !/^[a-z0-9][a-z0-9-_]*$/i.test(value)
  ) {
    throw new Error(
      `webmcp-computer: invalid UI app name '${String(value)}'; expected 1-40 letters, numbers, hyphens, or underscores starting with a letter or number`,
    );
  }
  return value;
}

function requireAllowTools(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_UI_GRANT_TOOLS ||
    value.some((tool) => typeof tool !== "string")
  ) {
    throw new Error(
      `webmcp-computer: allowTools for '${name}' must be an array of at most ${MAX_UI_GRANT_TOOLS} tool names`,
    );
  }
  return value;
}

function grantedToolNames(requested: readonly string[]): string[] {
  const active = new Map(activeToolDefinitions().map((tool) => [tool.name, tool]));
  return requested.filter((name, index) => {
    if (requested.indexOf(name) !== index) return false;
    const tool = active.get(name);
    return tool !== undefined && isUiToolAllowedDefinition(tool);
  });
}

async function ensureAppsDirectory(admission: MachineMutationAdmission): Promise<void> {
  if (!await exists("~/apps")) {
    await mkdir("~/apps", admission);
    return;
  }
  const target = await stat("~/apps");
  if (target.kind !== "directory") throw new Error("webmcp-computer: not a directory: ~/apps");
}

export const uiOpenTool = defineTool<UiOpenInput>({
  stableKey: "webmcp_computer.ui_open",
  name: "ui_open",
  title: "Open agent-made app",
  description:
    "Create or open an agent-made HTML app in a visible WebMCP Computer window. Pass exactly one of html or an existing ~-rooted .html path; inline HTML is written to ~/apps/<name>.html and remains live-editable by the human. The app runs in an opaque allow-scripts sandbox with no same-origin or popup access. Its HTML may publish site_* WebMCP tools through document.modelContext. allowTools defaults to an empty inward grant and may expose active non-transact OS tools; transact tools, site_* tools, unknown tools, and ui_open are always excluded. Returns PID, file path, applied rect, and the granted tool names.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 40,
        pattern: "^[A-Za-z0-9][A-Za-z0-9-_]*$",
        description: "File-safe app name used for inline HTML under ~/apps/.",
      },
      html: {
        type: "string",
        maxLength: MAX_UI_HTML_BYTES,
        description: "Complete HTML document, up to 256 KB UTF-8; mutually exclusive with path.",
      },
      path: {
        type: "string",
        description: "Existing ~-rooted .html text file; mutually exclusive with html.",
      },
      allowTools: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_UI_GRANT_TOOLS,
        description: "OS tool names the app may call; omitted means no tools.",
      },
      x: { type: "number", description: "Optional work-area horizontal position in CSS pixels." },
      y: { type: "number", description: "Optional work-area vertical position in CSS pixels." },
      width: { type: "number", description: "Optional window width in CSS pixels." },
      height: { type: "number", description: "Optional window height in CSS pixels." },
      focus: {
        type: "boolean",
        description: "Whether to focus the new window; defaults to true.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({
    name: rawName,
    html: rawHtml,
    path: rawPath,
    allowTools: rawAllowTools,
    x: rawX,
    y: rawY,
    width: rawWidth,
    height: rawHeight,
    focus: rawFocus,
  }) {
    return runAgentAction(
      "ui_open",
      {
        name: rawName,
        ...(rawPath === undefined ? {} : { path: rawPath }),
        ...(rawAllowTools === undefined ? {} : { allowTools: rawAllowTools }),
      },
      async (_signal, mutationAdmission) => {
        const name = requireName(rawName);
        const hasHtml = rawHtml !== undefined;
        const hasPath = rawPath !== undefined;
        if (hasHtml === hasPath) {
          throw new Error(
            `webmcp-computer: ui_open for '${name}' requires exactly one of html or path`,
          );
        }
        const allowTools = requireAllowTools(rawAllowTools, name);
        if (rawFocus !== undefined && typeof rawFocus !== "boolean") {
          throw new Error("webmcp-computer: focus must be a boolean");
        }
        const placement: Partial<WindowRect> = {};
        if (rawX !== undefined) placement.x = requireFinite(rawX, "x");
        if (rawY !== undefined) placement.y = requireFinite(rawY, "y");
        if (rawWidth !== undefined) placement.width = requireFinite(rawWidth, "width");
        if (rawHeight !== undefined) placement.height = requireFinite(rawHeight, "height");

        let path: string;
        if (rawHtml !== undefined) {
          if (typeof rawHtml !== "string") {
            throw new Error(`webmcp-computer: html for '${name}' must be a string`);
          }
          const bytes = new TextEncoder().encode(rawHtml).byteLength;
          if (bytes > MAX_UI_HTML_BYTES) {
            throw new Error(
              `webmcp-computer: html too large for '${name}': ${bytes} bytes exceeds ${MAX_UI_HTML_BYTES}`,
            );
          }
          await ensureAppsDirectory(mutationAdmission);
          path = joinPath("~/apps", `${name}.html`);
          await writeFile(path, rawHtml, mutationAdmission);
        } else {
          if (typeof rawPath !== "string") {
            throw new Error(`webmcp-computer: path for '${name}' must be a string`);
          }
          path = normalizePath(rawPath);
          if (!path.toLowerCase().endsWith(".html")) {
            throw new Error(`webmcp-computer: UI app path must end in .html: ${path}`);
          }
          const target = await stat(path);
          if (target.kind !== "file") throw new Error(`webmcp-computer: is a directory: ${path}`);
        }

        assertMachineMutationAdmission(mutationAdmission);
        const process = useKernelStore.getState().spawn("ui", {
          path,
          ...(Object.keys(placement).length === 0 ? {} : { placement }),
          ...(rawFocus === undefined ? {} : { focus: rawFocus }),
          viewport: currentViewport(),
        });
        const grantedTools = grantedToolNames(allowTools);
        setUiToolGrant(process.pid, grantedTools);
        return {
          pid: process.pid,
          path,
          rect: { ...process.windowRect },
          grantedTools,
        };
      },
    );
  },
});

export const uiTools = [uiOpenTool] as const;
