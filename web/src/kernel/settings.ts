import {
  FileSystemError,
  exists,
  mkdir,
  readFile,
  writeFile,
} from "./fs";
import { useKernelStore } from "./store";
import {
  ACCENT_COLORS,
  DEFAULT_SETTINGS,
  THEMES,
  type WebMCPComputerSettings,
} from "./types";
import {
  CLOUD_KERNEL_STORAGE_KEY,
  ensureWorkspaceId,
  setCloudKernelPreference,
} from "./cloudFs";
import {
  assertMachineMutationAdmission,
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "./ownershipAdmission";

export const SETTINGS_PATH = "~/.config/settings.json";
export const SETTING_KEYS = [
  "theme",
  "accent",
  "crt",
  "verb_hints",
  "hostname",
  "screensaver_minutes",
  "cloud_kernel",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

let writeQueue: Promise<void> = Promise.resolve();

type ParsedSettings = {
  repairs: string[];
  settings: WebMCPComputerSettings;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateHostname(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,31}@[a-z0-9][a-z0-9._-]{0,31}$/i.test(value)
  ) {
    throw new Error("webmcp-computer: hostname must look like user@host using 1-32 characters per side");
  }
  return value;
}

export function validateSetting(key: unknown, value: unknown): [SettingKey, WebMCPComputerSettings[SettingKey]] {
  if (typeof key !== "string" || !SETTING_KEYS.includes(key as SettingKey)) {
    throw new Error(`webmcp-computer: unknown setting '${String(key)}'; expected ${SETTING_KEYS.join(", ")}`);
  }
  const settingKey = key as SettingKey;
  switch (settingKey) {
    case "theme":
      if (typeof value !== "string" || !THEMES.includes(value as WebMCPComputerSettings["theme"])) {
        throw new Error(`webmcp-computer: theme must be one of ${THEMES.join(", ")}`);
      }
      return [settingKey, value as WebMCPComputerSettings["theme"]];
    case "accent":
      if (typeof value !== "string" || !ACCENT_COLORS.includes(value as WebMCPComputerSettings["accent"])) {
        throw new Error(`webmcp-computer: accent must be one of ${ACCENT_COLORS.join(", ")}`);
      }
      return [settingKey, value as WebMCPComputerSettings["accent"]];
    case "crt":
      if (typeof value !== "boolean") throw new Error("webmcp-computer: crt must be a boolean");
      return [settingKey, value];
    case "verb_hints":
      if (typeof value !== "boolean") throw new Error("webmcp-computer: verb_hints must be a boolean");
      return [settingKey, value];
    case "hostname":
      return [settingKey, validateHostname(value)];
    case "screensaver_minutes":
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 120) {
        throw new Error("webmcp-computer: screensaver_minutes must be an integer from 0 to 120");
      }
      return [settingKey, value as number];
    case "cloud_kernel":
      if (typeof value !== "boolean") throw new Error("webmcp-computer: cloud_kernel must be a boolean");
      return [settingKey, value];
  }
}

export function parseSettings(value: unknown): ParsedSettings {
  const settings = { ...DEFAULT_SETTINGS };
  const repairs: string[] = [];
  if (!isRecord(value)) {
    return { settings, repairs: ["replaced non-object settings with defaults"] };
  }
  for (const key of Object.keys(value)) {
    if (!SETTING_KEYS.includes(key as SettingKey)) repairs.push(`dropped unknown key '${key}'`);
  }
  for (const key of SETTING_KEYS) {
    if (!(key in value)) continue;
    try {
      const [, validated] = validateSetting(key, value[key]);
      Object.assign(settings, { [key]: validated });
    } catch (error) {
      repairs.push(
        `reset ${key}: ${error instanceof Error ? error.message.replace(/^webmcp-computer:\s*/, "") : String(error)}`,
      );
    }
  }
  return { settings, repairs };
}

function serialized(settings: WebMCPComputerSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): SettingsStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function storedCloudPreference(storage: SettingsStorage | null | undefined): string | undefined {
  try {
    return storage?.getItem(CLOUD_KERNEL_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

async function ensureSettingsFile(
  storage: SettingsStorage | null | undefined = browserStorage(),
): Promise<WebMCPComputerSettings> {
  let repairs: string[] = [];
  let settings: WebMCPComputerSettings | undefined;
  try {
    const content = await readFile(SETTINGS_PATH);
    try {
      const parsed = parseSettings(JSON.parse(content) as unknown);
      settings = parsed.settings;
      repairs = parsed.repairs;
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS };
      repairs = [
        `replaced unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  } catch (error) {
    if (!(error instanceof FileSystemError) || error.code !== "ENOENT") throw error;
  }
  settings ??= { ...DEFAULT_SETTINGS };
  const mirroredCloud = storedCloudPreference(storage);
  if (mirroredCloud === "true" || mirroredCloud === "false") {
    const enabled = mirroredCloud === "true";
    if (settings.cloud_kernel !== enabled) {
      settings = { ...settings, cloud_kernel: enabled };
      repairs.push("synced cloud_kernel from boot mirror");
    }
  } else if (settings.cloud_kernel) {
    settings = { ...settings, cloud_kernel: false };
    repairs.push("reset cloud_kernel because boot mirror is unavailable");
  }
  if (!await exists("~/.config")) await mkdir("~/.config", "system");
  if (repairs.length > 0 || !await exists(SETTINGS_PATH)) {
    await writeFile(SETTINGS_PATH, serialized(settings), "system");
  }
  if (repairs.length > 0) {
    const detail = repairs.join("; ");
    console.warn(`WebMCP Computer repaired settings: ${detail}`);
    useKernelStore.getState().osEvent("system", "settings_repaired", { repairs: [...repairs] });
  }
  return settings;
}

function enqueueSettings<T>(operation: () => Promise<T>): Promise<T> {
  const queued = writeQueue.then(operation);
  writeQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

export async function loadSettings(
  storage: SettingsStorage | null | undefined = browserStorage(),
): Promise<WebMCPComputerSettings> {
  return await enqueueSettings(async () => {
    const settings = await ensureSettingsFile(storage);
    useKernelStore.getState().setSettings(settings);
    return { ...settings };
  });
}

export async function setSetting(
  key: unknown,
  value: unknown,
  source: "agent" | "human" | MachineMutationAdmission,
  storage: SettingsStorage | null | undefined = browserStorage(),
): Promise<WebMCPComputerSettings & { note?: string }> {
  const admission = typeof source === "string"
    ? captureMachineMutationAdmission(source)
    : source;
  const [settingKey, validated] = validateSetting(key, value);
  return await enqueueSettings(async () => {
    const current = await ensureSettingsFile(storage);
    assertMachineMutationAdmission(admission);
    const next = { ...current, [settingKey]: validated } as WebMCPComputerSettings;
    if (settingKey === "cloud_kernel") {
      if (!storage) {
        throw new Error("webmcp-computer: cloud_kernel boot mirror is unavailable");
      }
      try {
        if (validated) ensureWorkspaceId(storage);
        setCloudKernelPreference(validated as boolean, storage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`webmcp-computer: could not persist cloud_kernel boot mirror: ${detail}`);
      }
    }
    await writeFile(SETTINGS_PATH, serialized(next), admission);
    assertMachineMutationAdmission(admission);
    useKernelStore.getState().setSettings(next);
    return settingKey === "cloud_kernel"
      ? {
          ...next,
          note: "reboot required — the machine restarts to remount its filesystem",
        }
      : { ...next };
  });
}

export function resetSettingsQueue(): void {
  writeQueue = Promise.resolve();
}
