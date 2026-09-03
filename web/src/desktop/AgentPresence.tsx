import { useEffect, useMemo, useState } from "react";
import { useKernelStore } from "../kernel/store";
import type { WindowRect } from "../kernel/types";
import { formatEventSummary, TOAST_SUMMARY_MAX_CHARS } from "./verbPresentation";
import { qrSvg } from "../shared/qr";

export const AGENT_CURSOR_IDLE_MS = 8_000;

function eventRect(value: unknown): WindowRect | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const rect = value as Record<string, unknown>;
  if (
    typeof rect.x !== "number" ||
    typeof rect.y !== "number" ||
    typeof rect.width !== "number" ||
    typeof rect.height !== "number"
  ) {
    return undefined;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function cursorTarget(rect: WindowRect): { x: number; y: number } {
  return {
    x: rect.x + Math.min(rect.width - 34, 250),
    y: rect.y + 86,
  };
}

function publishedQr(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return qrSvg(url);
  } catch {
    return undefined;
  }
}

export function PublishToast({
  url,
  expiresInDays,
}: {
  url: string;
  expiresInDays: number;
}) {
  const qr = publishedQr(url);
  return (
    <>
      <span className="agent-toast__publish-copy mono">
        <strong>SITE PUBLISHED</strong>
        <span>{url}</span>
        <span className="agent-toast__publish-expiry">
          PUBLIC · EXPIRES IN {expiresInDays} DAYS
        </span>
      </span>
      {qr ? (
        <span
          className="agent-toast__qr"
          aria-label={`QR code for ${url}`}
          dangerouslySetInnerHTML={{ __html: qr }}
        />
      ) : null}
    </>
  );
}

export function AgentPresence() {
  const event = useKernelStore((state) => state.agentPresenceEvent ?? undefined);
  const processes = useKernelStore((state) => state.processes);
  const [cursorVisible, setCursorVisible] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    if (!event) return undefined;
    setCursorVisible(true);
    setToastVisible(true);
    const cursorTimer = window.setTimeout(() => setCursorVisible(false), AGENT_CURSOR_IDLE_MS);
    const toastTimer = window.setTimeout(
      () => setToastVisible(false),
      event.verb === "os_publish" ? 12_000 : 3_600,
    );
    return () => {
      window.clearTimeout(cursorTimer);
      window.clearTimeout(toastTimer);
    };
  }, [event]);

  const target = useMemo(() => {
    if (!event) return { x: 56, y: 76 };
    const pid = typeof event.args.pid === "number" ? event.args.pid : undefined;
    const explicitAppId = typeof event.args.appId === "string" ? event.args.appId : undefined;
    const path = typeof event.args.path === "string" ? event.args.path : undefined;
    const affectedEditor = path === undefined
      ? undefined
      : [...processes].reverse().find((entry) => entry.appId === "editor" && entry.path === path);
    const appId = explicitAppId
      ?? (event.verb.startsWith("fs_") ? "files" : undefined)
      ?? (event.verb.startsWith("editor_") ? "editor" : undefined)
      ?? (event.verb.startsWith("notes_") ? "notes" : undefined)
      ?? (event.verb.startsWith("term_") ? "terminal" : undefined);
    const process = pid === undefined
      ? affectedEditor ?? [...processes].reverse().find((entry) => entry.appId === appId)
      : processes.find((entry) => entry.pid === pid);
    if (process) return cursorTarget(process.windowRect);
    const closedRect = eventRect(event.args.rect);
    if (closedRect) return cursorTarget(closedRect);
    return { x: window.innerWidth * 0.58, y: window.innerHeight * 0.34 };
  }, [event, processes]);

  if (!event) return null;
  const failed = event.ok === false;
  const label = formatEventSummary(event, TOAST_SUMMARY_MAX_CHARS);
  const publishedUrl = event.verb === "os_publish" && event.ok === true &&
      typeof event.args.url === "string"
    ? event.args.url
    : undefined;
  const publishedExpiryDays = event.verb === "os_publish" && event.ok === true &&
      typeof event.args.expiresInDays === "number" &&
      Number.isInteger(event.args.expiresInDays) &&
      event.args.expiresInDays > 0
    ? event.args.expiresInDays
    : undefined;
  const publishedSite = publishedUrl !== undefined && publishedExpiryDays !== undefined
    ? { url: publishedUrl, expiresInDays: publishedExpiryDays }
    : undefined;

  return (
    <div className="agent-presence" data-analytics-block="" aria-live="polite">
      <div
        className={`agent-cursor${cursorVisible ? " is-visible" : ""}`}
        style={{ transform: `translate(${target.x}px, ${target.y}px)` }}
      >
        <span className="agent-cursor__dot" aria-hidden="true" />
        <span className="agent-cursor__tag mono">CODEX</span>
      </div>
      <div className={`agent-toast${toastVisible ? " is-visible" : ""}${failed ? " is-failed" : ""}${publishedSite ? " is-publish" : ""}`}>
        <span className="agent-toast__dot" aria-hidden="true" />
        {publishedSite ? (
          <PublishToast url={publishedSite.url} expiresInDays={publishedSite.expiresInDays} />
        ) : (
          <span className="mono">
            {failed ? "AGENT FAILED" : "AGENT RAN"}: {label}
          </span>
        )}
      </div>
    </div>
  );
}
