import { useEffect, useRef, useSyncExternalStore } from "react";
import { getApp } from "../apps/registry";
import { createFile, joinPath, ls, mkdir } from "../kernel/fs";
import {
  machineOwnershipReason,
  subscribeMachineOwnershipReason,
  takeOverMachine,
} from "../kernel/machineLock";
import { machineInteractionBlocked, type MachineOwnership } from "../kernel/machineOwnership";
import { captureMachineMutationAdmission } from "../kernel/ownershipAdmission";
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
import { VerbHint } from "./VerbHint";

function isFileExistsError(error: unknown): boolean {
  return errorMessage(error).startsWith("webmcp-computer: file exists:");
}

export async function createUntitledEntry(kind: "file" | "directory"): Promise<void> {
  const ownershipAdmission = captureMachineMutationAdmission("human");
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
        if (kind === "file") await createFile(path, "", ownershipAdmission);
        else await mkdir(path, ownershipAdmission);
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

export function machineSurfaceState(ownership: MachineOwnership): {
  blocked: boolean;
  showOwnershipNotice: boolean;
  showTakeOver: boolean;
} {
  return {
    blocked: machineInteractionBlocked(ownership),
    showOwnershipNotice: ownership !== "owned",
    showTakeOver: ownership === "conflict",
  };
}

export function Desktop() {
  const processes = useKernelStore((state) => state.processes);
  const minimizedPids = useKernelStore((state) => state.minimizedPids);
  const fileSystemWarnings = useKernelStore((state) => state.fileSystemWarnings);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);
  const machineOwnership = useKernelStore((state) => state.machineOwnership);
  const ownershipReason = useSyncExternalStore(
    subscribeMachineOwnershipReason,
    machineOwnershipReason,
    machineOwnershipReason,
  );
  const { blocked, showOwnershipNotice, showTakeOver } = machineSurfaceState(machineOwnership);
  const clampWindows = useKernelStore((state) => state.clampWindows);
  const interactiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reclamp = () => clampWindows(window.innerWidth, window.innerHeight);
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [clampWindows]);

  useEffect(() => {
    if (interactiveRef.current) interactiveRef.current.inert = blocked;
    if (blocked && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [blocked]);

  return (
    <main className="desktop">
      <div className="desktop__wallpaper" aria-hidden="true" />
      <div className="desktop__stars" aria-hidden="true" />
      <div className="desktop__mist" aria-hidden="true" />
      <div className="desktop__grain" aria-hidden="true" />
      {blocked ? <div className="machine-blocker" aria-hidden="true" /> : null}
      {!showOwnershipNotice && fileSystemWarnings.length === 0 ? null : (
        <div
          className={`machine-banner mono${fileSystemWarnings.length > 0 ? " machine-banner--error" : ""}`}
          data-analytics-block=""
          role={fileSystemWarnings.length > 0 ? "alert" : "status"}
        >
          {showOwnershipNotice ? (
            <>
              {ownershipReason}
              {showTakeOver ? (
                <>
                  {" · "}
                  <VerbHint verb="machine_take_over">
                    <button
                      type="button"
                      className="machine-banner__action mono"
                      onClick={() => {
                        const state = useKernelStore.getState();
                        const event = state.osEvent("human", "machine_take_over");
                        void takeOverMachine().then(
                          () => state.settleEvent(event, true),
                          (error: unknown) => state.settleEvent(event, false, errorMessage(error)),
                        );
                      }}
                    >
                      Take over
                    </button>
                  </VerbHint>
                </>
              ) : null}
            </>
          ) : null}
          {showOwnershipNotice && fileSystemWarnings.length > 0 ? " · " : null}
          {fileSystemWarnings.length > 0 ? `FILESYSTEM: ${fileSystemWarnings.join(" · ")}` : null}
        </div>
      )}
      <div
        ref={interactiveRef}
        className="desktop__interactive"
        {...(blocked ? { inert: "" } : {})}
        aria-hidden={blocked || undefined}
      >
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
