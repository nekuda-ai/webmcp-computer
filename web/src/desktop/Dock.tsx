import { apps } from "../apps/registry";
import { useKernelStore } from "../kernel/store";
import type { AppId, ProcessRecord } from "../kernel/types";
import { showContextMenu } from "./ContextMenu";
import { VerbHint } from "./VerbHint";
import { DockIcon } from "./DockIcon";
import { closeHumanWindow, focusHumanWindow, openHumanApp } from "./humanActions";

export function dockTargetForApp(
  processes: readonly ProcessRecord[],
  minimizedPids: readonly number[],
  appId: AppId,
): ProcessRecord | undefined {
  const candidates = processes
    .filter((candidate) => candidate.appId === appId)
    .sort((left, right) => right.zIndex - left.zIndex);
  return candidates.find(({ pid }) => !minimizedPids.includes(pid)) ?? candidates[0];
}

export function Dock() {
  const processes = useKernelStore((state) => state.processes);
  const minimizedPids = useKernelStore((state) => state.minimizedPids);

  return (
    <nav className="dock" aria-label="Applications">
      {apps.filter(({ id }) => id !== "ui").map((app) => {
        const process = dockTargetForApp(processes, minimizedPids, app.id);
        const isOpen = process !== undefined;
        const openOrFocus = () => {
          if (process) focusHumanWindow(process.pid);
          else openHumanApp(app.id);
        };
        return (
          <VerbHint
            key={app.id}
            verb={process
              ? "window_focus"
              : app.id === "browser" ? "browser_open" : "app_open"}
            {...(process
              ? { arg: `PID ${process.pid}` }
              : app.id === "browser" ? {} : { arg: app.id })}
          >
            <span className="dock__item">
              <button
                className="dock__button"
                type="button"
                aria-label={`Open ${app.name}`}
                onClick={openOrFocus}
                onContextMenu={(event) => showContextMenu(event, {
                  label: `${app.name} dock icon`,
                  items: [
                    {
                      label: process ? "Focus" : "Open",
                      verb: process
                        ? "window_focus"
                        : app.id === "browser" ? "browser_open" : "app_open",
                      ...(process
                        ? { arg: `PID ${process.pid}` }
                        : app.id === "browser" ? {} : { arg: app.id }),
                      onSelect: openOrFocus,
                    },
                    { type: "separator" },
                    {
                      label: "Close window",
                      ...(process ? { verb: "app_close", arg: `PID ${process.pid}` } : {}),
                      disabled: !process,
                      onSelect: () => { if (process) closeHumanWindow(process.pid); },
                    },
                  ],
                })}
              >
                <DockIcon icon={app.icon} />
              </button>
              <span className={`dock__running${isOpen ? " is-open" : ""}`} aria-hidden="true" />
            </span>
          </VerbHint>
        );
      })}
    </nav>
  );
}
