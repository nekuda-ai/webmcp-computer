import { beforeEach, describe, expect, test } from "bun:test";
import { initializeMemoryFileSystem, readFile, writeFile } from "./fs";
import {
  loadSettings,
  resetSettingsQueue,
  SETTINGS_PATH,
  setSetting,
} from "./settings";
import { resetKernelStore, useKernelStore } from "./store";
import { DEFAULT_SETTINGS } from "./types";
import { CLOUD_KERNEL_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from "./cloudFs";

describe("M5 persisted settings", () => {
  beforeEach(async () => {
    resetKernelStore();
    resetSettingsQueue();
    await initializeMemoryFileSystem();
  });

  test("creates defaults in the shared filesystem and reloads changed values", async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(await readFile(SETTINGS_PATH))).toEqual(DEFAULT_SETTINGS);

    await setSetting("theme", "dark", "human");
    await setSetting("hostname", "builder@aurora", "human");
    expect(useKernelStore.getState().settings).toEqual(
      expect.objectContaining({ theme: "dark", hostname: "builder@aurora" }),
    );

    useKernelStore.setState({ settings: { ...DEFAULT_SETTINGS }, settingsLoaded: false });
    expect(await loadSettings()).toEqual(
      expect.objectContaining({ theme: "dark", hostname: "builder@aurora" }),
    );
  });

  test("rejects invalid keys and key-specific values without changing disk", async () => {
    await loadSettings();
    const before = await readFile(SETTINGS_PATH);
    await expect(setSetting("theme", "sepia", "human")).rejects.toThrow(
      "verbos: theme must be one of light, dark",
    );
    await expect(setSetting("hostname", "no spaces allowed", "human")).rejects.toThrow(
      "verbos: hostname must look like user@host",
    );
    await expect(setSetting("missing", true, "human")).rejects.toThrow("verbos: unknown setting 'missing'");
    expect(await readFile(SETTINGS_PATH)).toBe(before);
  });

  test("defaults verb hints on and validates and persists their toggle", async () => {
    expect(DEFAULT_SETTINGS.verb_hints).toBe(true);
    await loadSettings();
    const before = await readFile(SETTINGS_PATH);

    await expect(setSetting("verb_hints", "off", "human")).rejects.toThrow(
      "verbos: verb_hints must be a boolean",
    );
    expect(await readFile(SETTINGS_PATH)).toBe(before);

    expect(await setSetting("verb_hints", false, "human")).toEqual(
      expect.objectContaining({ verb_hints: false }),
    );
    useKernelStore.setState({ settings: { ...DEFAULT_SETTINGS }, settingsLoaded: false });
    expect(await loadSettings()).toEqual(expect.objectContaining({ verb_hints: false }));
  });

  test("repairs corrupt JSON and invalid keys without wedging reads", async () => {
    await loadSettings();
    await writeFile(
      SETTINGS_PATH,
      '{"theme":"dark","accent":"broken","hostname":"builder@aurora"} trailing',
      "system",
    );

    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(await readFile(SETTINGS_PATH))).toEqual(DEFAULT_SETTINGS);

    await writeFile(
      SETTINGS_PATH,
      JSON.stringify({ theme: "dark", accent: "broken", hostname: "builder@aurora", extra: true }),
      "system",
    );
    expect(await loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      hostname: "builder@aurora",
    });
    expect(useKernelStore.getState().events.at(-1)).toEqual(
      expect.objectContaining({ source: "system", verb: "settings_repaired" }),
    );
  });

  test("settings_set overwrites a corrupt file and serializes interleaved writes", async () => {
    await loadSettings();
    await writeFile(SETTINGS_PATH, "{broken", "system");

    const [dark, renamed] = await Promise.all([
      setSetting("theme", "dark", "agent"),
      setSetting("hostname", "builder@aurora", "human"),
    ]);

    expect(dark.theme).toBe("dark");
    expect(renamed).toEqual(expect.objectContaining({ theme: "dark", hostname: "builder@aurora" }));
    expect(JSON.parse(await readFile(SETTINGS_PATH))).toEqual(renamed);
    expect(
      useKernelStore.getState().events.filter(({ verb }) => verb === "fs_change").at(-1)?.args.source,
    ).toBe("human");
  });

  test("validates cloud_kernel, mirrors it for boot, mints a workspace, and returns reboot note", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    };
    await loadSettings(storage);
    const before = await readFile(SETTINGS_PATH);
    await expect(setSetting("cloud_kernel", "yes", "agent", storage)).rejects.toThrow(
      "verbos: cloud_kernel must be a boolean",
    );
    expect(await readFile(SETTINGS_PATH)).toBe(before);

    const enabled = await setSetting("cloud_kernel", true, "agent", storage);
    expect(enabled).toEqual(expect.objectContaining({
      cloud_kernel: true,
      note: "reboot required — the machine restarts to remount its filesystem",
    }));
    expect(values.get(CLOUD_KERNEL_STORAGE_KEY)).toBe("true");
    expect(values.get(WORKSPACE_STORAGE_KEY)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(await readFile(SETTINGS_PATH))).toEqual(expect.objectContaining({
      cloud_kernel: true,
    }));
  });

  test("keeps settings file local when cloud mirror persistence fails", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) {
        if (key === CLOUD_KERNEL_STORAGE_KEY) throw new DOMException("blocked", "SecurityError");
        values.set(key, value);
      },
    };
    await loadSettings(storage);
    const before = await readFile(SETTINGS_PATH);
    await expect(setSetting("cloud_kernel", true, "agent", storage)).rejects.toThrow(
      "verbos: could not persist cloud_kernel boot mirror: blocked",
    );
    expect(await readFile(SETTINGS_PATH)).toBe(before);
    expect(useKernelStore.getState().settings.cloud_kernel).toBe(false);

    await expect(setSetting("cloud_kernel", true, "agent", null)).rejects.toThrow(
      "verbos: cloud_kernel boot mirror is unavailable",
    );
    expect(await readFile(SETTINGS_PATH)).toBe(before);
  });

  test("repairs cloud_kernel true when boot mirror is absent or unreadable", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    };
    await loadSettings(storage);
    await writeFile(SETTINGS_PATH, `${JSON.stringify({ ...DEFAULT_SETTINGS, cloud_kernel: true })}\n`, "system");
    expect((await loadSettings(storage)).cloud_kernel).toBe(false);
    expect(JSON.parse(await readFile(SETTINGS_PATH))).toEqual(expect.objectContaining({
      cloud_kernel: false,
    }));

    await writeFile(SETTINGS_PATH, `${JSON.stringify({ ...DEFAULT_SETTINGS, cloud_kernel: true })}\n`, "system");
    const throwingStorage = {
      getItem(): string | null { throw new DOMException("blocked", "SecurityError"); },
      setItem(): void { throw new DOMException("blocked", "SecurityError"); },
    };
    expect((await loadSettings(throwingStorage)).cloud_kernel).toBe(false);
  });
});
