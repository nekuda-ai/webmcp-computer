import { useEffect, useState } from "react";
import { setSetting, type SettingKey } from "../../kernel/settings";
import { useKernelStore } from "../../kernel/store";
import { ACCENT_COLORS, THEMES, type WebMCPComputerSettings } from "../../kernel/types";
import { VerbHint } from "../../desktop/VerbHint";
import type { AppComponentProps } from "../registry";
import { ActivityLog } from "./ActivityLog";
import {
  scheduleFreshToolGroupExpirations,
  TOOL_GROUP_FRESH_MS,
} from "./toolMonitorFreshness";

type Tab = "appearance" | "tools" | "activity";

function ToolMonitor() {
  const groups = useKernelStore((state) => state.toolRegistryGroups);
  const [expiredRegistrations, setExpiredRegistrations] = useState<Record<string, number>>({});

  useEffect(() => scheduleFreshToolGroupExpirations(groups, Date.now(), (group) => {
    setExpiredRegistrations((current) => ({
      ...current,
      [group.id]: group.registeredAt,
    }));
  }), [groups]);

  return (
    <section className="tool-monitor" aria-label="Tool Monitor">
      <span className="micro">TOOL MONITOR — LIVE</span>
      {groups.length === 0 ? <p className="tool-monitor__empty mono">NO REGISTERED TOOLS</p> : null}
      {groups.map((group) => {
        const fresh = group.owner !== "system"
          && Date.now() - group.registeredAt < TOOL_GROUP_FRESH_MS
          && expiredRegistrations[group.id] !== group.registeredAt;
        return (
          <div className="tool-monitor__group" key={group.id} data-tool-owner={group.owner}>
            <div className="tool-monitor__heading">
              <span className="mono">
                {group.owner}{group.pid === undefined ? "" : ` · PID ${group.pid}`}
              </span>
              {fresh ? (
                <span className="tool-monitor__fresh mono">+{group.tools.length} JUST REGISTERED</span>
              ) : (
                <span className="micro">{group.tools.length} TOOLS</span>
              )}
            </div>
            <p className="tool-monitor__tools mono">{group.tools.join(" · ")}</p>
          </div>
        );
      })}
    </section>
  );
}

export function SettingsApp({ process }: AppComponentProps) {
  const settings = useKernelStore((state) => state.settings);
  const [tab, setTab] = useState<Tab>("appearance");
  const [hostname, setHostname] = useState(settings.hostname);
  const [error, setError] = useState("");

  useEffect(() => setHostname(settings.hostname), [settings.hostname]);

  const update = async <K extends SettingKey>(key: K, value: WebMCPComputerSettings[K]) => {
    const event = useKernelStore.getState().osEvent("human", "settings_set", { key, value });
    setError("");
    try {
      await setSetting(key, value, "human");
      useKernelStore.getState().settleEvent(event, true);
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      useKernelStore.getState().settleEvent(event, false, message);
      return false;
    }
  };

  return (
    <section className="settings-app">
      <nav className="settings-tabs" aria-label="Settings sections">
        {(["appearance", "tools", "activity"] as const).map((candidate) => (
          <VerbHint
            key={candidate}
            verb={candidate === "activity" ? "term_exec" : "settings_get"}
            arg={candidate === "activity" ? "dmesg" : candidate}
          >
            <button
              type="button"
              className={tab === candidate ? "is-active" : ""}
              onClick={() => setTab(candidate)}
            >
              {candidate === "appearance"
                ? "Appearance"
                : candidate === "tools" ? "Tool Monitor" : "Activity"}
            </button>
          </VerbHint>
        ))}
      </nav>

      {tab === "activity" ? <ActivityLog /> : tab === "tools" ? <ToolMonitor /> : (
        <div className="settings-panel">
          <div className="settings-row">
            <span>Appearance</span>
            <div className="settings-segmented">
              {THEMES.map((theme) => (
                <VerbHint key={theme} verb="settings_set" arg={`theme: ${theme}`}>
                  <button
                    type="button"
                    className={settings.theme === theme ? "is-active" : ""}
                    onClick={() => void update("theme", theme)}
                  >
                    {theme[0]?.toUpperCase()}{theme.slice(1)}
                  </button>
                </VerbHint>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span>Accent</span>
            <div className="settings-swatches">
              {ACCENT_COLORS.map((accent) => (
                <VerbHint key={accent} verb="settings_set" arg={`accent: ${accent}`}>
                  <button
                    type="button"
                    className={settings.accent === accent ? "is-active" : ""}
                    style={{ background: accent }}
                    aria-label={`Set accent ${accent}`}
                    onClick={() => void update("accent", accent)}
                  />
                </VerbHint>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span>CRT scanlines</span>
            <VerbHint verb="settings_set" arg={`crt: ${String(!settings.crt)}`}>
              <button
                type="button"
                role="switch"
                aria-checked={settings.crt}
                className={`settings-switch${settings.crt ? " is-on" : ""}`}
                onClick={() => void update("crt", !settings.crt)}
              >
                <span />
              </button>
            </VerbHint>
          </div>

          <div className="settings-row">
            <span>Verb hints</span>
            <VerbHint verb="settings_set" arg={`verb_hints: ${String(!settings.verb_hints)}`}>
              <button
                type="button"
                role="switch"
                aria-label="Verb hints"
                aria-checked={settings.verb_hints}
                className={`settings-switch${settings.verb_hints ? " is-on" : ""}`}
                onClick={() => void update("verb_hints", !settings.verb_hints)}
              >
                <span />
              </button>
            </VerbHint>
          </div>

          <div className="settings-row settings-row--cloud">
            <span>
              Cloud kernel
              <small className="mono">FRESH HOME · REBOOT</small>
            </span>
            <VerbHint verb="settings_set" arg="cloud_kernel">
              <button
                type="button"
                role="switch"
                aria-label="Cloud kernel"
                aria-checked={settings.cloud_kernel}
                className={`settings-switch${settings.cloud_kernel ? " is-on" : ""}`}
                onClick={() => void (async () => {
                  if (await update("cloud_kernel", !settings.cloud_kernel)) {
                    window.location.reload();
                  }
                })()}
              >
                <span />
              </button>
            </VerbHint>
          </div>

          <div className="settings-row">
            <label htmlFor={`settings-hostname-${process.pid}`}>Hostname</label>
            <VerbHint verb="settings_set" arg="hostname">
              <input
                id={`settings-hostname-${process.pid}`}
                className="mono"
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                onBlur={() => hostname !== settings.hostname && void update("hostname", hostname)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </VerbHint>
          </div>

          <div className="settings-row">
            <label htmlFor={`settings-idle-${process.pid}`}>Screensaver</label>
            <VerbHint verb="settings_set" arg="screensaver_minutes">
              <select
                id={`settings-idle-${process.pid}`}
                value={settings.screensaver_minutes}
                onChange={(event) => void update("screensaver_minutes", Number(event.target.value))}
              >
                <option value={0}>Off</option>
                <option value={1}>1 minute</option>
                <option value={5}>5 minutes</option>
                <option value={15}>15 minutes</option>
              </select>
            </VerbHint>
          </div>
          {error === "" ? null : <p className="settings-error mono">{error}</p>}
        </div>
      )}
    </section>
  );
}
