import type { ToolRegistryGroup } from "../../kernel/types";

export const TOOL_GROUP_FRESH_MS = 5_000;

type ScheduleTimeout = (callback: () => void, delay: number) => () => void;

const scheduleTimeout: ScheduleTimeout = (callback, delay) => {
  const timer = window.setTimeout(callback, delay);
  return () => window.clearTimeout(timer);
};

export function scheduleFreshToolGroupExpirations(
  groups: readonly ToolRegistryGroup[],
  now: number,
  onExpire: (group: ToolRegistryGroup) => void,
  schedule: ScheduleTimeout = scheduleTimeout,
): () => void {
  const cancellations = groups.flatMap((group) => {
    const remaining = TOOL_GROUP_FRESH_MS - (now - group.registeredAt);
    if (group.owner === "system" || remaining <= 0) return [];
    return [schedule(() => onExpire(group), remaining)];
  });

  return () => {
    for (const cancel of cancellations) cancel();
  };
}
