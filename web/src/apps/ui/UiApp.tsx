import { useCallback, useEffect, useRef, useState } from "react";
import { readFile, watch } from "../../kernel/fs";
import { useKernelStore } from "../../kernel/store";
import {
  createSiteToolRegistryScope,
  siteToolInvocationScope,
  type SiteToolRegistryScope,
} from "../../tools/registry";
import type { AppComponentProps } from "../registry";
import {
  dropPreviewConsoleLines,
  mountPreviewRuntime,
  recordPreviewConsole,
  recordPreviewWarnings,
  updatePreviewRuntime,
  type PreviewConsoleLevel,
  type PreviewConsoleLine,
} from "../preview/runtime";
import {
  buildSelfContainedDocument,
  type PreviewVirtualFile,
} from "../preview/virtualServer";
import {
  createPreviewFrameCommitGate,
  createPreviewReloadScheduler,
  type PreviewFrameCommitGate,
  type PreviewReloadScheduler,
} from "../preview/previewScheduling";
import {
  createSiteToolProxy,
  isSiteToolDescriptor,
  type SiteToolProxy,
  type SiteToolResultMessage,
} from "../preview/siteToolBridge";
import {
  createUiToolHostProxy,
  injectUiBridge,
  UI_TOOL_TIMEOUT_MS,
  type UiToolHostProxy,
} from "./uiBridge";
import { errorMessage } from "../../shared";

const MAX_CONSOLE_MESSAGES_PER_FRAME = 200;

function contentTypeFile(content: string): PreviewVirtualFile {
  return {
    path: "index.html",
    contentType: "text/html; charset=utf-8",
    body: new TextEncoder().encode(content),
  };
}

type UiConsoleMessage = {
  __verbosUi?: boolean;
  pid?: number;
  token?: string;
  level?: PreviewConsoleLevel;
  message?: string;
  kind?: string;
  requestId?: string;
  tool?: unknown;
  name?: string;
  callId?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

export function UiApp({ process }: AppComponentProps) {
  const path = process.path;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const token = useRef(crypto.randomUUID());
  const active = useRef(true);
  const syncDocumentRef = useRef<() => Promise<void>>(async () => {});
  const reloadScheduler = useRef<PreviewReloadScheduler>();
  const frameCommitGate = useRef<PreviewFrameCommitGate>();
  const hostProxy = useRef<UiToolHostProxy>();
  const siteToolScope = useRef<SiteToolRegistryScope>();
  const siteToolProxy = useRef<SiteToolProxy>();
  const [frameDocument, setFrameDocument] = useState<{ key: string; html: string }>();
  const [status, setStatus] = useState("Loading app…");
  const [consoleLines, setConsoleLines] = useState<readonly PreviewConsoleLine[]>([]);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);

  const syncDocument = useCallback(async () => {
    if (path === undefined) throw new Error("verbos: UI app has no HTML path");
    const content = await readFile(path);
    const nextToken = crypto.randomUUID();
    const document = buildSelfContainedDocument(
      [contentTypeFile(content)],
      process.pid,
      nextToken,
      "index.html",
      { injectBridge: false },
    );
    const nextHtml = injectUiBridge(document.html, process.pid, nextToken);
    if (!active.current) return;
    frameCommitGate.current?.request(() => {
      if (!active.current) return;
      siteToolScope.current?.clear();
      siteToolProxy.current?.reset(new Error("verbos: app tool bridge reloaded"));
      hostProxy.current?.dispose(new Error("verbos: UI tool bridge reloaded"));
      hostProxy.current = undefined;
      token.current = nextToken;
      setFrameDocument({ key: nextToken, html: nextHtml });
      recordPreviewWarnings(process.pid, document.warnings);
      setStatus(`Running ${path.split("/").at(-1) ?? path}`);
    });
  }, [path, process.pid]);
  syncDocumentRef.current = syncDocument;

  const captureIframe = useCallback((iframe: HTMLIFrameElement | null) => {
    iframeRef.current = iframe;
    const frameWindow = iframe?.contentWindow;
    if (frameWindow === null || frameWindow === undefined) return;
    const frameToken = token.current;
    hostProxy.current = createUiToolHostProxy({
      pid: process.pid,
      token: frameToken,
      send(message) {
        frameWindow.postMessage(message, "*");
      },
    });
  }, [process.pid]);

  const queueReload = useCallback((delayMs = 0) => {
    const queued = reloadScheduler.current?.request(delayMs) ?? Promise.resolve();
    queued.catch((error: unknown) => {
      if (active.current) setStatus(errorMessage(error));
    });
    return queued;
  }, []);

  useEffect(() => {
    active.current = true;
    reloadScheduler.current = createPreviewReloadScheduler(() => syncDocumentRef.current());
    frameCommitGate.current = createPreviewFrameCommitGate({
      maxWaitMs: UI_TOOL_TIMEOUT_MS,
      siteToolScope: siteToolInvocationScope(process.pid),
    });
    return () => {
      active.current = false;
      reloadScheduler.current?.dispose();
      frameCommitGate.current?.dispose();
      hostProxy.current?.dispose(new Error("verbos: UI tool bridge closed"));
      reloadScheduler.current = undefined;
      frameCommitGate.current = undefined;
      hostProxy.current = undefined;
    };
  }, [process.pid]);

  useEffect(() => {
    const scope = createSiteToolRegistryScope(
      process.pid,
      `app:${path ?? process.pid}`,
      { appId: "ui" },
    );
    const proxy = createSiteToolProxy((message) => {
      iframeRef.current?.contentWindow?.postMessage({
        __verbosUi: true,
        pid: process.pid,
        token: token.current,
        ...message,
      }, "*");
    });
    siteToolScope.current = scope;
    siteToolProxy.current = proxy;
    return () => {
      if (siteToolScope.current === scope) siteToolScope.current = undefined;
      if (siteToolProxy.current === proxy) siteToolProxy.current = undefined;
      proxy.reset();
      scope.dispose();
    };
  }, [path, process.pid]);

  useEffect(
    () => mountPreviewRuntime(process.pid, path ?? "~/apps", queueReload, setConsoleLines),
    [process.pid],
  );

  useEffect(() => {
    updatePreviewRuntime(process.pid, path ?? "~/apps", queueReload, setConsoleLines);
  }, [path, process.pid, queueReload]);

  useEffect(() => {
    if (fileSystemStatus === "ready") void queueReload();
  }, [fileSystemStatus, queueReload]);

  useEffect(() => watch((change) => {
    if (path !== undefined && (change.path === path || change.from === path)) {
      void queueReload(200);
    }
  }), [path, queueReload]);

  useEffect(() => {
    let messagesThisFrame = 0;
    let resetFrame: number | undefined;
    const receiveMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data as UiConsoleMessage | undefined;
      if (
        message?.__verbosUi !== true ||
        message.pid !== process.pid ||
        message.token !== token.current
      ) {
        return;
      }

      if (message.kind === "site-tool-result") {
        if (typeof message.callId === "string" && typeof message.ok === "boolean") {
          siteToolProxy.current?.receive(message as SiteToolResultMessage);
        }
        return;
      }

      if (message.kind === "site-tool-unregister") {
        if (typeof message.name === "string") siteToolScope.current?.unregister(message.name);
        return;
      }

      if (message.kind === "site-tool-register" && typeof message.requestId === "string") {
        const source = event.source as Window;
        const reply = (ok: boolean, error?: string) => source.postMessage({
          __verbosUi: true,
          pid: process.pid,
          token: message.token,
          kind: "site-tool-registration",
          requestId: message.requestId,
          ok,
          ...(error === undefined ? {} : { error }),
        }, "*");
        if (!isSiteToolDescriptor(message.tool)) {
          reply(false, "verbos: invalid site tool registration");
          return;
        }
        const descriptor = message.tool;
        const scope = siteToolScope.current;
        const proxy = siteToolProxy.current;
        if (!scope || !proxy) {
          reply(false, "verbos: site tool scope is not ready");
          return;
        }
        void scope.register(
          descriptor,
          (input, signal) => proxy.execute(descriptor.name, input, signal),
        ).then(
          () => reply(true),
          (error: unknown) => reply(false, errorMessage(error)),
        );
        return;
      }

      hostProxy.current?.receive(message);
      if (
        !["log", "info", "warn", "error"].includes(message.level ?? "") ||
        typeof message.message !== "string"
      ) {
        return;
      }
      if (resetFrame === undefined) {
        resetFrame = requestAnimationFrame(() => {
          messagesThisFrame = 0;
          resetFrame = undefined;
        });
      }
      if (messagesThisFrame >= MAX_CONSOLE_MESSAGES_PER_FRAME) {
        dropPreviewConsoleLines(process.pid);
        return;
      }
      messagesThisFrame += 1;
      recordPreviewConsole(
        process.pid,
        message.level as PreviewConsoleLevel,
        message.message,
      );
    };
    window.addEventListener("message", receiveMessage);
    return () => {
      window.removeEventListener("message", receiveMessage);
      if (resetFrame !== undefined) cancelAnimationFrame(resetFrame);
    };
  }, [process.pid]);

  const latestLines = consoleLines.slice(-4);

  return (
    <section className="preview-app" data-ui-pid={process.pid}>
      <header className="app-toolbar preview-toolbar">
        <span className="preview-address mono">{path ?? "No HTML file"}</span>
      </header>
      <div className="preview-viewport">
        {frameDocument === undefined ? (
          <div className="preview-loading mono">{status}</div>
        ) : (
          <iframe
            ref={captureIframe}
            key={frameDocument.key}
            title={`App ${path ?? process.pid}`}
            srcDoc={frameDocument.html}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
      <div className="preview-console" aria-label="App console">
        {latestLines.length === 0 ? (
          <span className="mono preview-console__empty">CONSOLE QUIET</span>
        ) : latestLines.map((line, index) => (
          <span
            className={`mono preview-console__line is-${line.level}`}
            key={`${line.ts}-${index}-${line.message}`}
          >
            {line.level.toUpperCase()} {line.message}
          </span>
        ))}
      </div>
      <footer className={`app-status mono${status.startsWith("verbos:") ? " is-error" : ""}`}>
        <span>{status}</span>
        <span>{consoleLines.length} CONSOLE</span>
      </footer>
    </section>
  );
}
