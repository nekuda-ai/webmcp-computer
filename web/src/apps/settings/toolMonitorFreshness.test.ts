import { describe, expect, test } from "bun:test";
import type { ToolRegistryGroup } from "../../kernel/types";
import {
  scheduleFreshToolGroupExpirations,
  TOOL_GROUP_FRESH_MS,
} from "./toolMonitorFreshness";

describe("ToolMonitor freshness", () => {
  test("schedules one timeout per fresh non-system group and clears each timeout", () => {
    const now = 10_000;
    const groups: ToolRegistryGroup[] = [
      { id: "system", owner: "system", tools: ["app_list"], registeredAt: now },
      { id: "editor", owner: "editor", tools: ["editor_open_file"], registeredAt: 9_000 },
      { id: "notes", owner: "notes", tools: ["notes_append"], registeredAt: 7_000 },
      { id: "stale", owner: "preview", tools: ["preview_reload"], registeredAt: 5_000 },
    ];
    const scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const expired: string[] = [];

    const cleanup = scheduleFreshToolGroupExpirations(
      groups,
      now,
      (group) => expired.push(group.id),
      (callback, delay) => {
        const timeout = { callback, delay, cleared: false };
        scheduled.push(timeout);
        return () => {
          timeout.cleared = true;
        };
      },
    );

    expect(scheduled.map(({ delay }) => delay)).toEqual([
      TOOL_GROUP_FRESH_MS - 1_000,
      TOOL_GROUP_FRESH_MS - 3_000,
    ]);
    scheduled[0]?.callback();
    scheduled[1]?.callback();
    expect(expired).toEqual(["editor", "notes"]);

    cleanup();
    expect(scheduled.every(({ cleared }) => cleared)).toBe(true);
  });
});
