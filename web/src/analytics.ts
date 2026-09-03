import type { PostHogConfig } from "posthog-js/dist/module.full.no-external";
import { useKernelStore } from "./kernel/store";
import { APP_IDS, type AppId, type OSEvent } from "./kernel/types";

const ANALYTICS_EVENT = "webmcp_usage";

export const ANALYTICS_BLOCK_ATTRIBUTE = "data-analytics-block";
export const ANALYTICS_BLOCK_SELECTOR = [
  `[${ANALYTICS_BLOCK_ATTRIBUTE}]`,
  "iframe",
  ".xterm",
  ".monaco-editor",
].join(", ");

const ACTORS = ["human", "agent", "embedded_app"] as const;
const FAMILIES = [
  "app_shell",
  "filesystem",
  "terminal",
  "system",
  "browser",
  "cloud",
  "publishing",
  "notes",
  "preview",
  "ui",
  "site",
] as const;
const ACTIONS = [
  "open",
  "close",
  "focus",
  "move",
  "resize",
  "read",
  "write",
  "search",
  "execute",
  "navigate",
  "interact",
  "configure",
  "publish",
  "reload",
  "other",
] as const;
const APPS = [...APP_IDS, "none"] as const;

type Actor = (typeof ACTORS)[number];
type UsageFamily = (typeof FAMILIES)[number];
type UsageAction = (typeof ACTIONS)[number];
type UsageApp = (typeof APPS)[number];

export type SafeUsageEvent = {
  event: typeof ANALYTICS_EVENT;
  properties: {
    actor: Actor;
    family: UsageFamily;
    action: UsageAction;
    app: UsageApp;
    succeeded: boolean;
  };
};

type AnalyticsEnvironment = {
  VITE_POSTHOG_KEY?: string;
  VITE_POSTHOG_HOST?: string;
};

type AnalyticsClient = {
  init(key: string, options: Partial<PostHogConfig>): unknown;
  capture(event: string, properties: SafeUsageEvent["properties"]): unknown;
};

type AnalyticsDependencies = {
  loadClient: () => Promise<AnalyticsClient>;
  subscribe: (listener: (events: readonly OSEvent[], previous: readonly OSEvent[]) => void) => () => void;
};

type AnalyticsPayload = {
  event?: unknown;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

const SAFE_PROPERTY_VALUES = {
  actor: new Set<string>(ACTORS),
  family: new Set<string>(FAMILIES),
  action: new Set<string>(ACTIONS),
  app: new Set<string>(APPS),
};

const REQUIRED_POSTHOG_PROPERTIES = [
  "token",
  "distinct_id",
  "$device_id",
  "$lib",
  "$lib_version",
  "$process_person_profile",
] as const;

const REPLAY_PROPERTIES = [
  "token",
  "distinct_id",
  "$device_id",
  "$session_id",
  "$window_id",
  "$snapshot_data",
  "$snapshot_bytes",
  "$lib",
  "$lib_version",
] as const;

function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && APP_IDS.includes(value as AppId);
}

function actorFor(source: OSEvent["source"]): Actor | undefined {
  if (source === "human" || source === "agent") return source;
  return source === "app" ? "embedded_app" : undefined;
}

function familyFor(verb: string): UsageFamily | undefined {
  if (verb.startsWith("app_") || verb.startsWith("window_")) return "app_shell";
  if (verb.startsWith("fs_") || verb.startsWith("editor_") || verb.startsWith("files_")) {
    return "filesystem";
  }
  if (verb.startsWith("term_") || verb === "ps" || verb === "kill") return "terminal";
  if (verb.startsWith("browser_")) return "browser";
  if (verb.startsWith("cloud_")) return "cloud";
  if (verb === "os_publish") return "publishing";
  if (verb.startsWith("notes_")) return "notes";
  if (verb.startsWith("preview_") || verb === "serve") return "preview";
  if (verb.startsWith("ui_")) return "ui";
  if (verb.startsWith("site_")) return "site";
  if (
    verb.startsWith("sys_") || verb.startsWith("settings_") ||
    verb === "os_manual" || verb === "os_search" || verb === "screensaver_wake"
  ) {
    return "system";
  }
  return undefined;
}

function actionFor(verb: string): UsageAction {
  if (verb.endsWith("_open") || verb === "app_open" || verb === "editor_open_file") return "open";
  if (verb === "app_close" || verb === "kill" || verb.endsWith("_delete")) return "close";
  if (verb === "window_focus" || verb.endsWith("_reveal")) return "focus";
  if (verb === "window_move" || verb === "fs_move") return "move";
  if (verb === "window_resize") return "resize";
  if (
    verb.endsWith("_read") || verb.endsWith("_list") || verb.endsWith("_get") ||
    verb.endsWith("_state") || verb.endsWith("_history") || verb.endsWith("_screenshot") ||
    verb === "ps" || verb === "os_manual" || verb.endsWith("_tools")
  ) {
    return "read";
  }
  if (verb.endsWith("_search")) return "search";
  if (
    verb.endsWith("_write") || verb.endsWith("_edit") || verb.endsWith("_mkdir") ||
    verb.endsWith("_append") || verb.endsWith("_stick")
  ) {
    return "write";
  }
  if (verb.endsWith("_exec") || verb.endsWith("_call")) return "execute";
  if (verb.endsWith("_goto")) return "navigate";
  if (verb.endsWith("_click") || verb.endsWith("_type")) return "interact";
  if (verb.startsWith("settings_")) return "configure";
  if (verb === "os_publish") return "publish";
  if (verb.endsWith("_reload")) return "reload";
  return "other";
}

function requiresSettledOutcome(event: OSEvent): boolean {
  if (event.source === "agent" || event.source === "app") return true;
  return event.verb.startsWith("fs_") || event.verb === "term_exec" || event.verb === "settings_set";
}

/** Maps the rich OS event bus onto the only fixed, content-free usage shape analytics accepts. */
export function safeUsageEvent(event: OSEvent): SafeUsageEvent | undefined {
  const actor = actorFor(event.source);
  const family = familyFor(event.verb);
  if (!actor || !family || (requiresSettledOutcome(event) && event.ok === undefined)) return undefined;

  return {
    event: ANALYTICS_EVENT,
    properties: {
      actor,
      family,
      action: actionFor(event.verb),
      app: isAppId(event.args.appId) ? event.args.appId : "none",
      succeeded: event.ok !== false,
    },
  };
}

/** Fail-closed PostHog filter: only sanitized replay payloads and the typed usage event leave the page. */
export function filterAnalyticsPayload(payload: AnalyticsPayload | null): AnalyticsPayload | null {
  if (!payload || typeof payload.event !== "string") return null;
  const input = payload.properties;
  if (!input || typeof input !== "object") return null;

  const { $set: _set, $set_once: _setOnce, ...safePayload } = payload;

  if (payload.event === "$snapshot") {
    const properties: Record<string, unknown> = {};
    for (const key of REPLAY_PROPERTIES) {
      if (input[key] !== undefined) properties[key] = input[key];
    }
    return { ...safePayload, properties };
  }

  if (payload.event !== ANALYTICS_EVENT) return null;
  if (
    !SAFE_PROPERTY_VALUES.actor.has(String(input.actor)) ||
    !SAFE_PROPERTY_VALUES.family.has(String(input.family)) ||
    !SAFE_PROPERTY_VALUES.action.has(String(input.action)) ||
    !SAFE_PROPERTY_VALUES.app.has(String(input.app)) ||
    typeof input.succeeded !== "boolean"
  ) {
    return null;
  }

  const properties: Record<string, unknown> = {
    actor: input.actor,
    family: input.family,
    action: input.action,
    app: input.app,
    succeeded: input.succeeded,
  };
  for (const key of REQUIRED_POSTHOG_PROPERTIES) {
    if (input[key] !== undefined) properties[key] = input[key];
  }
  return { ...safePayload, properties };
}

export function postHogOptions(host: string): Partial<PostHogConfig> {
  return {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_dead_clicks: false,
    disable_session_recording: false,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    enable_recording_console_log: false,
    disable_external_dependency_loading: true,
    advanced_disable_feature_flags: true,
    person_profiles: "never",
    respect_dnt: true,
    save_campaign_params: false,
    mask_personal_data_properties: true,
    get_current_url: () => "redacted",
    before_send: filterAnalyticsPayload as Exclude<PostHogConfig["before_send"], undefined>,
    session_recording: {
      maskAllInputs: true,
      maskAllElementAttributes: true,
      blockSelector: ANALYTICS_BLOCK_SELECTOR,
      inlineStylesheet: false,
      recordHeaders: false,
      recordBody: false,
      streamNetworkBody: false,
      captureCanvas: { recordCanvas: false },
      recordCrossOriginIframes: false,
      captureJsonLd: false,
      maskCapturedNetworkRequestFn: (request) => ({
        name: "redacted",
        entryType: request.entryType,
        startTime: request.startTime,
        duration: request.duration,
      }),
    },
  };
}

const DEFAULT_DEPENDENCIES: AnalyticsDependencies = {
  async loadClient() {
    const { default: posthog } = await import("posthog-js/dist/module.full.no-external");
    return posthog;
  },
  subscribe(listener) {
    const captured = new WeakSet<object>();
    return useKernelStore.subscribe((state, previous) => {
      if (state.events === previous.events) return;
      const freshEvents = state.events.filter((event) => !captured.has(event));
      for (const event of freshEvents) captured.add(event);
      listener(freshEvents, previous.events);
    });
  },
};

/** Optional, no-throw boot seam. Both public build-time values are required to activate it. */
export async function initializeAnalytics(
  environment: AnalyticsEnvironment = import.meta.env,
  dependencies: Partial<AnalyticsDependencies> = {},
): Promise<() => void> {
  const key = environment.VITE_POSTHOG_KEY?.trim();
  const host = environment.VITE_POSTHOG_HOST?.trim();
  if (!key || !host) return () => {};

  const resolved = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  try {
    const client = await resolved.loadClient();
    client.init(key, postHogOptions(host));
    const captured = new WeakSet<object>();
    return resolved.subscribe((events) => {
      for (const event of events) {
        if (captured.has(event)) continue;
        const usage = safeUsageEvent(event);
        if (!usage) continue;
        captured.add(event);
        try {
          client.capture(usage.event, usage.properties);
        } catch {
          // Analytics is optional and must never affect the computer.
        }
      }
    });
  } catch {
    return () => {};
  }
}
