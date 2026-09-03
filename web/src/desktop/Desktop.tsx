import { useEffect, useRef, useSyncExternalStore } from "react";
import { getApp } from "../apps/registry";
import { createFile, joinPath, ls, mkdir } from "../kernel/fs";
import {
  machineConflictReason,
  subscribeMachineConflictReason,
  takeOverMachine,
} from "../kernel/machineLock";
import { useKernelStore } from "../kernel/store";
import type { ProcessRecord } from "../kernel/types";
import { errorMessage } from "../shared";
import { AgentPresence } from "./AgentPresence";
import { ContextMenu, showContextMenu } from "./ContextMenu";
import { Dock } from "./Dock";
import { MenuBar } from "./MenuBar";
import { Window } from "./Window";
import { Spotlight } from "./Spotlight";
import { DesktopIcons } from "./DesktopIcons";
import { StickyNotes } from "./StickyNotes";
import { openHumanApp } from "./humanActions";
import { nextUntitledName } from "./untitledName";

function isFileExistsError(error: unknown): boolean {
  return errorMessage(error).startsWith("webmcp-computer: file exists:");
}

export async function createUntitledEntry(kind: "file" | "directory"): Promise<void> {
  const state = useKernelStore.getState();
  const verb = kind === "file" ? "fs_write" : "fs_mkdir";
  let path = "~/desktop/untitled";
  let event = state.osEvent("human", verb, { path });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entries = await ls("~/desktop");
      path = joinPath("~/desktop", nextUntitledName(entries.map(({ name }) => name)));
      if (path !== "~/desktop/untitled") event = state.annotateEvent(event, { path });
      try {
        if (kind === "file") await createFile(path, "", "human");
        else await mkdir(path, "human");
        state.settleEvent(event, true);
        return;
      } catch (error) {
        if (attempt === 0 && isFileExistsError(error)) continue;
        throw error;
      }
    }
  } catch (error) {
    state.settleEvent(event, false, errorMessage(error));
  }
}

export function DesktopWindows({
  processes,
  minimizedPids,
}: {
  processes: readonly ProcessRecord[];
  minimizedPids: readonly number[];
}) {
  return processes.map((process) => (
    <Window
      key={process.pid}
      process={process}
      app={getApp(process.appId)}
      minimized={minimizedPids.includes(process.pid)}
    />
  ));
}

export function Desktop() {
  const processes = useKernelStore((state) => state.processes);
  const minimizedPids = useKernelStore((state) => state.minimizedPids);
  const fileSystemWarnings = useKernelStore((state) => state.fileSystemWarnings);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);
  const machineConflict = useKernelStore((state) => state.machineConflict);
  const conflictReason = useSyncExternalStore(subscribeMachineConflictReason, machineConflictReason);
  const clampWindows = useKernelStore((state) => state.clampWindows);
  const interactiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reclamp = () => clampWindows(window.innerWidth, window.innerHeight);
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [clampWindows]);

  useEffect(() => {
    if (interactiveRef.current) interactiveRef.current.inert = machineConflict;
    if (machineConflict && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [machineConflict]);

  return (
    <main className="desktop">
      <div className="desktop__wallpaper" aria-hidden="true" />
      <div className="desktop__stars" aria-hidden="true" />
      <div className="desktop__mist" aria-hidden="true" />
      <div className="desktop__grain" aria-hidden="true" />
      {machineConflict ? <div className="machine-blocker" aria-hidden="true" /> : null}
      {!machineConflict && fileSystemWarnings.length === 0 ? null : (
        <div
          className={`machine-banner mono${fileSystemWarnings.length > 0 ? " machine-banner--error" : ""}`}
          role={fileSystemWarnings.length > 0 ? "alert" : "status"}
        >
          {machineConflict ? (
            <>
              {conflictReason}
              {" · "}
              <button
                type="button"
                className="machine-banner__action mono"
                onClick={() => void takeOverMachine()}
              >
                Take over
              </button>
            </>
          ) : null}
          {machineConflict && fileSystemWarnings.length > 0 ? " · " : null}
          {fileSystemWarnings.length > 0 ? `FILESYSTEM: ${fileSystemWarnings.join(" · ")}` : null}
        </div>
      )}
      <div ref={interactiveRef} className="desktop__interactive" aria-hidden={machineConflict || undefined}>
        <MenuBar />
        <section
          className="desktop__workarea"
          aria-label="Desktop"
          onContextMenu={(event) => {
            if (event.target !== event.currentTarget) return;
            showContextMenu(event, {
              label: "Desktop",
              items: [
                {
                  label: "New file…",
                  verb: "fs_write",
                  arg: "~/desktop/untitled",
                  disabled: fileSystemStatus !== "ready",
                  onSelect: () => { void createUntitledEntry("file"); },
                },
                {
                  label: "New folder…",
                  verb: "fs_mkdir",
                  arg: "~/desktop/untitled",
                  disabled: fileSystemStatus !== "ready",
                  onSelect: () => { void createUntitledEntry("directory"); },
                },
                { type: "separator" },
                {
                  label: "Open Terminal",
                  verb: "app_open",
                  arg: "terminal",
                  onSelect: () => { openHumanApp("terminal"); },
                },
                {
                  label: "Open Settings",
                  verb: "app_open",
                  arg: "settings",
                  onSelect: () => { openHumanApp("settings"); },
                },
              ],
            });
          }}
        >
          <DesktopIcons />
          <StickyNotes />
          <DesktopWindows processes={processes} minimizedPids={minimizedPids} />
          <AgentPresence />
        </section>
        <Dock />
        <Spotlight />
        <ContextMenu />
      </div>
      <span className="desktop__signature mono">V.01 —— WEBMCP COMPUTER // ONE MACHINE, TWO USERS</span>
      <div className="desktop__scanlines" aria-hidden="true" />
      <div className="desktop__vignette" aria-hidden="true" />
    </main>
  );
}
