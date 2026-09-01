export const APP_IDS = ["files", "editor", "terminal", "notes", "preview", "settings", "browser", "ui"] as const;

export type AppId = (typeof APP_IDS)[number];

export const SINGLETON_APP_IDS = ["settings", "notes", "preview", "browser"] as const satisfies readonly AppId[];

export function isSingletonApp(appId: AppId): boolean {
  return SINGLETON_APP_IDS.includes(appId as (typeof SINGLETON_APP_IDS)[number]);
}

export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StickyNoteRecord = {
  path: string;
  x: number;
  y: number;
};

export type ProcessRecord = {
  pid: number;
  appId: AppId;
  path?: string;
  cwd?: string;
  windowRect: WindowRect;
  zIndex: number;
  focused: boolean;
};

export type CommandProcessRecord = {
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  signal: AbortSignal;
};

export type EventSource = "agent" | "app" | "human" | "system";

export type OSEvent = {
  source: EventSource;
  verb: string;
  args: Readonly<Record<string, unknown>>;
  ts: number;
  ok?: boolean;
  reason?: string;
};

export type ToolRegistrationState = "registered" | "unsupported" | "aborted" | "failed";

export type ToolRegistrationStatus = {
  name: string;
  state: ToolRegistrationState;
};

export type FileSystemStatus = "idle" | "mounting" | "ready" | "failed";

export type FileSystemBackend = "cloud" | "opfs" | "memory";

export const THEMES = ["light", "dark"] as const;
export const ACCENT_COLORS = ["#2e9ff3", "#4f7cf7", "#00b8a9", "#ff7a59"] as const;

export type VerbOSSettings = {
  theme: (typeof THEMES)[number];
  accent: (typeof ACCENT_COLORS)[number];
  crt: boolean;
  verb_hints: boolean;
  hostname: string;
  screensaver_minutes: number;
  cloud_kernel: boolean;
};

export const DEFAULT_SETTINGS: VerbOSSettings = {
  theme: "light",
  accent: "#2e9ff3",
  crt: true,
  verb_hints: true,
  hostname: "guest@verbos",
  screensaver_minutes: 0,
  cloud_kernel: false,
};

export type ToolRegistryGroup = {
  id: string;
  owner: string;
  pid?: number;
  tools: string[];
  registeredAt: number;
};
