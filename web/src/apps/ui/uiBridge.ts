import type { AnyWebMCPTool } from "@nekuda/webmcp-sdk";
import { useKernelStore } from "../../kernel/store";
import type { OSEvent } from "../../kernel/types";
import { executeUiToolInvocation } from "../../tools/registry";
import { getActiveToolDefinition } from "../../tools/toolCatalog";
import { isUiToolAllowedDefinition } from "../../tools/uiTools";
import { errorMessage } from "../../shared";
import { installFrameConsoleCapture } from "../frame/frameConsole";
import { createSiteModelContextFacade } from "../preview/siteToolBridge";
import { getUiToolGrant } from "./runtime";

export const UI_TOOL_TIMEOUT_MS = 10_000;
export const MAX_UI_TOOL_INPUT_BYTES = 256 * 1_024;
export const MAX_UI_TOOL_RESULT_BYTES = 256 * 1_024;
export const MAX_UI_TOOL_IN_FLIGHT = 2;
export const UI_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'";

export type UiToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type UiInitMessage = { kind: "ui-init" };
export type UiInitResultMessage = { kind: "ui-init-result"; tools: UiToolDescriptor[] };
export type UiCallMessage = {
  kind: "ui-call";
  callId: string;
  name: string;
  input: Record<string, unknown>;
};
export type UiResultMessage = {
  kind: "ui-result";
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type UiFrameMessage = UiInitMessage | UiCallMessage;
export type UiHostMessage = UiInitResultMessage | UiResultMessage;
export type UiEnvelope<T extends UiFrameMessage | UiHostMessage = UiFrameMessage | UiHostMessage> = {
  __verbosUi: true;
  pid: number;
  token: string;
} & T;

export type UiBridgeClient = Readonly<{
  listTools(): Promise<UiToolDescriptor[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}>;

type PendingUiCall = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * Kept dependency-free because its source is injected into opaque UI frames.
 * Transport callbacks wrap postMessage so tests can use an in-memory pair.
 */
export function createUiBridgeClient(
  pid: number,
  token: string,
  send: (message: UiEnvelope<UiFrameMessage>) => void,
  receive: (listener: (message: unknown) => void) => void,
  responseTimeoutMs = 10_000,
): UiBridgeClient {
  let tools: UiToolDescriptor[] = [];
  let resolveInit: (() => void) | undefined;
  const initialized = new Promise<void>((resolve) => {
    resolveInit = resolve;
  });
  const pending = new Map<string, PendingUiCall>();
  let nextCallId = 1;

  const post = (message: UiFrameMessage) => send({
    __verbosUi: true,
    pid,
    token,
    ...message,
  });

  receive((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (
      message.__verbosUi !== true ||
      message.pid !== pid ||
      message.token !== token
    ) {
      return;
    }
    if (message.kind === "ui-init-result" && Array.isArray(message.tools)) {
      tools = message.tools as UiToolDescriptor[];
      resolveInit?.();
      resolveInit = undefined;
      return;
    }
    if (
      message.kind !== "ui-result" ||
      typeof message.callId !== "string" ||
      typeof message.ok !== "boolean"
    ) {
      return;
    }
    const call = pending.get(message.callId);
    if (!call) return;
    pending.delete(message.callId);
    clearTimeout(call.timeout);
    if (message.ok) call.resolve(message.result);
    else call.reject(new Error(
      typeof message.error === "string" ? message.error : "verbos: UI tool call failed",
    ));
  });

  post({ kind: "ui-init" });

  return Object.freeze({
    async listTools() {
      await initialized;
      return tools.map((tool) => ({ ...tool }));
    },
    callTool(name, input) {
      const callId = `ui-call-${nextCallId++}`;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(callId);
          reject(new Error(`verbos: UI tool call was not answered: ${name}`));
        }, responseTimeoutMs);
        pending.set(callId, { resolve, reject, timeout });
        try {
          post({ kind: "ui-call", callId, name, input });
        } catch (error) {
          pending.delete(callId);
          clearTimeout(timeout);
          reject(error);
        }
      });
    },
  });
}

function uiToolDescriptor(tool: AnyWebMCPTool): UiToolDescriptor {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedBytes(value: unknown, name: string, kind: "input" | "result"): number {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    throw new Error(`verbos: UI tool ${kind} is not serializable: ${name}`);
  }
}

type UiToolHostProxyOptions = {
  pid: number;
  token: string;
  send: (message: UiEnvelope<UiHostMessage>) => void;
  executionTimeoutMs?: number;
};

export type UiToolHostProxy = {
  receive(message: unknown): void;
  dispose(reason?: unknown): void;
};

export function createUiToolHostProxy({
  pid,
  token,
  send,
  executionTimeoutMs = UI_TOOL_TIMEOUT_MS,
}: UiToolHostProxyOptions): UiToolHostProxy {
  const inFlight = new Set<string>();
  const callEvents = new Map<string, OSEvent>();
  let disposed = false;
  let unsubscribeProcess: (() => void) | undefined;
  const post = (message: UiHostMessage) => send({
    __verbosUi: true,
    pid,
    token,
    ...message,
  });
  const grantedDefinition = (name: string) => {
    if (!getUiToolGrant(pid).includes(name)) return undefined;
    const tool = getActiveToolDefinition(name);
    return tool !== undefined && isUiToolAllowedDefinition(tool) ? tool : undefined;
  };
  const descriptors = () => getUiToolGrant(pid)
    .map((name) => grantedDefinition(name))
    .filter((tool): tool is AnyWebMCPTool => tool !== undefined)
    .map(uiToolDescriptor);

  const rejectCall = (callId: string, name: string, message: string) => {
    const event = useKernelStore.getState().osEvent("app", "ui_call", { pid, tool: name });
    useKernelStore.getState().settleEvent(event, false, message);
    post({ kind: "ui-result", callId, ok: false, error: message });
  };

  const executeCall = async (message: UiCallMessage, event: OSEvent) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const tool = grantedDefinition(message.name);
      if (!tool) throw new Error(`verbos: UI tool not granted: ${message.name}`);
      const result = await executeUiToolInvocation(pid, message.name, async () => {
        const timedOut = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`verbos: UI tool timed out: ${message.name}`)),
            executionTimeoutMs,
          );
        });
        const executed = await Promise.race([
          Promise.resolve().then(() => tool.execute(message.input)),
          timedOut,
        ]);
        if (serializedBytes(executed, message.name, "result") > MAX_UI_TOOL_RESULT_BYTES) {
          throw new Error(`verbos: UI tool result too large: ${message.name}`);
        }
        return executed;
      });
      if (!inFlight.has(message.callId)) return;
      if (!grantedDefinition(message.name)) {
        throw new Error(`verbos: UI tool not granted: ${message.name}`);
      }
      useKernelStore.getState().settleEvent(event, true);
      post({ kind: "ui-result", callId: message.callId, ok: true, result });
    } catch (error) {
      if (!inFlight.has(message.callId)) return;
      const reason = errorMessage(error);
      useKernelStore.getState().settleEvent(event, false, reason);
      post({ kind: "ui-result", callId: message.callId, ok: false, error: reason });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      inFlight.delete(message.callId);
      callEvents.delete(message.callId);
    }
  };

  const dispose = (reason: unknown = new Error("verbos: UI tool bridge closed")) => {
    if (disposed) return;
    disposed = true;
    unsubscribeProcess?.();
    unsubscribeProcess = undefined;
    const message = errorMessage(reason);
    for (const callId of inFlight) {
      const event = callEvents.get(callId);
      if (event !== undefined) useKernelStore.getState().settleEvent(event, false, message);
      post({ kind: "ui-result", callId, ok: false, error: message });
    }
    inFlight.clear();
    callEvents.clear();
  };

  unsubscribeProcess = useKernelStore.subscribe((state) => {
    if (!state.processes.some((process) => process.pid === pid)) {
      dispose(new Error("verbos: UI process closed"));
    }
  });

  return {
    receive(value) {
      if (disposed) return;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (
        message.__verbosUi !== true ||
        message.pid !== pid ||
        message.token !== token
      ) {
        return;
      }
      if (message.kind === "ui-init") {
        post({ kind: "ui-init-result", tools: descriptors() });
        return;
      }
      if (
        message.kind !== "ui-call" ||
        typeof message.callId !== "string" ||
        typeof message.name !== "string"
      ) {
        return;
      }
      const call = message as unknown as UiCallMessage;
      if (!isPlainObject(call.input)) {
        rejectCall(
          call.callId,
          call.name,
          `verbos: UI tool input must be a plain object: ${call.name}`,
        );
        return;
      }
      try {
        if (serializedBytes(call.input, call.name, "input") > MAX_UI_TOOL_INPUT_BYTES) {
          rejectCall(call.callId, call.name, `verbos: UI tool input too large: ${call.name}`);
          return;
        }
      } catch (error) {
        rejectCall(call.callId, call.name, errorMessage(error));
        return;
      }
      if (!grantedDefinition(call.name)) {
        rejectCall(call.callId, call.name, `verbos: UI tool not granted: ${call.name}`);
        return;
      }
      if (inFlight.has(call.callId)) {
        rejectCall(call.callId, call.name, `verbos: duplicate UI call id: ${call.callId}`);
        return;
      }
      inFlight.add(call.callId);
      if (inFlight.size > MAX_UI_TOOL_IN_FLIGHT) {
        inFlight.delete(call.callId);
        rejectCall(call.callId, call.name, `verbos: UI tool call limit reached: ${call.name}`);
        return;
      }
      const event = useKernelStore.getState().osEvent("app", "ui_call", {
        pid,
        tool: call.name,
      });
      callEvents.set(call.callId, event);
      void executeCall(call, event);
    },
    dispose,
  };
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function injectUiBridge(html: string, pid: number, token: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${UI_CONTENT_SECURITY_POLICY}">`;
  const script = `<script>(()=>{const marker=${scriptJson(token)};const uiListeners=[];const siteListeners=[];const createClient=(${createUiBridgeClient.toString()});const createFacade=(${createSiteModelContextFacade.toString()});const installConsole=(${installFrameConsoleCapture.toString()});const sendUi=(message)=>parent.postMessage(message,'*');const post=(message)=>parent.postMessage({__verbosUi:true,pid:${pid},token:marker,...message},'*');window.addEventListener('message',(event)=>{const message=event.data;if(event.source!==parent||message?.__verbosUi!==true||message.pid!==${pid}||message.token!==marker)return;if(message.kind==='site-tool-registration'||message.kind==='site-tool-call'){for(const listener of siteListeners)listener(message);return}for(const listener of uiListeners)listener(message)});const verbos=createClient(${pid},marker,sendUi,(listener)=>uiListeners.push(listener));const facade=createFacade(post,(listener)=>siteListeners.push(listener));Object.defineProperty(window,'verbos',{configurable:false,writable:false,value:verbos});Object.defineProperty(document,'modelContext',{configurable:true,value:facade});installConsole((level,message)=>post({level,message}))})();</script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  const injection = `${csp}${script}`;
  if (head.test(html)) return html.replace(head, (match) => `${match}${injection}`);
  const htmlElement = /<html(?:\s[^>]*)?>/i;
  if (htmlElement.test(html)) {
    return html.replace(htmlElement, (match) => `${match}<head>${injection}</head>`);
  }
  const doctype = /^\s*<!doctype[^>]*>/i;
  return doctype.test(html)
    ? html.replace(doctype, (match) => `${match}<head>${injection}</head>`)
    : `<head>${injection}</head>${html}`;
}
