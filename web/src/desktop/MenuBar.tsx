import { useEffect, useState } from "react";
import { latestAgentEvent, useKernelStore } from "../kernel/store";
import type { ToolRegistrationStatus } from "../kernel/types";
import { machineIdentity } from "../kernel/identity";

const formatClock = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

export function agentSurfaceLabel(
  statuses: readonly ToolRegistrationStatus[] | null,
): string | undefined {
  if (statuses === null) return undefined;
  const registered = statuses.filter(({ state }) => state === "registered").length;
  if (registered === statuses.length) return undefined;
  if (registered === 0) return "AGENT SURFACE: NONE";
  return `AGENT SURFACE: ${registered}/${statuses.length}`;
}

export function MenuBar() {
  const event = useKernelStore((state) => latestAgentEvent(state.events));
  const toolRegistrationStatuses = useKernelStore((state) => state.toolRegistrationStatuses);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);
  const fileSystemBackend = useKernelStore((state) => state.fileSystemBackend);
  const hostname = useKernelStore((state) => state.settings.hostname);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const agentOnline = event !== undefined && now.getTime() - event.ts < 30_000;
  const surfaceLabel = agentSurfaceLabel(toolRegistrationStatuses);
  const agentStatus = surfaceLabel ?? (agentOnline ? "AGENT ONLINE" : "AGENT —");
  const identity = machineIdentity(hostname);

  return (
    <header className="menu-bar" data-fs-status={fileSystemStatus}>
      <div className="menu-bar__identity">
        <span className="wordmark">verbOS</span>
        <span className="menu-bar__user mono">~/{identity.user.toUpperCase()}</span>
      </div>
      <div className="menu-bar__status">
        {fileSystemStatus !== "ready" ? (
          <span className={`menu-bar__fs mono is-${fileSystemStatus}`}>
            FS: {fileSystemStatus.toUpperCase()}
          </span>
        ) : fileSystemBackend === "memory" ? (
          <span className="menu-bar__fs mono is-memory">FS: MEMORY</span>
        ) : null}
        {fileSystemStatus === "ready" && fileSystemBackend === "cloud" ? (
          <span className="menu-bar__cloud mono">CLOUD</span>
        ) : null}
        <span className={`agent-status${agentOnline ? " is-online" : ""}`}>
          <span className="agent-status__dot" aria-hidden="true" />
          <span className="mono">{agentStatus}</span>
        </span>
        <span className="menu-bar__divider" aria-hidden="true" />
        <time className="mono" dateTime={now.toISOString()}>{formatClock(now)}</time>
      </div>
    </header>
  );
}
