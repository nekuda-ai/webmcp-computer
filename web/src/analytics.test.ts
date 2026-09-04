import { describe, expect, test } from "bun:test";
import type { OSEvent } from "./kernel/types";
import {
  ANALYTICS_BLOCK_ATTRIBUTE,
  filterAnalyticsPayload,
  initializeAnalytics,
  postHogOptions,
  safeUsageEvent,
} from "./analytics";

function osEvent(overrides: Partial<OSEvent> = {}): OSEvent {
  return {
    source: "agent",
    verb: "fs_read",
    args: {},
    ts: 1,
    ok: true,
    ...overrides,
  };
}

describe("optional PostHog analytics", () => {
  test("does nothing unless both build-time values are configured", async () => {
    let loads = 0;
    const loadClient = async () => {
      loads += 1;
      throw new Error("must not load");
    };

    await initializeAnalytics({}, { loadClient });
    await initializeAnalytics({ VITE_POSTHOG_KEY: "phc_public" }, { loadClient });
    await initializeAnalytics({ VITE_POSTHOG_HOST: "https://posthog.example" }, { loadClient });

    expect(loads).toBe(0);
  });

  test("swallows package, initialization, subscription, and capture failures", async () => {
    await expect(initializeAnalytics(
      { VITE_POSTHOG_KEY: "phc_public", VITE_POSTHOG_HOST: "https://posthog.example" },
      { loadClient: async () => { throw new Error("load failed"); } },
    )).resolves.toBeFunction();

    await expect(initializeAnalytics(
      { VITE_POSTHOG_KEY: "phc_public", VITE_POSTHOG_HOST: "https://posthog.example" },
      {
        loadClient: async () => ({
          init() { throw new Error("init failed"); },
          capture() {},
        }),
      },
    )).resolves.toBeFunction();

    let listener: ((events: readonly OSEvent[], previous: readonly OSEvent[]) => void) | undefined;
    await initializeAnalytics(
      { VITE_POSTHOG_KEY: "phc_public", VITE_POSTHOG_HOST: "https://posthog.example" },
      {
        loadClient: async () => ({
          init() {},
          capture() { throw new Error("capture failed"); },
        }),
        subscribe(next) {
          listener = next;
          return () => {};
        },
      },
    );
    expect(() => listener?.([osEvent()], [])).not.toThrow();
  });

  test("uses restrictive replay and privacy configuration", () => {
    const options = postHogOptions("https://posthog.example");
    expect(options).toMatchObject({
      api_host: "https://posthog.example",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_session_recording: false,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      enable_recording_console_log: false,
      disable_external_dependency_loading: true,
      person_profiles: "never",
      respect_dnt: true,
      session_recording: {
        maskAllInputs: true,
        maskAllElementAttributes: true,
        inlineStylesheet: false,
        recordHeaders: false,
        recordBody: false,
        streamNetworkBody: false,
        captureCanvas: { recordCanvas: false },
        recordCrossOriginIframes: false,
        captureJsonLd: false,
      },
    });
    expect(options.session_recording?.blockSelector).toContain(`[${ANALYTICS_BLOCK_ATTRIBUTE}]`);
    expect(options.session_recording?.blockSelector).toContain("iframe");
    expect(options.session_recording?.maskCapturedNetworkRequestFn?.({
      name: "https://secret.test",
      duration: 1,
      entryType: "resource",
      startTime: 1,
    })).toEqual({
      name: "redacted",
      duration: 1,
      entryType: "resource",
      startTime: 1,
    });
  });

  test("maps rich OS events only to fixed enums and a success boolean", () => {
    const mapped = safeUsageEvent(osEvent({
      verb: "browser_goto",
      args: {
        appId: "browser",
        url: "https://private.example/path",
        workspaceId: "workspace-secret",
        command: "rm -rf secret",
      },
      reason: "private failure details",
      ok: false,
    }));

    expect(mapped).toEqual({
      event: "webmcp_usage",
      properties: {
        actor: "agent",
        family: "browser",
        action: "navigate",
        app: "browser",
        succeeded: false,
      },
    });
    expect(JSON.stringify(mapped)).not.toContain("private");
    expect(JSON.stringify(mapped)).not.toContain("workspace");
    expect(safeUsageEvent(osEvent({ verb: "site_customer_defined_name" }))).toEqual({
      event: "webmcp_usage",
      properties: {
        actor: "agent",
        family: "site",
        action: "other",
        app: "none",
        succeeded: true,
      },
    });
    expect(safeUsageEvent(osEvent({ verb: "machine_take_over" }))).toEqual({
      event: "webmcp_usage",
      properties: {
        actor: "agent",
        family: "system",
        action: "other",
        app: "none",
        succeeded: true,
      },
    });
    expect(safeUsageEvent(osEvent({ source: "system", reason: "error" }))).toBeUndefined();
    expect(safeUsageEvent({
      source: "agent",
      verb: "fs_read",
      args: {},
      ts: 1,
    })).toBeUndefined();
  });

  test("filters all non-usage events and untyped or sensitive properties", () => {
    expect(filterAnalyticsPayload({ event: "$pageview", properties: {} })).toBeNull();
    expect(filterAnalyticsPayload({
      event: "webmcp_usage",
      properties: {
        actor: "agent",
        family: "browser",
        action: "navigate",
        app: "browser",
        succeeded: false,
        url: "https://private.example",
        reason: "secret error",
        token: "public-project-key",
      },
      $set: { email: "secret@example.com" },
      $set_once: { $initial_current_url: "https://private.example" },
    })).toEqual({
      event: "webmcp_usage",
      properties: {
        actor: "agent",
        family: "browser",
        action: "navigate",
        app: "browser",
        succeeded: false,
        token: "public-project-key",
      },
    });
    expect(filterAnalyticsPayload({
      event: "webmcp_usage",
      properties: { actor: "unknown", family: "browser", action: "read", app: "none", succeeded: true },
    })).toBeNull();

    expect(filterAnalyticsPayload({
      event: "$snapshot",
      properties: {
        $current_url: "https://private.example/path",
        $referrer: "https://referrer.example",
        $snapshot_data: { type: 2, data: "sanitized-by-recorder" },
        unexpected: "must be dropped",
      },
      $set: { email: "secret@example.com" },
    })).toEqual({
      event: "$snapshot",
      properties: { $snapshot_data: { type: 2, data: "sanitized-by-recorder" } },
    });
  });
});
