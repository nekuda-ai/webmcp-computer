import { useEffect, useRef, useState } from "react";
import { VerbHint } from "../../desktop/VerbHint";
import { useKernelStore } from "../../kernel/store";
import { browserTools } from "../../tools/browserTools";
import { useAppTools } from "../../tools/useAppTools";
import type { AppComponentProps } from "../registry";
import {
  attachBrowserPageLifecycle,
  browserSessionState,
  closeBrowserSession,
  getBrowserSession,
  restartBrowserSession,
  subscribeBrowserSession,
  viewportForContainer,
  type BrowserSessionState,
} from "./session";

export function BrowserApp({ process }: AppComponentProps) {
  useAppTools(process.pid, browserTools);
  const [state, setState] = useState<BrowserSessionState>(browserSessionState);
  const liveViewContainerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const unsubscribe = subscribeBrowserSession(setState);
    const detachPageLifecycle = attachBrowserPageLifecycle();
    return () => {
      unsubscribe();
      detachPageLifecycle();
      queueMicrotask(() => {
        const stillOpen = useKernelStore
          .getState()
          .processes.some(({ pid }) => pid === process.pid);
        if (!stillOpen) void closeBrowserSession();
      });
    };
  }, [process.pid]);

  useEffect(() => {
    if (state.status !== "live") return;
    const container = liveViewContainerRef.current;
    if (!container) return;
    let session: ReturnType<typeof getBrowserSession>;
    try {
      session = getBrowserSession();
    } catch {
      return;
    }
    let cancelResize: () => void = () => undefined;
    const resize = (width: number, height: number) => {
      const viewport = viewportForContainer(width, height);
      if (!viewport) return;
      cancelResize();
      cancelResize = session.setViewport(viewport.width, viewport.height);
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries.find(({ target }) => target === container);
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(container);
    resize(container.clientWidth, container.clientHeight);
    return () => {
      resizeObserver.disconnect();
      cancelResize();
    };
  }, [state]);

  if (state.status === "connecting") {
    return (
      <section className="browser-app browser-app--status" data-browser-pid={process.pid}>
        <span className="browser-app__microlabel mono" role="status">CONNECTING TO SHARED CHROME…</span>
      </section>
    );
  }

  if (state.status === "ended") {
    return (
      <section className="browser-app browser-app--status" data-browser-pid={process.pid}>
        <div className="browser-app__ended" role="status">
          <span className="browser-app__microlabel mono">SESSION ENDED</span>
          <p>{state.reason}</p>
          <p className="browser-app__hint mono">CALL browser_open OR USE DOCK ICON TO START FRESH</p>
          <VerbHint verb="browser_open">
            <button
              className="browser-app__new-session"
              type="button"
              onClick={() => void restartBrowserSession().catch(() => undefined)}
            >
              NEW SESSION
            </button>
          </VerbHint>
        </div>
      </section>
    );
  }

  return (
    <section
      className="browser-app"
      data-browser-pid={process.pid}
      ref={liveViewContainerRef}
    >
      <iframe
        className="browser-app__live-view"
        src={state.liveViewUrl}
        title="Shared Cloudflare browser"
        referrerPolicy="no-referrer"
        allow=""
      />
    </section>
  );
}
