import { readFile } from "./fs";

export const MANUAL_TOPICS = ["filesystem", "terminal", "windows", "apps", "preview", "browser", "cloud", "conventions"] as const;
export type ManualTopic = (typeof MANUAL_TOPICS)[number];

export function requireManualTopic(value: unknown): ManualTopic {
  if (typeof value !== "string" || !MANUAL_TOPICS.includes(value as ManualTopic)) {
    throw new Error(
      `webmcp-computer: no manual topic '${String(value)}'; expected ${MANUAL_TOPICS.join(", ")}`,
    );
  }
  return value as ManualTopic;
}

export async function readManual(topic?: ManualTopic): Promise<string> {
  return await readFile(topic === undefined ? "~/skills/README.md" : `~/skills/${topic}.md`);
}
