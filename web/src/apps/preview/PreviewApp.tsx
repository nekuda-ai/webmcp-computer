import { useCallback, useEffect, useRef, useState } from "react";
import { stat, watch, type FileSystemChange } from "../../kernel/fs";
import { useKernelStore } from "../../kernel/store";
import { previewTools } from "../../tools/previewTools";
import {
  createSiteToolRegistryScope,
  siteToolInvocationScope,
  type SiteToolRegistryScope,
} from "../../tools/registry";
import { useAppTools } from "../../tools/useAppTools";
import { VerbHint } from "../../desktop/VerbHint";
import type { AppComponentProps } from "../registry";
import {
  dropPreviewConsoleLines,
  mountPreviewRuntime,
  previewUrl,
  recordPreviewConsole,
  updatePreviewRuntime,
  type PreviewConsoleLevel,
  type PreviewConsoleLine,
} from "./runtime";
import {
  createSiteToolProxy,
  isSiteToolDescriptor,
  type SiteToolProxy,
  type SiteToolResultMessage,
} from "./siteToolBridge";
import {
  buildSelfContainedDocument,
  collectPreviewFiles,
} from "./virtualServer";
import {
  createPreviewFrameCommitGate,
  createPreviewReloadScheduler,
  type PreviewFrameCommitGate,
  type PreviewReloadScheduler,
} from "./previewScheduling";
import { errorMessage } from "../../shared";

const MAX_CONSOLE_MESSAGES_PER_FRAME = 200;

function touchesRoot(change: FileSystemChange, root: string): boolean {
  const inside = (path: string) => path === root || path.startsWith(`${root}/`);
  return inside(change.path) || (change.from !== undefined && inside(change.from));
}

type PreviewMessage = {
  __webmcpComputerPreview?: boolean;
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

type PreviewFrameDocument = {
  key: string;
  html: string;
};

export function PreviewApp({ process }: AppComponentProps) {
  const root = process.path ?? "~/site";
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const token = useRef(crypto.randomUUID());
  const active = useRef(true);
  const syncSiteRef = useRef<() => Promise<void>>(async () => {});
  const reloadScheduler = useRef<PreviewReloadScheduler>();
  const frameCommitGate = useRef<PreviewFrameCommitGate>();
  const siteToolScope = useRef<SiteToolRegistryScope>();
  const siteToolProxy = useRef<SiteToolProxy>();
  const [frameDocument, setFrameDocument] = useState<PreviewFrameDocument>();
  const [status, setStatus] = useState("Starting virtual server…");
  const [consoleLines, setConsoleLines] = useState<readonly PreviewConsoleLine[]>([]);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);

  const syncSite = useCallback(async () => {
    const target = await stat(root);
    if (target.kind !== "directory") throw new Error(`webmcp-computer: not a directory: ${root}`);
    const files = await collectPreviewFiles(root);
    const nextToken = crypto.randomUUID();
    const nextDocument = buildSelfContainedDocument(files, process.pid, nextToken);
    if (!active.current) return;
    frameCommitGate.current?.request(() => {
      if (!active.current) return;
      siteToolScope.current?.clear();
      siteToolProxy.current?.reset(new Error("webmcp-computer: site tool bridge reloaded"));
      token.current = nextToken;
      setFrameDocument({ key: nextToken, html: nextDocument.html });
      setStatus(`Serving ${files.length} file${files.length === 1 ? "" : "s"}`);
    });
  }, [process.pid, root]);
  syncSiteRef.current = syncSite;

  const queueReload = useCallback((delayMs = 0) => {
    const queued = reloadScheduler.current?.request(delayMs) ?? Promise.resolve();
    queued.catch((error: unknown) => {
      if (active.current) setStatus(errorMessage(error));
    });
    return queued;
  }, []);

  useEffect(() => {
    active.current = true;
    reloadScheduler.current = createPreviewReloadScheduler(() => syncSiteRef.current());
    frameCommitGate.current = createPreviewFrameCommitGate({
      siteToolScope: siteToolInvocationScope(process.pid),
    });
    return () => {
      active.current = false;
      reloadScheduler.current?.dispose();
      frameCommitGate.current?.dispose();
      reloadScheduler.current = undefined;
      frameCommitGate.current = undefined;
    };
  }, [process.pid]);

  useEffect(
    () => mountPreviewRuntime(process.pid, root, queueReload, setConsoleLines),
    [process.pid],
  );

  useEffect(() => {
    updatePreviewRuntime(process.pid, root, queueReload, setConsoleLines);
  }, [process.pid, queueReload, root]);

  useAppTools(process.pid, previewTools);

  useEffect(() => {
    const scope = createSiteToolRegistryScope(process.pid, previewUrl(root));
    const proxy = createSiteToolProxy((message) => {
      iframeRef.current?.contentWindow?.postMessage({
        __webmcpComputerPreview: true,
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
  }, [process.pid, root]);

  useEffect(() => {
    if (fileSystemStatus === "ready") void queueReload();
  }, [fileSystemStatus, queueReload]);

  useEffect(() => watch((change) => {
    if (touchesRoot(change, root)) void queueReload(200);
  }), [queueReload, root]);

  useEffect(() => {
    let messagesThisFrame = 0;
    let resetFrame: number | undefined;
    const receiveMessage = (event: MessageEvent<PreviewMessage>) => {
      const message = event.data;
      if (
        event.source !== iframeRef.current?.contentWindow ||
        message?.__webmcpComputerPreview !== true ||
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
          __webmcpComputerPreview: true,
          pid: process.pid,
          token: message.token,
          kind: "site-tool-registration",
          requestId: message.requestId,
          ok,
          ...(error === undefined ? {} : { error }),
        }, "*");
        if (!isSiteToolDescriptor(message.tool)) {
          reply(false, "webmcp-computer: invalid site tool registration");
          return;
        }
        const descriptor = message.tool;
        const scope = siteToolScope.current;
        const proxy = siteToolProxy.current;
        if (!scope || !proxy) {
          reply(false, "webmcp-computer: site tool scope is not ready");
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
      recordPreviewConsole(process.pid, message.level as PreviewConsoleLevel, message.message);
    };
    window.addEventListener("message", receiveMessage);
    return () => {
      window.removeEventListener("message", receiveMessage);
      if (resetFrame !== undefined) cancelAnimationFrame(resetFrame);
    };
  }, [process.pid]);

  const latestLines = consoleLines.slice(-4);

  return (
    <section className="preview-app" data-preview-pid={process.pid}>
      <header className="app-toolbar preview-toolbar">
        <span className="preview-address mono">{previewUrl(root)}</span>
        <VerbHint verb="preview_reload" arg={`PID ${process.pid}`}>
          <button className="app-button" type="button" onClick={() => void queueReload()}>
            Reload
          </button>
        </VerbHint>
      </header>
      <div className="preview-viewport">
        {frameDocument === undefined ? (
          <div className="preview-loading mono">{status}</div>
        ) : (
          <iframe
            ref={iframeRef}
            key={frameDocument.key}
            title={`Preview ${previewUrl(root)}`}
            srcDoc={frameDocument.html}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
      <div className="preview-console" aria-label="Preview console">
        {latestLines.length === 0 ? (
          <span className="mono preview-console__empty">CONSOLE QUIET</span>
        ) : latestLines.map((line, index) => (
          <span className={`mono preview-console__line is-${line.level}`} key={`${line.ts}-${index}-${line.message}`}>
            {line.level.toUpperCase()} {line.message}
          </span>
        ))}
      </div>
      <footer className={`app-status mono${status.startsWith("webmcp-computer:") ? " is-error" : ""}`}>
        <span>{status}</span>
        <span>{consoleLines.length} CONSOLE</span>
      </footer>
    </section>
  );
}
