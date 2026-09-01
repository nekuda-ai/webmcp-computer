import {
  defineTool,
  registerTools,
  resolveModelContext,
  type AnyWebMCPTool,
  type ModelContextLike,
  type RegisterToolsOptions,
  type ToolRegistration,
} from "@nekuda/webmcp-sdk";
import {
  SITE_TOOL_PREFIX,
  type SiteToolDescriptor,
} from "../apps/preview/siteToolBridge";
import {
  editorOpenFileTool,
  fileTools,
  filesRevealTool,
  notesAppendTool,
  notesPreviewTool,
  notesStickTool,
} from "./fileTools";
import { useKernelStore } from "../kernel/store";
import type { AppId } from "../kernel/types";
import { systemTools } from "./systemTools";
import { terminalTools } from "./terminalTools";
import { uiTools } from "./uiTools";
import { removeToolCatalogScope, setToolCatalogScope } from "./toolCatalog";
import { runAgentAction } from "./agentAction";
import { ACT_ANNOTATIONS } from "./taxonomy";
import { browserOpenTool } from "./browserTools";
import { osPublishTool } from "./osPublish";
import { cloudExecTool } from "./cloudExec";

export const bootTools = [
  ...systemTools,
  browserOpenTool,
  osPublishTool,
  cloudExecTool,
  ...uiTools,
  ...fileTools,
  ...terminalTools,
] as const;
export const editorTools = [editorOpenFileTool] as const;
export const filesTools = [filesRevealTool] as const;
export const notesTools = [notesAppendTool, notesPreviewTool, notesStickTool] as const;

type AppToolParticipant = {
  controller: AbortController;
  references: number;
};

type AppToolBatch = {
  registration: ToolRegistration;
  participants: Map<number, AppToolParticipant>;
  unsubscribe: () => void;
  tools: readonly AnyWebMCPTool[];
  settled: boolean;
  registeredNames?: string[];
  landedAt?: number;
};

const appToolBatches = new Map<string, AppToolBatch>();

type InFlightToolInvocation = {
  name: string;
  scope?: string;
};

const inFlightToolInvocations = new Map<symbol, InFlightToolInvocation>();
const toolInvocationQuiescenceWaiters = new Set<() => void>();

export function getInFlightToolInvocationCount(): number {
  return inFlightToolInvocations.size;
}

export function hasInFlightSiteToolInvocation(scope: string): boolean {
  return [...inFlightToolInvocations.values()].some(
    (invocation) => invocation.scope === scope && invocation.name.startsWith(SITE_TOOL_PREFIX),
  );
}

export function siteToolInvocationScope(pid: number): string {
  return `site:${pid}`;
}

export function awaitToolInvocationQuiescence(): Promise<void> {
  if (inFlightToolInvocations.size === 0) return Promise.resolve();
  return new Promise((resolve) => toolInvocationQuiescenceWaiters.add(resolve));
}

function beginToolInvocation(name: string, scope?: string): () => void {
  const invocation = Symbol(name);
  inFlightToolInvocations.set(invocation, {
    name,
    ...(scope === undefined ? {} : { scope }),
  });
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    inFlightToolInvocations.delete(invocation);
    if (inFlightToolInvocations.size !== 0) return;
    for (const resolve of toolInvocationQuiescenceWaiters) resolve();
    toolInvocationQuiescenceWaiters.clear();
  };
}

export async function executeUiToolInvocation<T>(
  pid: number,
  name: string,
  execute: () => T | Promise<T>,
): Promise<T> {
  const settle = beginToolInvocation(name, `ui:${pid}`);
  try {
    return await execute();
  } finally {
    settle();
  }
}

export const MAX_SITE_TOOLS = 16;
export const SITE_TOOL_TIMEOUT_MS = 10_000;
export const MAX_SITE_TOOL_DESCRIPTION_BYTES = 4 * 1_024;
export const MAX_SITE_TOOL_INPUT_SCHEMA_BYTES = 16 * 1_024;
export const MAX_SITE_TOOL_RESULT_BYTES = 256 * 1_024;

function withToolErrorTransport(
  options: RegisterToolsOptions,
  invocationScope?: string,
): RegisterToolsOptions {
  const modelContext = options.modelContext ?? resolveModelContext();
  if (!modelContext) return options;
  const bridge: ModelContextLike = {
    async registerTool(tool, registrationOptions) {
      await modelContext.registerTool({
        ...tool,
        async execute(input) {
          const settle = beginToolInvocation(tool.name, invocationScope);
          try {
            try {
              return await tool.execute(input);
            } catch (error) {
              return {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
              };
            }
          } finally {
            settle();
          }
        },
      }, registrationOptions);
    },
  };
  return { ...options, modelContext: bridge };
}

function batchKey(tools: readonly AnyWebMCPTool[]): string {
  return tools.map(({ stableKey }) => stableKey).sort().join("\n");
}

function disposeAppToolBatch(key: string, batch: AppToolBatch): void {
  if (appToolBatches.get(key) !== batch) return;
  batch.unsubscribe();
  batch.registration.unregister();
  removeToolCatalogScope(`batch:${key}`);
  appToolBatches.delete(key);
}

function setAppToolRegistryGroup(key: string, pid: number, batch: AppToolBatch): void {
  if (!batch.participants.has(pid)) return;
  const state = useKernelStore.getState();
  const process = state.processes.find(({ pid: livePid }) => livePid === pid);
  if (!process || !batch.registeredNames || batch.landedAt === undefined) return;
  const id = `app:${pid}:${key}`;
  const existing = state.toolRegistryGroups.find((group) => group.id === id);
  if (batch.registeredNames.length === 0 && (existing?.tools.length ?? 0) > 0) {
    if (import.meta.env.DEV) {
      console.warn(`VerbOS PID ${pid} ignored an empty duplicate WebMCP registration result`);
    }
    return;
  }
  state.setToolRegistryGroup({
    id,
    owner: process.appId,
    pid,
    tools: batch.registeredNames,
    registeredAt: batch.landedAt,
  });
}

function releaseParticipant(key: string, pid: number, force = false): void {
  const batch = appToolBatches.get(key);
  const participant = batch?.participants.get(pid);
  if (!batch || !participant) return;
  participant.references = force ? 0 : participant.references - 1;
  if (participant.references > 0) return;
  participant.controller.abort();
  batch.participants.delete(pid);
  useKernelStore.getState().removeToolRegistryGroup(`app:${pid}:${key}`);
  if (batch.participants.size > 0) return;
  if (!batch.settled) return;
  disposeAppToolBatch(key, batch);
}

export function registerSystemTools(options?: RegisterToolsOptions): ToolRegistration {
  const registration = registerTools(bootTools, withToolErrorTransport(options ?? {}));
  let released = false;
  void registration.ready.then((results) => {
    if (released) return;
    const registeredNames = results
      .filter(({ state }) => state === "registered")
      .map(({ name }) => name);
    setToolCatalogScope(
      "system",
      bootTools.filter(({ name }) => registeredNames.includes(name)),
    );
    useKernelStore.getState().setToolRegistryGroup({
      id: "system",
      owner: "system",
      tools: registeredNames,
      registeredAt: Date.now(),
    });
  });
  return {
    ready: registration.ready,
    signal: registration.signal,
    unregister() {
      if (released) return;
      released = true;
      registration.unregister();
      removeToolCatalogScope("system");
      useKernelStore.getState().removeToolRegistryGroup("system");
    },
  };
}

export function registerAppTools(
  pid: number,
  tools: readonly AnyWebMCPTool[],
  options: RegisterToolsOptions = {},
): ToolRegistration {
  if (!Number.isInteger(pid) || pid < 2) {
    throw new Error("verbos: app tool registration requires an integer PID starting at 2");
  }
  if (!useKernelStore.getState().processes.some((process) => process.pid === pid)) {
    throw new Error(`verbos: cannot register tools for missing process PID ${pid}`);
  }

  const key = batchKey(tools);
  let batch = appToolBatches.get(key);
  if (!batch) {
    const { signal: _externalSignal, ...registrationOptions } = options;
    const registration = registerTools(tools, withToolErrorTransport(registrationOptions));
    batch = {
      registration,
      participants: new Map(),
      unsubscribe: () => {},
      tools,
      settled: false,
    };
    appToolBatches.set(key, batch);
    const readyBatch = batch;
    void registration.ready.then((results) => {
      const current = appToolBatches.get(key);
      if (!current || current !== readyBatch) return;
      current.settled = true;
      current.registeredNames = results
        .filter(({ state }) => state === "registered")
        .map(({ name }) => name);
      current.landedAt = Date.now();
      setToolCatalogScope(
        `batch:${key}`,
        current.tools.filter(({ name }) => current.registeredNames?.includes(name)),
      );
      for (const registeredPid of current.participants.keys()) {
        setAppToolRegistryGroup(key, registeredPid, current);
      }
      if (current.participants.size === 0) disposeAppToolBatch(key, current);
    });
    batch.unsubscribe = useKernelStore.subscribe((state) => {
      const livePids = new Set(state.processes.map(({ pid: livePid }) => livePid));
      for (const registeredPid of batch?.participants.keys() ?? []) {
        if (!livePids.has(registeredPid)) releaseParticipant(key, registeredPid, true);
      }
    });
  }

  let participant = batch.participants.get(pid);
  if (participant) {
    participant.references += 1;
  } else {
    participant = { controller: new AbortController(), references: 1 };
    batch.participants.set(pid, participant);
    const process = useKernelStore.getState().processes.find((entry) => entry.pid === pid);
    if (!process) throw new Error(`verbos: cannot register tools for missing process PID ${pid}`);
    setAppToolRegistryGroup(key, pid, batch);
  }

  let released = false;
  const unregister = () => {
    if (released) return;
    released = true;
    options.signal?.removeEventListener("abort", unregister);
    releaseParticipant(key, pid);
  };
  if (options.signal?.aborted) unregister();
  else options.signal?.addEventListener("abort", unregister, { once: true });

  return {
    ready: batch.registration.ready,
    signal: participant.controller.signal,
    unregister,
  };
}

type SiteToolEntry = {
  registered: boolean;
  registration: ToolRegistration;
  tool: AnyWebMCPTool;
};

export type SiteToolRegistryScope = {
  register(
    descriptor: SiteToolDescriptor,
    execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  ): Promise<void>;
  unregister(name: string): void;
  clear(): void;
  dispose(): void;
};

type SiteToolRegistryOptions = RegisterToolsOptions & {
  appId?: AppId;
  /** Unit-test seam; production always uses SITE_TOOL_TIMEOUT_MS. */
  executionTimeoutMs?: number;
};

function siteToolResultBytes(result: unknown): number {
  const serialized = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return new TextEncoder().encode(serialized).byteLength;
}

function siteToolInputSchemaBytes(inputSchema: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(inputSchema)).byteLength;
}

export function createSiteToolRegistryScope(
  pid: number,
  owner: string,
  options: SiteToolRegistryOptions = {},
): SiteToolRegistryScope {
  if (!Number.isInteger(pid) || pid < 2) {
    throw new Error("verbos: site tool registration requires an integer PID starting at 2");
  }
  if (!useKernelStore.getState().processes.some((process) => process.pid === pid)) {
    throw new Error(`verbos: cannot register site tools for missing process PID ${pid}`);
  }

  const {
    appId = "preview",
    executionTimeoutMs = SITE_TOOL_TIMEOUT_MS,
    ...registrationOptions
  } = options;
  const entries = new Map<string, SiteToolEntry>();
  const activeCalls = new Map<AbortController, string>();
  const catalogScope = siteToolInvocationScope(pid);
  const groupId = catalogScope;
  let nextStableKey = 1;
  let disposed = false;
  let unsubscribe = () => {};

  const syncRegistryState = () => {
    const tools = [...entries.values()]
      .filter(({ registered }) => registered)
      .map(({ tool }) => tool);
    if (tools.length === 0) {
      removeToolCatalogScope(catalogScope);
      useKernelStore.getState().removeToolRegistryGroup(groupId);
      return;
    }
    setToolCatalogScope(catalogScope, tools);
    useKernelStore.getState().setToolRegistryGroup({
      id: groupId,
      owner,
      pid,
      tools: tools.map(({ name }) => name),
      registeredAt: Date.now(),
    });
  };

  const unregister = (name: string) => {
    const entry = entries.get(name);
    if (!entry) return;
    entries.delete(name);
    entry.registration.unregister();
    for (const [controller, callName] of activeCalls) {
      if (callName !== name) continue;
      controller.abort(new Error(`verbos: site tool unavailable: ${name}`));
      activeCalls.delete(controller);
    }
    syncRegistryState();
  };

  const clear = () => {
    for (const name of [...entries.keys()]) unregister(name);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
    unsubscribe();
  };

  unsubscribe = useKernelStore.subscribe((state) => {
    if (!state.processes.some((process) => process.pid === pid)) dispose();
  });

  return {
    async register(descriptor, execute) {
      if (disposed) throw new Error("verbos: site tool scope is closed");
      if (!descriptor.name.startsWith(SITE_TOOL_PREFIX)) {
        throw new Error(`verbos: site tool name must start with ${SITE_TOOL_PREFIX}`);
      }
      if (descriptor.name.length === SITE_TOOL_PREFIX.length) {
        throw new Error(
          `verbos: site tool name must include at least one character after ${SITE_TOOL_PREFIX}`,
        );
      }
      if (entries.has(descriptor.name)) {
        throw new Error(`verbos: site tool already registered: ${descriptor.name}`);
      }
      if (entries.size >= MAX_SITE_TOOLS) {
        throw new Error("verbos: site tool limit reached");
      }

      const name = descriptor.name;
      const descriptionBytes = new TextEncoder().encode(descriptor.description).byteLength;
      if (descriptionBytes > MAX_SITE_TOOL_DESCRIPTION_BYTES) {
        throw new Error(`verbos: site tool description too large: ${name}`);
      }
      if (
        descriptor.inputSchema !== undefined &&
        siteToolInputSchemaBytes(descriptor.inputSchema) > MAX_SITE_TOOL_INPUT_SCHEMA_BYTES
      ) {
        throw new Error(`verbos: site tool inputSchema too large: ${name}`);
      }
      const tool = defineTool({
        stableKey: `verbos.site_${pid}_${nextStableKey++}`,
        name,
        ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
        description: descriptor.description,
        ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
        annotations: { ...ACT_ANNOTATIONS, untrustedContentHint: true },
        intent: "act",
        async execute(input) {
          return await runAgentAction(name, { appId, pid }, async () => {
            const controller = new AbortController();
            activeCalls.set(controller, name);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                const error = new Error(`verbos: site tool timed out: ${name}`);
                controller.abort(error);
                reject(error);
              }, executionTimeoutMs);
            });
            try {
              const result = await Promise.race([
                execute(input, controller.signal),
                timedOut,
              ]);
              if (siteToolResultBytes(result) > MAX_SITE_TOOL_RESULT_BYTES) {
                throw new Error(`verbos: site tool result too large: ${name}`);
              }
              return result;
            } finally {
              if (timeout !== undefined) clearTimeout(timeout);
              activeCalls.delete(controller);
            }
          });
        },
      });
      const registration = registerTools(
        [tool],
        withToolErrorTransport(registrationOptions, catalogScope),
      );
      const entry: SiteToolEntry = { registered: false, registration, tool };
      entries.set(name, entry);
      const result = (await registration.ready)[0];
      if (entries.get(name) !== entry) {
        registration.unregister();
        throw new Error(`verbos: site tool registration aborted: ${name}`);
      }
      if (result?.state !== "registered") {
        entries.delete(name);
        registration.unregister();
        const detail = result?.error instanceof Error ? `: ${result.error.message}` : "";
        throw new Error(`verbos: site tool registration failed: ${name}${detail}`);
      }
      entry.registered = true;
      syncRegistryState();
    },

    unregister,
    clear,
    dispose,
  };
}
