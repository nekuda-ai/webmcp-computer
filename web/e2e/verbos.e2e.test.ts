import { afterAll, beforeAll, test } from "bun:test";
import {
  bootFailurePreservesSessionScenario,
  bootResilienceScenario,
  preRestoreAppOpenScenario,
  SAVED_EDITOR_SESSION,
} from "./bootResilience.e2e";
import { BOOT_TOOL_NAMES, coldBootScenario } from "./coldBoot.e2e";
import { agentDrivesDesktopScenario, honestFailureScenario, multiTabProtectionScenario } from "./desktop.e2e";
import {
  closeVerbOSPage,
  openVerbOSPage,
  startHarness,
  stopHarness,
  waitForWebMcpTools,
} from "./harness";
import { sharedFileScenario } from "./sharedFile.e2e";
import { terminalScenario } from "./terminal.e2e";
import { verbHintScenario } from "./verbHint.e2e";
import { previewScenario } from "./preview.e2e";
import { m5Scenario, spotlightHoverPrecedenceScenario } from "./m5.e2e";
import {
  agentPlacementScenario,
  autosaveCatScenario,
  desktopIconScenario,
  emptyOpfsWriteScenario,
  orphanedStickyNoteScenario,
  repeatedSessionRestoreScenario,
  sessionRestoreScenario,
  smallerViewportRestoreScenario,
  stickyActivityScenario,
  unfocusedStackingScenario,
  windowChromeThemeScenario,
} from "./m6.e2e";
import type { SessionSnapshot } from "../src/kernel/sessionSnapshot";
import { agentMadeAppScenario } from "./m7.e2e";
import { browserScenario } from "./browser.e2e";
import { startFakeBrowserRun } from "./fakeBrowserRun";
import { cloudKernelScenario } from "./cloud.e2e";
import { startFakeComputer } from "./fakeComputer";

// Bare `bun test` scans every *.test.ts; lifecycle gating keeps that command unit-only.
if (process.env.npm_lifecycle_event === "test:e2e") {
  beforeAll(startHarness);
  afterAll(stopHarness);

  test("cold boot exposes the complete agent surface and any call wakes the OS", async () => {
    const testPage = await openVerbOSPage();
    try {
      await coldBootScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("agent drives visible window lifecycle and geometry", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await agentDrivesDesktopScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("human and agent share one persistent file without clobbering dirty edits", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await sharedFileScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("tool failures reach both caller and visible agent trace", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await honestFailureScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("a second VerbOS tab shows the persistent machine ownership warning", async () => {
    const testPage = await openVerbOSPage();
    try {
      await multiTabProtectionScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("filesystem boot failure leaves desktop and non-filesystem tools usable", async () => {
    const testPage = await openVerbOSPage({ forceFileSystemBootFailure: true });
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await bootResilienceScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("filesystem boot failure restores and preserves the saved window snapshot", async () => {
    const testPage = await openVerbOSPage({
      forceFileSystemBootFailure: true,
      sessionSnapshot: SAVED_EDITOR_SESSION,
    });
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await bootFailurePreservesSessionScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("app_open completed before restore keeps its live PID after snapshot merge", async () => {
    const testPage = await openVerbOSPage({
      pauseFileSystemBoot: true,
      sessionSnapshot: SAVED_EDITOR_SESSION,
    });
    try {
      await preRestoreAppOpenScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("agent and human share one visible terminal", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await terminalScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("verb hints preserve mounted children and one active chip across setting changes", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await verbHintScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("agent builds a multi-file site with a base64 PNG in a live dynamic Preview", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await previewScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("settings, Spotlight, manual, and Tool Monitor share persisted OS state", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await m5Scenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("Spotlight pointer movement overrides keyboard selection from isolated state", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await spotlightHoverPrecedenceScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("reload restores per-tab windows, geometry, focus, paths, and terminal cwd", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await sessionRestoreScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("three reloads keep exactly two restored windows with stable unique PIDs", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await repeatedSessionRestoreScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("restore clamps a large-viewport window into a smaller viewport", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await smallerViewportRestoreScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("app_open places an agent window at its requested rectangle", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await agentPlacementScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("app_open focus false keeps the focused window above the new window", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await unfocusedStackingScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("empty fs_write and shell redirects truncate files on real OPFS", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await emptyOpfsWriteScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("Editor autosave is coherent with an immediate terminal cat", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await autosaveCatScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("desktop file icon opens its file in Editor", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await desktopIconScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("sticky notes and Settings Activity share visible OS state", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await stickyActivityScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("a restored sticky note un-sticks when its file is missing", async () => {
    const orphanedStickySession = {
      version: 1,
      processes: [],
      minimizedPids: [],
      nextPid: 2,
      nextSpawnCount: 0,
      lastSpawnOrigin: null,
      stickyNotes: [{ path: "~/notes/missing.md", x: 200, y: 120 }],
    } satisfies SessionSnapshot;
    const testPage = await openVerbOSPage({ sessionSnapshot: orphanedStickySession });
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await orphanedStickyNoteScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("shared window chrome and dock icons hold across every app and both themes", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await windowChromeThemeScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("agent-made app shares granted OS tools, live edits, and safe restore", async () => {
    const testPage = await openVerbOSPage();
    try {
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await agentMadeAppScenario(testPage.page);
    } finally {
      await closeVerbOSPage(testPage);
    }
  });

  test("human and agent share one remote browser and its inner WebMCP tools", async () => {
    const fake = startFakeBrowserRun();
    let testPage: Awaited<ReturnType<typeof openVerbOSPage>> | undefined;
    try {
      testPage = await openVerbOSPage({ browserWorkerUrl: fake.origin });
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await browserScenario(testPage.page, fake);
    } finally {
      if (testPage) await closeVerbOSPage(testPage);
      await fake.stop();
    }
  });

  test("cloud kernel persists shared shell bytes and publishes a visible public site", async () => {
    const fake = startFakeComputer();
    let testPage: Awaited<ReturnType<typeof openVerbOSPage>> | undefined;
    try {
      testPage = await openVerbOSPage({ computerWorkerUrl: fake.origin });
      await waitForWebMcpTools(testPage.page, BOOT_TOOL_NAMES);
      await cloudKernelScenario(testPage.page, fake);
    } finally {
      if (testPage) await closeVerbOSPage(testPage);
      await fake.stop();
    }
  });
}
