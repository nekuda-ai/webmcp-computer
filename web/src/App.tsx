import { useEffect } from "react";
import { Desktop } from "./desktop/Desktop";
import { Screensaver } from "./desktop/Screensaver";
import { bootFileSystem } from "./kernel/fs";
import { useKernelStore } from "./kernel/store";
import { SystemToolRegistrar } from "./tools/SystemToolRegistrar";
import { loadSettings } from "./kernel/settings";
import { startMachineOwnership } from "./kernel/machineLock";
import { restoreSessionFromStorage, startSessionPersistence } from "./kernel/sessionPersistence";
import { contextMenuMachine } from "./desktop/ContextMenu";
import { initializeHostedSession } from "./kernel/hostedSession";

function SystemEffects() {
  const settings = useKernelStore((state) => state.settings);
  const lastActivityAt = useKernelStore((state) => state.lastActivityAt);
  const screensaverActive = useKernelStore((state) => state.screensaverActive);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--accent", settings.accent);
    root.style.setProperty("--scanline-opacity", settings.crt ? "0.035" : "0");
  }, [settings.accent, settings.crt, settings.theme]);

  useEffect(() => {
    if (screensaverActive || settings.screensaver_minutes === 0) return undefined;
    const delay = Math.max(0, lastActivityAt + settings.screensaver_minutes * 60_000 - Date.now());
    const timer = window.setTimeout(() => {
      contextMenuMachine.dismiss("activation");
      useKernelStore.getState().activateScreensaver();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [lastActivityAt, screensaverActive, settings.screensaver_minutes]);

  return null;
}

export function App() {
  const screensaverActive = useKernelStore((state) => state.screensaverActive);

  useEffect(() => {
    startMachineOwnership();
    let active = true;
    let stopSessionPersistence: (() => void) | undefined;
    void initializeHostedSession()
      .then(() => bootFileSystem())
      .then(async () => {
        await loadSettings();
      })
      .catch((error: unknown) => {
        console.error("WebMCP Computer filesystem failed to boot", error);
      })
      .finally(() => {
        if (!active) return;
        restoreSessionFromStorage();
        stopSessionPersistence = startSessionPersistence();
      });
    return () => {
      active = false;
      stopSessionPersistence?.();
    };
  }, []);

  useEffect(() => {
    const activity = (event: KeyboardEvent | PointerEvent) => {
      const state = useKernelStore.getState();
      if (!event.isTrusted || (event instanceof KeyboardEvent && event.repeat)) return;
      state.recordHumanActivity();
      if (!state.screensaverActive) return;
      const wasActive = state.wakeScreensaver();
      if (wasActive) {
        state.osEvent("human", "screensaver_wake", event instanceof KeyboardEvent
          ? { via: "keyboard", key: event.key }
          : { via: "pointer" });
      }
    };
    window.addEventListener("keydown", activity);
    window.addEventListener("pointerdown", activity);
    return () => {
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointerdown", activity);
    };
  }, []);

  return (
    <>
      <SystemToolRegistrar />
      <SystemEffects />
      <Desktop />
      {screensaverActive ? <Screensaver /> : null}
    </>
  );
}
