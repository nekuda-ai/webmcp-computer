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
  collectPreviewFiles,
  createBlobVirtualSite,
  type BlobVirtualSite,
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
  __verbosPreview?: boolean;
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

export function PreviewApp({ process }: AppComponentProps) {
  const root = process.path ?? "~/site";
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const token = useRef(crypto.randomUUID());
  const active = useRef(true);
  const syncSiteRef = useRef<() => Promise<void>>(async () => {});
  const reloadScheduler = useRef<PreviewReloadScheduler>();
  const frameCommitGate = useRef<PreviewFrameCommitGate>();
  const virtualSite = useRef<BlobVirtualSite>();
  const siteToolScope = useRef<SiteToolRegistryScope>();
  const siteToolProxy = useRef<SiteToolProxy>();
  const [frameSrc, setFrameSrc] = useState<string>();
  const [status, setStatus] = useState("Starting virtual server…");
  const [consoleLines, setConsoleLines] = useState<readonly PreviewConsoleLine[]>([]);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);

  const syncSite = useCallback(async () => {
    const target = await stat(root);
    if (target.kind !== "directory") throw new Error(`verbos: not a directory: ${root}`);
    const files = await collectPreviewFiles(root);
    const nextToken = crypto.randomUUID();
    const nextSite = createBlobVirtualSite(files, process.pid, nextToken);
    if (!active.current) {
      nextSite.revoke();
      return;
    }
    frameCommitGate.current?.request(() => {
      if (!active.current) {
        nextSite.revoke();
        return;
      }
      siteToolScope.current?.clear();
      siteToolProxy.current?.reset(new Error("verbos: site tool bridge reloaded"));
      token.current = nextToken;
      virtualSite.current?.revoke();
      virtualSite.current = nextSite;
      setFrameSrc(nextSite.entryUrl);
      setStatus(`Serving ${files.length} file${files.length === 1 ? "" : "s"}`);
    }, nextSite.revoke);
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
      virtualSite.current?.revoke();
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
        __verbosPreview: true,
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
        message?.__verbosPreview !== true ||
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
          __verbosPreview: true,
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
        {frameSrc === undefined ? (
          <div className="preview-loading mono">{status}</div>
        ) : (
          <iframe
            ref={iframeRef}
            key={frameSrc}
            title={`Preview ${previewUrl(root)}`}
            src={frameSrc}
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
      <footer className={`app-status mono${status.startsWith("verbos:") ? " is-error" : ""}`}>
        <span>{status}</span>
        <span>{consoleLines.length} CONSOLE</span>
      </footer>
    </section>
  );
}
