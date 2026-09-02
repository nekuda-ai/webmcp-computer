export type WorkerUrlResolutionOptions = {
  queryKey: string;
  storageKey: string;
  label: string;
  search?: string;
  storage?: Pick<Storage, "getItem">;
  envUrl?: string;
  defaultUrl?: string;
  production?: boolean;
};

function normalizeWorkerUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`webmcp-computer: invalid ${label} Worker URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`webmcp-computer: invalid ${label} Worker URL: ${value}`);
  }
  return parsed.origin;
}

function permittedOverride(value: string, production: boolean, label: string): string | undefined {
  const normalized = normalizeWorkerUrl(value, label);
  if (!production) return normalized;
  const hostname = new URL(normalized).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" ? normalized : undefined;
}

export function resolveWorkerUrl(options: WorkerUrlResolutionOptions): string {
  const production = options.production ?? import.meta.env.PROD;
  const search = options.search ?? (typeof location === "undefined" ? "" : location.search);
  const query = new URLSearchParams(search).get(options.queryKey);
  if (query) {
    const override = permittedOverride(query, production, options.label);
    if (override) return override;
  }

  let storage = options.storage;
  if (storage === undefined) {
    try {
      storage = typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
      storage = undefined;
    }
  }
  let stored: string | null | undefined;
  try {
    stored = storage?.getItem(options.storageKey);
  } catch {
    stored = undefined;
  }
  if (stored) {
    const override = permittedOverride(stored, production, options.label);
    if (override) return override;
  }

  if (options.envUrl) return normalizeWorkerUrl(options.envUrl, options.label);
  if (options.defaultUrl) return normalizeWorkerUrl(options.defaultUrl, options.label);
  throw new Error(
    `webmcp-computer: no ${options.label} Worker URL is configured; set VITE_${options.label.toUpperCase()}_WORKER_URL at build time or pass ?${options.queryKey}=<loopback URL>`,
  );
}
