var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/define.ts
var NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
var STABLE_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
var MAX_KEY_LENGTH = 1024;
var TOOL_SOURCES = ["scanner_generated", "merchant_authored"];
var TOOL_INTENTS = ["answer", "act", "transact"];
function fail(field, problem) {
  throw new TypeError(`defineTool: ${field} ${problem}`);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function defineTool(definition) {
  const { stableKey, description, inputSchema, execute } = definition;
  if (typeof stableKey !== "string" || stableKey.trim() === "") {
    fail("stableKey", "must be a non-empty string (the durable identity the platform keys on)");
  }
  if (stableKey.length > MAX_KEY_LENGTH) {
    fail("stableKey", `must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (!STABLE_KEY_PATTERN.test(stableKey)) {
    fail("stableKey", `must be dot-namespaced "domain.action" — [a-z0-9_]+ segments (2 or more) joined by "." (got ${JSON.stringify(stableKey)})`);
  }
  const nameOmitted = definition.name === undefined;
  const name = definition.name ?? stableKey;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    const field = nameOmitted ? "stableKey" : "name";
    const suffix = nameOmitted ? " when used as the wire name, or set an explicit `name`" : "";
    fail(field, `must be 1-128 chars of [A-Za-z0-9_\\-.]${suffix} (got ${JSON.stringify(name)})`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    fail("description", "must be a non-empty string");
  }
  if (inputSchema !== undefined && !isPlainObject(inputSchema)) {
    fail("inputSchema", "must be a plain JSON Schema object when present");
  }
  if (definition.version !== undefined && (typeof definition.version !== "string" || definition.version.trim() === "")) {
    fail("version", "must be a non-empty string when present");
  }
  if (typeof definition.version === "string" && definition.version.length > MAX_KEY_LENGTH) {
    fail("version", `must be at most ${MAX_KEY_LENGTH} characters`);
  }
  for (const [field, allowed] of [
    ["source", TOOL_SOURCES],
    ["intent", TOOL_INTENTS]
  ]) {
    const value = definition[field];
    if (value !== undefined && !allowed.includes(value)) {
      fail(field, `must be one of ${allowed.join(" | ")} when present (got ${JSON.stringify(value)})`);
    }
  }
  if (typeof execute !== "function") {
    fail("execute", "must be a function");
  }
  return Object.freeze({ ...definition, name });
}
// src/spec.ts
function resolveModelContext(g = globalThis) {
  const scope = g;
  return scope.document?.modelContext ?? scope.navigator?.modelContext;
}

// src/transport.ts
var INGEST_BASE = typeof __WEBMCP_INGEST_BASE__ === "string" ? __WEBMCP_INGEST_BASE__ : "https://ingest.agentlane.com";
var DEFAULT_COLLECT_ENDPOINT = `${INGEST_BASE}/v1/collect`;
var DEFAULT_TELEMETRY_ENDPOINT = `${INGEST_BASE}/v1/telemetry`;
function tryFetch(scope, url, headers, json) {
  const f = scope.fetch;
  if (typeof f !== "function")
    return;
  try {
    const result = f(url, {
      method: "POST",
      keepalive: true,
      headers,
      body: json
    });
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {}
}
function sendToCollect(event, config, scope = globalThis) {
  try {
    const json = JSON.stringify(event);
    if (json === undefined)
      return;
    const url = config.endpoint || DEFAULT_COLLECT_ENDPOINT;
    const headers = { "content-type": "application/json", "x-api-key": config.apiKey };
    tryFetch(scope, url, headers, json);
  } catch {}
}
function sendTelemetry(event, scope = globalThis, endpoint, apiKey) {
  try {
    const json = JSON.stringify(event);
    if (json === undefined)
      return;
    const url = endpoint || DEFAULT_TELEMETRY_ENDPOINT;
    const headers = { "content-type": "application/json" };
    if (typeof apiKey === "string" && apiKey.trim().length > 0)
      headers["x-api-key"] = apiKey;
    tryFetch(scope, url, headers, json);
  } catch {}
}
var OTEL_LOGGER_NAME = "@nekuda/webmcp-sdk";
var OTEL_SEVERITY_INFO = 9;
async function defaultLoader() {
  try {
    const mod = await import("@opentelemetry/api-logs");
    return mod.logs ?? null;
  } catch {
    return null;
  }
}
var loaderCache = new WeakMap;
function loadCached(loadLogs) {
  let cached = loaderCache.get(loadLogs);
  if (cached === undefined) {
    cached = Promise.resolve().then(() => loadLogs()).then((api) => api ?? null).catch(() => null);
    loaderCache.set(loadLogs, cached);
  }
  return cached;
}
function emitOtelLog(event, loadLogs = defaultLoader) {
  return loadCached(loadLogs).then((api) => {
    if (!api)
      return;
    try {
      api.getLogger(OTEL_LOGGER_NAME).emit({
        severityNumber: OTEL_SEVERITY_INFO,
        body: event,
        attributes: {
          "event.name": event.eventName,
          "tool.stable_key": event.toolStableKey,
          "call.id": event.callId
        }
      });
    } catch {}
  }).catch(() => {});
}

// src/tracking.ts
var SESSION_TIMEOUT_MS = 30 * 60 * 1000;
var ANON_NAMESPACE = "anon";
function fnv1a(input) {
  let hash = 2166136261;
  for (let i = 0;i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function storageNamespace(apiKey) {
  if (!apiKey)
    return ANON_NAMESPACE;
  return fnv1a(apiKey);
}
var visitorKey = (ns) => `webmcp:${ns}:visitor_id`;
var sessionKey = (ns) => `webmcp:${ns}:session_id`;
var lastSeenKey = (ns) => `webmcp:${ns}:last_seen`;
var memoryVisitor = new Map;
var memorySession = new Map;
var MAX_ID_LENGTH = 64;
function usableId(value) {
  return value !== null && value.length > 0 && value.length <= MAX_ID_LENGTH;
}
function storage(kind) {
  try {
    return globalThis[kind] ?? null;
  } catch {
    return null;
  }
}
function readItem(store, key) {
  if (!store)
    return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function writeItem(store, key, value) {
  if (!store)
    return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function fallbackId(cache, namespace, candidate) {
  const cached = cache.get(namespace);
  if (cached)
    return cached;
  cache.set(namespace, candidate);
  return candidate;
}
var idSequence = 0;
function fillPseudoRandom(bytes) {
  if (fillFromMathRandom(bytes))
    return;
  const seq = ++idSequence;
  for (let i = 0;i < bytes.length; i++)
    bytes[i] = seq >>> i % 4 * 8;
}
function fillFromMathRandom(bytes) {
  try {
    for (let i = 0;i < bytes.length; i++) {
      const draw = Math.random();
      if (typeof draw !== "number" || !(draw >= 0 && draw < 1))
        return false;
      bytes[i] = Math.floor(draw * 256);
    }
    return true;
  } catch {
    return false;
  }
}
function randomId() {
  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === "function") {
      const uuid = c.randomUUID();
      if (typeof uuid === "string" && usableId(uuid))
        return uuid;
    }
    if (typeof c?.getRandomValues === "function") {
      c.getRandomValues(bytes);
      filled = true;
    }
  } catch {}
  if (!filled)
    fillPseudoRandom(bytes);
  const hex = Array.from(bytes, (byte, i) => {
    const v = i === 6 ? byte & 15 | 64 : i === 8 ? byte & 63 | 128 : byte;
    return v.toString(16).padStart(2, "0");
  }).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function getOrCreateVisitorId(namespace) {
  const store = storage("localStorage");
  const key = visitorKey(namespace);
  const existing = readItem(store, key);
  if (usableId(existing))
    return existing;
  const id = randomId();
  if (writeItem(store, key, id))
    return id;
  return fallbackId(memoryVisitor, namespace, id);
}
function nowMs() {
  try {
    const now = Date.now();
    return typeof now === "number" && Number.isFinite(now) ? now : undefined;
  } catch {
    return;
  }
}
function getOrCreateSessionId(namespace) {
  const store = storage("sessionStorage");
  const now = nowMs();
  const existing = readItem(store, sessionKey(namespace));
  const lastSeen = Number(readItem(store, lastSeenKey(namespace)));
  const elapsed = now === undefined ? Number.NaN : now - lastSeen;
  const active = usableId(existing) && Number.isFinite(lastSeen) && elapsed >= 0 && elapsed < SESSION_TIMEOUT_MS;
  const id = active ? existing : randomId();
  const persisted = writeItem(store, sessionKey(namespace), id) && (now === undefined || writeItem(store, lastSeenKey(namespace), String(now)));
  if (persisted)
    return id;
  return fallbackId(memorySession, namespace, id);
}
function trackingOutputs(options) {
  try {
    if (!options || options.disabled)
      return { toBackend: false, toOtel: false };
    return {
      toBackend: typeof options.apiKey === "string" && options.apiKey.trim().length > 0,
      toOtel: options.otel === true
    };
  } catch {
    return { toBackend: false, toOtel: false };
  }
}
function pageFields() {
  const fields = {};
  try {
    const loc = globalThis.location;
    if (loc) {
      if (loc.origin)
        fields.siteOrigin = loc.origin;
      if (loc.href)
        fields.url = loc.href;
      if (loc.pathname)
        fields.path = loc.pathname;
    }
    const doc = globalThis.document;
    if (doc) {
      if (doc.referrer !== undefined)
        fields.referrer = doc.referrer;
      if (doc.title !== undefined)
        fields.title = doc.title;
    }
  } catch {}
  return fields;
}
function errorMessage(error) {
  try {
    const read = error instanceof Error ? error.message : String(error);
    return typeof read === "string" ? read : "";
  } catch {
    return "";
  }
}
function buildEventPayload(params) {
  return {
    eventId: randomId(),
    visitorId: params.visitorId,
    sessionId: params.sessionId,
    eventName: params.eventName,
    ts: new Date().toISOString(),
    ...pageFields(),
    ...params.data
  };
}
var MAX_EVENT_BYTES = 64 * 1024;
var MAX_ERROR_BYTES = 16 * 1024;
var TRUNCATABLE = ["response", "input", "error"];
var PAGE_STRINGS = ["url", "referrer", "title", "path", "siteOrigin"];
var MAX_PAGE_FIELD_BYTES = 4 * 1024;
var TOOL_ENTRY_KEPT = ["stableKey", "name", "outcome", "schemaHash", "source", "intent"];
function isMarker(value) {
  return typeof value === "object" && value !== null && value.__truncated === true;
}
function byteLength(json) {
  try {
    const TE = globalThis.TextEncoder;
    if (typeof TE === "function")
      return new TE().encode(json).length;
  } catch {}
  return json.length;
}
function escapedByteLength(value) {
  return byteLength(JSON.stringify(value)) - 2;
}
function sliceToBytes(value, maxBytes) {
  if (escapedByteLength(value) <= maxBytes)
    return value;
  const g = globalThis;
  try {
    if (typeof g.TextEncoder === "function" && typeof g.TextDecoder === "function") {
      const bytes = new g.TextEncoder().encode(value);
      const decoder = new g.TextDecoder("utf-8");
      const decode = (end) => {
        const s = decoder.decode(bytes.subarray(0, end));
        return s.endsWith("�") ? s.slice(0, -1) : s;
      };
      let lo = 0;
      let hi = Math.min(bytes.length, maxBytes);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (escapedByteLength(decode(mid)) <= maxBytes)
          lo = mid;
        else
          hi = mid - 1;
      }
      return decode(lo);
    }
  } catch {}
  return value.slice(0, Math.floor(maxBytes / 6));
}
function serializedBytes(value) {
  return fieldBytes(value) ?? undefined;
}
function fieldBytes(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  return json === undefined ? 0 : byteLength(json);
}
function underLimit(event) {
  const size = fieldBytes(event);
  return size !== null && size < MAX_EVENT_BYTES;
}
function stripToolEntry(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return entry;
  const kept = {};
  for (const key of TOOL_ENTRY_KEPT) {
    const value = entry[key];
    if (value !== undefined)
      kept[key] = value;
  }
  return kept;
}
function boundTools(bounded) {
  const tools = bounded.tools;
  if (!Array.isArray(tools))
    return;
  bounded.tools = tools.map(stripToolEntry);
  if (underLimit(bounded))
    return;
  bounded.tools = {
    __truncated: true,
    originalBytes: fieldBytes(tools) ?? 0,
    toolCount: tools.length
  };
}
function boundEventPayload(event) {
  try {
    if (underLimit(event))
      return event;
    return bound(event);
  } catch {
    return event;
  }
}
function bound(event) {
  const bounded = { ...event };
  for (const field of TRUNCATABLE) {
    if (field in bounded && fieldBytes(bounded[field]) === null) {
      bounded[field] = { __truncated: true, originalBytes: 0 };
    }
  }
  for (const field of ["response", "input"]) {
    if (underLimit(bounded))
      return bounded;
    if (field in bounded && !isMarker(bounded[field])) {
      bounded[field] = { __truncated: true, originalBytes: fieldBytes(bounded[field]) ?? 0 };
    }
  }
  if (underLimit(bounded))
    return bounded;
  if ("error" in bounded && !isMarker(bounded.error)) {
    const err = bounded.error;
    bounded.error = typeof err === "string" ? sliceToBytes(err, MAX_ERROR_BYTES) : { __truncated: true, originalBytes: fieldBytes(err) ?? 0 };
  }
  if (!underLimit(bounded))
    boundTools(bounded);
  for (const field of PAGE_STRINGS) {
    if (underLimit(bounded))
      return bounded;
    const value = bounded[field];
    if (typeof value === "string")
      bounded[field] = sliceToBytes(value, MAX_PAGE_FIELD_BYTES);
  }
  return bounded;
}
var defaultSinks = { sendToCollect, emitOtelLog };
function track(options, eventName, data, sinks = defaultSinks) {
  try {
    const { toBackend, toOtel } = trackingOutputs(options);
    if (!toBackend && !toOtel)
      return;
    const namespace = storageNamespace(options.apiKey);
    const event = boundEventPayload(buildEventPayload({
      visitorId: getOrCreateVisitorId(namespace),
      sessionId: getOrCreateSessionId(namespace),
      eventName,
      data
    }));
    if (toBackend) {
      sinks.sendToCollect(event, {
        apiKey: options.apiKey,
        ...options.endpoint !== undefined ? { endpoint: options.endpoint } : {}
      });
    }
    if (toOtel)
      sinks.emitOtelLog(event);
  } catch {}
}

// src/telemetry-context.ts
function guarded(read) {
  try {
    return read();
  } catch {
    return;
  }
}
var MAX_ROUTE_SEGMENTS = 8;
var MAX_ROUTE_BYTES = 256;
var MAX_INPUT_CHARS = 4096;
var OVERFLOW_SEGMENT = "*";
var DIGITS_SEGMENT = /^\d+$/;
var UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var HEX_SEGMENT = /^[0-9a-f]{12,}$/i;
var SLUG_SEGMENT = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/;
var MAX_SLUG_CHARS = 32;
var OPAQUE_SEGMENT = ":token";
var MAX_UPPERCASE_SHARE = 0.3;
function uppercaseHeavy(run) {
  let uppercase = 0;
  for (let i = 0;i < run.length; i += 1) {
    const code = run.charCodeAt(i);
    if (code >= 65 && code <= 90)
      uppercase += 1;
  }
  return uppercase > run.length * MAX_UPPERCASE_SHARE;
}
var MIN_OPAQUE_SLUG_CHARS = 12;
function pathSegments(pathname) {
  const capped = pathname.length > MAX_INPUT_CHARS ? pathname.slice(0, MAX_INPUT_CHARS) : pathname;
  const cut = capped.search(/[?#]/);
  return (cut === -1 ? capped : capped.slice(0, cut)).split("/").filter((s) => s.length > 0);
}
function templateSegment(segment) {
  if (DIGITS_SEGMENT.test(segment))
    return ":id";
  if (UUID_SEGMENT.test(segment))
    return ":uuid";
  if (HEX_SEGMENT.test(segment))
    return ":hash";
  if (segment.length > MAX_SLUG_CHARS || !SLUG_SEGMENT.test(segment))
    return OPAQUE_SEGMENT;
  if (segment.length >= MIN_OPAQUE_SLUG_CHARS && uppercaseHeavy(segment))
    return OPAQUE_SEGMENT;
  return segment;
}
function routeTemplate(pathname) {
  if (typeof pathname !== "string")
    return;
  const segments = pathSegments(pathname);
  const kept = segments.slice(0, MAX_ROUTE_SEGMENTS).map(templateSegment);
  if (segments.length > MAX_ROUTE_SEGMENTS)
    kept.push(OVERFLOW_SEGMENT);
  return sliceToBytes(`/${kept.join("/")}`, MAX_ROUTE_BYTES);
}
function segmentCount(pathname) {
  if (typeof pathname !== "string")
    return;
  return pathSegments(pathname).length;
}
var AI_ASSISTANT_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "openai.com",
  "claude.ai",
  "anthropic.com",
  "perplexity.ai",
  "gemini.google.com",
  "bard.google.com",
  "aistudio.google.com",
  "copilot.microsoft.com",
  "grok.com",
  "x.ai",
  "deepseek.com",
  "meta.ai",
  "poe.com",
  "you.com"
];
var SEARCH_HOSTS = [
  "bing.com",
  "duckduckgo.com",
  "baidu.com",
  "ecosia.org",
  "search.brave.com",
  "startpage.com",
  "qwant.com",
  "naver.com"
];
var SEARCH_PATTERNS = [
  /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2,3})?$/,
  /(^|\.)yahoo\.[a-z]{2,3}(\.[a-z]{2,3})?$/,
  /(^|\.)yandex\.[a-z]{2,3}(\.[a-z]{2,3})?$/
];
var SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "t.co",
  "linkedin.com",
  "reddit.com",
  "pinterest.com",
  "tiktok.com",
  "youtube.com",
  "threads.net",
  "snapchat.com",
  "tumblr.com",
  "discord.com",
  "t.me",
  "whatsapp.com"
];
function hostMatches(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
function parsedUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INPUT_CHARS) {
    return;
  }
  return guarded(() => new URL(value));
}
function originOf(value) {
  return parsedUrl(value)?.origin.toLowerCase();
}
function referrerClass(referrer, origin) {
  if (typeof referrer !== "string" || referrer.trim().length === 0)
    return "direct";
  const url = parsedUrl(referrer);
  if (url === undefined)
    return "other";
  const referrerOrigin = url.origin.toLowerCase();
  const own = originOf(origin) ?? (typeof origin === "string" ? origin.trim().toLowerCase() : "");
  if (own.length > 0 && referrerOrigin === own)
    return "internal";
  const hostname = guarded(() => url.hostname.toLowerCase()) ?? "";
  if (hostMatches(hostname, AI_ASSISTANT_HOSTS))
    return "ai_assistant";
  if (hostMatches(hostname, SEARCH_HOSTS))
    return "search";
  if (SEARCH_PATTERNS.some((pattern) => pattern.test(hostname)))
    return "search";
  if (hostMatches(hostname, SOCIAL_HOSTS))
    return "social";
  return "other";
}
var MOBILE_MAX_WIDTH = 767;
function formFactor(scope = globalThis) {
  const g = scope;
  const hint = guarded(() => g.navigator?.userAgentData?.mobile);
  if (typeof hint === "boolean")
    return hint ? "mobile" : "desktop";
  const query = guarded(() => g.matchMedia);
  if (typeof query === "function") {
    const media = guarded(() => query.call(g, "(pointer: coarse) and (hover: none)"));
    const coarse = guarded(() => media?.matches);
    if (typeof coarse === "boolean")
      return coarse ? "mobile" : "desktop";
  }
  const width = guarded(() => g.screen?.width);
  if (typeof width === "number" && Number.isFinite(width)) {
    return width <= MOBILE_MAX_WIDTH ? "mobile" : "desktop";
  }
  return;
}
var PRIMARY_SUBTAG = /^[a-z]{2,3}$/;
function languageSubtag(scope = globalThis) {
  const g = scope;
  const primary = guarded(() => g.navigator?.language);
  const list = guarded(() => g.navigator?.languages);
  const raw = typeof primary === "string" ? primary : Array.isArray(list) ? list[0] : undefined;
  if (typeof raw !== "string")
    return;
  const subtag = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return PRIMARY_SUBTAG.test(subtag) ? subtag : undefined;
}
var RUNTIME_TOKENS = [
  [/chatgpt|gptbot|oai-searchbot|openai/, "chatgpt"],
  [/claude|anthropic/, "claude"],
  [/perplexity/, "perplexity"],
  [/headless|puppeteer|playwright|selenium|phantomjs/, "headless"]
];
var MAX_UA_SCAN = 1024;
function agentRuntime(scope = globalThis) {
  const g = scope;
  const ua = guarded(() => g.navigator?.userAgent);
  const tokens = typeof ua === "string" ? ua.slice(0, MAX_UA_SCAN).toLowerCase() : undefined;
  if (tokens !== undefined) {
    for (const [pattern, runtime] of RUNTIME_TOKENS) {
      if (pattern.test(tokens))
        return runtime;
    }
  }
  if (guarded(() => g.navigator?.webdriver) === true)
    return "headless";
  return tokens === undefined ? "unknown" : "browser";
}
function frameContext(scope = globalThis) {
  const g = scope;
  const self = guarded(() => g.self);
  if (self === undefined)
    return;
  let top;
  try {
    top = g.top;
  } catch {
    return "iframe";
  }
  if (top === undefined)
    return;
  return top === self ? "top" : "iframe";
}
var VISIBILITY_STATES = ["visible", "hidden", "prerender"];
function visibility(scope = globalThis) {
  const g = scope;
  const state = guarded(() => g.document?.visibilityState);
  return VISIBILITY_STATES.find((known) => known === state);
}
var PROVENANCE_MARKER = "__webmcpProvenance";
var CLAIMABLE_PROVENANCES = ["polyfill", "extension"];
var MAX_SPEC_VERSION_BYTES = 64;
function surfaceInfo(scope = globalThis) {
  const g = scope;
  const fromDocument = guarded(() => g.document?.modelContext);
  const surface = guarded(() => resolveModelContext(scope));
  if (!surface)
    return { available: false, provenance: "none" };
  const declared = surface;
  const claimed = guarded(() => declared[PROVENANCE_MARKER]);
  const version = guarded(() => declared.specVersion);
  return {
    available: true,
    provenance: CLAIMABLE_PROVENANCES.find((known) => known === claimed) ?? "native",
    global: fromDocument === surface ? "document.modelContext" : "navigator.modelContext",
    ...typeof version === "string" && version.length > 0 ? { specVersion: sliceToBytes(version, MAX_SPEC_VERSION_BYTES) } : {}
  };
}
function timeSinceNavigation(scope = globalThis) {
  const perf = guarded(() => scope.performance);
  const now = guarded(() => {
    const clock = perf?.now;
    return typeof clock === "function" ? clock.call(perf) : undefined;
  });
  if (isElapsed(now))
    return Math.round(now);
  const origin = guarded(() => perf?.timeOrigin);
  if (typeof origin !== "number" || !Number.isFinite(origin) || origin <= 0)
    return;
  const elapsed = guarded(() => Date.now() - origin);
  return isElapsed(elapsed) ? Math.round(elapsed) : undefined;
}
function isElapsed(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
var INIT_AT = timeSinceNavigation();
function initAt() {
  return INIT_AT;
}
function timeSinceInit(scope = globalThis) {
  if (INIT_AT === undefined)
    return;
  const now = timeSinceNavigation(scope);
  return now === undefined ? undefined : Math.max(0, Math.round(now - INIT_AT));
}
var SESSION_ID = randomId();
function sessionId() {
  return SESSION_ID;
}

// src/telemetry-events.ts
var TELEMETRY_SCHEMA_VERSION = 2;

// src/telemetry-fields.ts
var TELEMETRY_FIELDS = {
  schema: true,
  event: true,
  ts: true,
  sessionId: true,
  "sdk.name": true,
  "sdk.version": true,
  "sdk.installMode": true,
  "surface.available": true,
  "surface.provenance": true,
  "surface.global": true,
  "surface.specVersion": true,
  "page.routeTemplate": true,
  "page.segmentCount": true,
  "page.referrerClass": true,
  "page.frameContext": true,
  "page.visibility": true,
  "client.agentRuntime": true,
  "client.browser": true,
  "client.browserMajor": true,
  "client.formFactor": true,
  "client.language": true,
  timeToInitMs: true,
  registrationIndex: true,
  trigger: true,
  settleMs: true,
  "config.trackingEnabled": true,
  "config.otelEnabled": true,
  "config.customEndpoint": true,
  tools: true,
  callId: true,
  callIndex: true,
  toolCallIndex: true,
  precededBy: true,
  tool: true,
  outcome: true,
  durationMs: true,
  "response.bytes": true,
  "response.contentBlocks": true,
  "response.isError": true,
  errorClass: true,
  errorSignature: true,
  routeTemplate: true,
  timeSinceInitMs: true,
  agentRuntime: true
};
var TELEMETRY_TOOL_FIELDS = {
  name: true,
  stableKey: true,
  version: true,
  schemaHash: true,
  source: true,
  intent: true,
  outcome: true,
  failureSignature: true,
  descriptionLength: true,
  annotations: true,
  paramCount: true,
  requiredCount: true,
  freeTextParamCount: true,
  enumParamCount: true,
  maxDepth: true,
  describedParamCount: true
};

// src/tool-metrics.ts
var MAX_CANONICAL_DEPTH = 12;
var MAX_CANONICAL_NODES = 4096;
var MAX_CANONICAL_STRING = 1024;
var MAX_PARAMS = 512;
var MAX_SCHEMA_DEPTH = 12;
var MAX_SCHEMA_NODES = 4096;
var DEPTH_TOKEN = '"~depth"';
var CYCLE_TOKEN = '"~cycle"';
var BUDGET_TOKEN = '"~budget"';
function guarded2(read) {
  try {
    return read();
  } catch {
    return;
  }
}
function isSchemaObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function encodeString(value) {
  return JSON.stringify(value.length > MAX_CANONICAL_STRING ? value.slice(0, MAX_CANONICAL_STRING) : value);
}
function encode(value, depth, path, budget) {
  if (budget.nodes <= 0)
    return BUDGET_TOKEN;
  budget.nodes--;
  if (depth > MAX_CANONICAL_DEPTH)
    return DEPTH_TOKEN;
  switch (typeof value) {
    case "string":
      return encodeString(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return encodeString(value.toString());
    case "object":
      break;
    default:
      return "null";
  }
  if (value === null)
    return "null";
  const container = value;
  if (path.has(container))
    return CYCLE_TOKEN;
  path.add(container);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        items.push(encode(item, depth + 1, path, budget));
        if (budget.nodes <= 0)
          break;
      }
      return `[${items.join(",")}]`;
    }
    const keys = guarded2(() => Object.keys(container)) ?? [];
    keys.sort();
    const entries = [];
    for (const key of keys) {
      const child = guarded2(() => container[key]);
      if (child === undefined || typeof child === "function" || typeof child === "symbol")
        continue;
      entries.push(`${encodeString(key)}:${encode(child, depth + 1, path, budget)}`);
      if (budget.nodes <= 0)
        break;
    }
    return `{${entries.join(",")}}`;
  } finally {
    path.delete(container);
  }
}
function canonicalize(value, depth = 0) {
  return encode(value, depth, new Set, { nodes: MAX_CANONICAL_NODES });
}
function schemaHash(inputSchema) {
  if (!isSchemaObject(inputSchema))
    return;
  const canonical = guarded2(() => canonicalize(inputSchema));
  return canonical === undefined ? undefined : fnv1a(canonical);
}
var ZERO_METRICS = {
  paramCount: 0,
  requiredCount: 0,
  freeTextParamCount: 0,
  enumParamCount: 0,
  maxDepth: 0,
  describedParamCount: 0
};
function clamp(count) {
  if (!Number.isFinite(count))
    return 0;
  return Math.max(0, Math.min(Math.trunc(count), MAX_PARAMS));
}
function childSchemas(schema) {
  const children = [];
  const props = guarded2(() => schema.properties);
  if (isSchemaObject(props)) {
    for (const key of (guarded2(() => Object.keys(props)) ?? []).slice(0, MAX_PARAMS)) {
      const child = guarded2(() => props[key]);
      if (isSchemaObject(child))
        children.push(child);
    }
  }
  const items = guarded2(() => schema.items);
  if (isSchemaObject(items))
    children.push(items);
  else if (Array.isArray(items)) {
    for (const item of items.slice(0, MAX_PARAMS)) {
      if (isSchemaObject(item))
        children.push(item);
    }
  }
  return children.slice(0, MAX_PARAMS);
}
function depthOf(schema, depth, path, budget) {
  if (depth >= MAX_SCHEMA_DEPTH || budget.nodes <= 0 || path.has(schema))
    return 0;
  budget.nodes--;
  path.add(schema);
  try {
    const children = childSchemas(schema);
    if (children.length === 0)
      return 0;
    let deepest = 0;
    for (const child of children) {
      deepest = Math.max(deepest, depthOf(child, depth + 1, path, budget));
      if (budget.nodes <= 0)
        break;
    }
    return 1 + deepest;
  } finally {
    path.delete(schema);
  }
}
function collect(schema) {
  const props = guarded2(() => schema.properties);
  const allKeys = isSchemaObject(props) ? guarded2(() => Object.keys(props)) ?? [] : [];
  let freeTextParamCount = 0;
  let enumParamCount = 0;
  let describedParamCount = 0;
  for (const key of allKeys.slice(0, MAX_PARAMS)) {
    const param = guarded2(() => props[key]);
    if (!isSchemaObject(param))
      continue;
    const hasEnum = Array.isArray(guarded2(() => param.enum));
    if (hasEnum)
      enumParamCount++;
    const type = guarded2(() => param.type);
    const format = guarded2(() => param.format);
    if (type === "string" && !hasEnum && typeof format !== "string")
      freeTextParamCount++;
    const description = guarded2(() => param.description);
    if (typeof description === "string" && description.trim() !== "")
      describedParamCount++;
  }
  const required = guarded2(() => schema.required);
  const requiredCount = Array.isArray(required) ? required.slice(0, MAX_PARAMS).filter((entry) => typeof entry === "string").length : 0;
  return {
    paramCount: clamp(allKeys.length),
    requiredCount: clamp(requiredCount),
    freeTextParamCount: clamp(freeTextParamCount),
    enumParamCount: clamp(enumParamCount),
    maxDepth: depthOf(schema, 0, new Set, { nodes: MAX_SCHEMA_NODES }),
    describedParamCount: clamp(describedParamCount)
  };
}
function shapeMetrics(inputSchema) {
  if (!isSchemaObject(inputSchema))
    return;
  return guarded2(() => collect(inputSchema)) ?? { ...ZERO_METRICS };
}

// src/telemetry.ts
var SDK_NAME = "@nekuda/webmcp-sdk";
var SDK_VERSION = typeof __WEBMCP_SDK_VERSION__ === "string" ? __WEBMCP_SDK_VERSION__ : "0.5.0";
var INSTALL_MODES = ["npm", "cdn_snippet"];
var SDK_INSTALL_MODE = INSTALL_MODES.find((mode) => mode === (typeof __WEBMCP_INSTALL_MODE__ === "string" ? __WEBMCP_INSTALL_MODE__ : "")) ?? "npm";
function isFieldParent(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safe(read) {
  try {
    return read();
  } catch {
    return;
  }
}
function gpcOptedOut(scope = globalThis) {
  return safe(() => scope.navigator?.globalPrivacyControl) === true;
}
function globalOptOut(scope) {
  return safe(() => scope.__WEBMCP_TELEMETRY__) === false;
}
function telemetryEnabled(option, scope = globalThis) {
  if (option === false)
    return false;
  if (globalOptOut(scope))
    return false;
  if (safe(() => scope.document) === undefined)
    return false;
  return !gpcOptedOut(scope);
}
var GREASE_BRAND = /not[\W_]*a[\W_]*brand/i;
var MAX_BRAND_BYTES = 1024;
function brandInfo(brands) {
  if (!Array.isArray(brands))
    return {};
  const named = brands.filter((entry) => isFieldParent(entry) && typeof entry.brand === "string" && entry.brand.length > 0 && !GREASE_BRAND.test(entry.brand));
  const chosen = named.find((entry) => !/chromium/i.test(entry.brand)) ?? named[0];
  if (!chosen)
    return {};
  const major = Number.parseInt(String(chosen.version), 10);
  return {
    browser: sliceToBytes(chosen.brand, MAX_BRAND_BYTES),
    ...Number.isFinite(major) ? { browserMajor: major } : {}
  };
}
var MAX_ERROR_CLASS_BYTES = 256;
function errorClassOf(error) {
  const name = safe(() => error?.constructor?.name);
  if (typeof name !== "string" || name.length === 0)
    return null;
  return sliceToBytes(name, MAX_ERROR_CLASS_BYTES);
}
var MAX_ERROR_SIGNATURE_BYTES = 512;
var DIGIT_RUN = /\d+/g;
var QUOTED_LITERAL = /"[^\n]*"|`[^\n]*`|(^|[^A-Za-z])'[^\n]*'/g;
var LONG_RUN = /[A-Za-z0-9_+/-]{16,}={0,2}/g;
function isOpaque(run) {
  return /\d/.test(run) || uppercaseHeavy(run);
}
var EMAIL = /(^|\s)[^\s@]*@[^\s]*\.[A-Za-z]{2,24}[^\s]*/g;
var CUT_CANDIDATE = /("[^"\n]*"|`[^`\n]*`|(?:^|[^A-Za-z])'[^'\n]*')|"[^"\n]*$|`[^`\n]*$|(^|[^A-Za-z])'[^'\n]*$|(^|\s)[^\s@]*@[^\s]*$/g;
var URL_RUN = /[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/\S*/g;
var PATH_RUN = /(?:\/[A-Za-z0-9._~%+-]+){2,}(?:[?#]\S*)?/g;
function errorSignature(error) {
  if (error === undefined || error === null)
    return;
  const full = errorMessage(error);
  if (full.length === 0)
    return;
  const truncated = full.length > MAX_INPUT_CHARS;
  const sliced = truncated ? full.slice(0, MAX_INPUT_CHARS) : full;
  const closed = truncated ? sliced.replace(CUT_CANDIDATE, (match, closedLiteral, quote, email) => closedLiteral !== undefined ? match : `${quote ?? email ?? ""}*`) : sliced;
  const templated = closed.replace(QUOTED_LITERAL, (_match, before) => `${before ?? ""}*`).replace(URL_RUN, "*").replace(LONG_RUN, (run) => isOpaque(run) ? "*" : run).replace(EMAIL, "$1*").replace(PATH_RUN, "*").replace(DIGIT_RUN, "*");
  const capped = sliceToBytes(templated, MAX_ERROR_SIGNATURE_BYTES);
  return capped.length === 0 ? undefined : capped;
}
function browserBrand(scope) {
  const uaData = safe(() => scope.navigator?.userAgentData);
  return safe(() => brandInfo(uaData?.brands)) ?? {};
}
function pathname(scope) {
  return safe(() => scope.location?.pathname);
}
function pageContext(scope) {
  const g = scope;
  const path = pathname(scope);
  const template = routeTemplate(path);
  const segments = segmentCount(path);
  const frame = frameContext(scope);
  const state = visibility(scope);
  return {
    ...template !== undefined ? { routeTemplate: template } : {},
    ...segments !== undefined ? { segmentCount: segments } : {},
    referrerClass: referrerClass(safe(() => g.document?.referrer), safe(() => g.location?.origin)),
    ...frame !== undefined ? { frameContext: frame } : {},
    ...state !== undefined ? { visibility: state } : {}
  };
}
function clientContext(scope) {
  const factor = formFactor(scope);
  const language = languageSubtag(scope);
  return {
    agentRuntime: agentRuntime(scope),
    ...browserBrand(scope),
    ...factor !== undefined ? { formFactor: factor } : {},
    ...language !== undefined ? { language } : {}
  };
}
function buildInitEvent(params = {}) {
  const scope = params.scope ?? globalThis;
  const timeToInitMs = initAt();
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    event: "sdk_init",
    ts: new Date().toISOString(),
    sessionId: sessionId(),
    sdk: { name: SDK_NAME, version: SDK_VERSION, installMode: SDK_INSTALL_MODE },
    surface: surfaceInfo(scope),
    page: pageContext(scope),
    client: clientContext(scope),
    ...timeToInitMs !== undefined ? { timeToInitMs } : {}
  };
}
function configFields(tracking) {
  const { toBackend, toOtel } = trackingOutputs(tracking);
  return {
    trackingEnabled: toBackend,
    otelEnabled: toOtel,
    customEndpoint: Boolean(safe(() => tracking?.endpoint))
  };
}
var MAX_TOOL_FIELD_BYTES = 4 * 1024;
function toolString(value) {
  return sliceToBytes(value, MAX_TOOL_FIELD_BYTES);
}
function toolEnum(allowed, value) {
  return allowed.find((candidate) => candidate === value);
}
var ANNOTATION_HINTS = ["readOnlyHint", "untrustedContentHint"];
function annotationHints(annotations) {
  const hints = {};
  for (const hint of ANNOTATION_HINTS) {
    const value = safe(() => annotations?.[hint]);
    if (typeof value === "boolean")
      hints[hint] = value;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}
function toolEntry(entry) {
  const { tool } = entry;
  const inputSchema = safe(() => tool.inputSchema);
  const hash = schemaHash(inputSchema);
  const hints = annotationHints(safe(() => tool.annotations));
  const source = toolEnum(TOOL_SOURCES, tool.source);
  const intent = toolEnum(TOOL_INTENTS, tool.intent);
  const signature = entry.outcome === "failed" ? errorSignature(entry.error) : undefined;
  return {
    name: toolString(tool.name),
    stableKey: toolString(tool.stableKey),
    ...tool.version !== undefined ? { version: toolString(tool.version) } : {},
    ...hash !== undefined ? { schemaHash: hash } : {},
    ...source !== undefined ? { source } : {},
    ...intent !== undefined ? { intent } : {},
    outcome: entry.outcome,
    ...signature !== undefined ? { failureSignature: signature } : {},
    ...shapeMetrics(inputSchema) ?? {},
    descriptionLength: typeof tool.description === "string" ? tool.description.length : 0,
    ...hints !== undefined ? { annotations: hints } : {}
  };
}
var registrationCount = 0;
var lastRegistrationRoute;
function registrationTrigger(route) {
  if (registrationCount === 0)
    return "initial";
  return route === lastRegistrationRoute ? "re_register" : "spa_navigation";
}
function nextRegistration(scope = globalThis) {
  const route = routeTemplate(pathname(scope));
  const trigger = registrationTrigger(route);
  registrationCount += 1;
  lastRegistrationRoute = route;
  return { registrationIndex: registrationCount, trigger };
}
function buildToolRegistrationEvent(params) {
  const scope = params.scope ?? globalThis;
  const template = routeTemplate(pathname(scope));
  const sinceInit = timeSinceInit(scope);
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    event: "tool_registration",
    ts: new Date().toISOString(),
    sessionId: sessionId(),
    registrationIndex: params.registrationIndex,
    trigger: params.trigger,
    ...template !== undefined ? { routeTemplate: template } : {},
    ...sinceInit !== undefined ? { timeSinceInitMs: sinceInit } : {},
    settleMs: params.settleMs,
    config: configFields(params.tracking),
    tools: params.tools.map(toolEntry)
  };
}
var callCount = 0;
var toolCallCounts = new Map;
var lastCalledTool;
var lastCalledScope;
var MAX_TRACKED_TOOLS = 512;
function nextCall(stableKey, tenantScope) {
  callCount += 1;
  if (toolCallCounts.size >= MAX_TRACKED_TOOLS && !toolCallCounts.has(stableKey)) {
    toolCallCounts.clear();
  }
  const toolCallIndex = (toolCallCounts.get(stableKey) ?? 0) + 1;
  toolCallCounts.set(stableKey, toolCallIndex);
  const precededBy = tenantScope === lastCalledScope ? lastCalledTool : undefined;
  lastCalledTool = stableKey;
  lastCalledScope = tenantScope;
  return {
    callId: randomId(),
    callIndex: callCount,
    toolCallIndex,
    ...precededBy !== undefined ? { precededBy } : {}
  };
}
var MAX_CONTENT_BLOCKS = 4096;
function responseMetrics(response) {
  const content = safe(() => response?.content);
  const blocks = Array.isArray(content) ? content.length : 0;
  return {
    bytes: safe(() => serializedBytes(response)) ?? 0,
    contentBlocks: Math.max(0, Math.min(blocks, MAX_CONTENT_BLOCKS)),
    isError: safe(() => response?.isError) === true
  };
}
function buildToolCallEvent(params) {
  const scope = params.scope ?? globalThis;
  const failed = params.outcome === "error";
  const hash = schemaHash(safe(() => params.tool.inputSchema));
  const sinceInit = timeSinceInit(scope);
  const template = routeTemplate(pathname(scope));
  const signature = failed ? errorSignature(params.error) : undefined;
  const intent = toolEnum(TOOL_INTENTS, params.tool.intent);
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    event: "tool_call",
    ts: new Date().toISOString(),
    sessionId: sessionId(),
    callId: params.callId,
    callIndex: params.callIndex,
    toolCallIndex: params.toolCallIndex,
    ...params.precededBy !== undefined ? { precededBy: toolString(params.precededBy) } : {},
    ...template !== undefined ? { routeTemplate: template } : {},
    agentRuntime: agentRuntime(scope),
    ...sinceInit !== undefined ? { timeSinceInitMs: sinceInit } : {},
    tool: {
      stableKey: toolString(params.tool.stableKey),
      ...hash !== undefined ? { schemaHash: hash } : {},
      ...intent !== undefined ? { intent } : {}
    },
    outcome: params.outcome,
    durationMs: params.durationMs,
    ...!failed && params.response !== undefined ? { response: responseMetrics(params.response) } : {},
    errorClass: failed ? errorClassOf(params.error) : null,
    ...signature !== undefined ? { errorSignature: signature } : {}
  };
}
function pruneToolEntry(entry, disabled) {
  if (!isFieldParent(entry))
    return entry;
  let remaining;
  for (const key of disabled) {
    if (!(key in entry))
      continue;
    remaining ??= { ...entry };
    delete remaining[key];
  }
  return remaining ?? entry;
}
function applyPruned(event, key, value) {
  if (value === undefined)
    delete event[key];
  else
    event[key] = value;
}
function isEmptied(value) {
  return isFieldParent(value) && Object.keys(value).length === 0;
}
function pruneToolFields(event, toolFields) {
  const disabled = Object.entries(toolFields).filter(([, collected]) => !collected).map(([field]) => field);
  if (disabled.length === 0)
    return;
  const tools = event.tools;
  if (Array.isArray(tools)) {
    const entries = [];
    let changed = false;
    for (const entry of tools) {
      const next = pruneToolEntry(entry, disabled);
      if (next !== entry)
        changed = true;
      if (isEmptied(next))
        continue;
      entries.push(next);
    }
    if (changed) {
      applyPruned(event, "tools", tools.length > 0 && entries.length === 0 ? undefined : entries);
    }
  }
  const tool = event.tool;
  if (isFieldParent(tool)) {
    const next = pruneToolEntry(tool, disabled);
    if (next !== tool)
      applyPruned(event, "tool", isEmptied(next) ? undefined : next);
  }
}
function pruneByAllowlist(event, fields = TELEMETRY_FIELDS, toolFields = TELEMETRY_TOOL_FIELDS) {
  const pruned = { ...event };
  for (const [field, collected] of Object.entries(fields)) {
    if (collected)
      continue;
    const dot = field.indexOf(".");
    if (dot === -1) {
      delete pruned[field];
      continue;
    }
    const parentKey = field.slice(0, dot);
    const childKey = field.slice(dot + 1);
    const parent = pruned[parentKey];
    if (!isFieldParent(parent) || !(childKey in parent))
      continue;
    const remaining = { ...parent };
    delete remaining[childKey];
    applyPruned(pruned, parentKey, isEmptied(remaining) ? undefined : remaining);
  }
  pruneToolFields(pruned, toolFields);
  return pruned;
}
var defaultSinks2 = {
  sendTelemetry: (event) => sendTelemetry(event, globalThis, telemetryEndpoint(), telemetryApiKey())
};
function batchTelemetrySinks(apiKey, endpoint) {
  const own = batchApiKey(apiKey);
  const ownEndpoint = telemetryEndpointFrom(endpoint);
  return {
    sendTelemetry: (event) => sendTelemetry(event, globalThis, ownEndpoint ?? telemetryEndpoint(), own ?? telemetryApiKey())
  };
}
function batchApiKey(apiKey) {
  return typeof apiKey === "string" && apiKey.trim().length > 0 ? apiKey : undefined;
}
function resolveTelemetryKey(apiKey) {
  return batchApiKey(apiKey) ?? telemetryApiKey();
}
function telemetryTenantScope(apiKey) {
  const resolved = resolveTelemetryKey(apiKey);
  return resolved === undefined ? "" : fnv1a(resolved);
}
function emitTelemetry(build, sinks = defaultSinks2, fields = TELEMETRY_FIELDS, toolFields = TELEMETRY_TOOL_FIELDS) {
  try {
    if (!telemetryEnabled())
      return;
    sinks.sendTelemetry(boundEventPayload(pruneByAllowlist({ ...build() }, fields, toolFields)));
  } catch {}
}
var initCancelled = false;
var initFlushed = false;
var cancelInitFallback = () => {};
var capturedApiKey;
var capturedEndpoint;
function captureTelemetryApiKey(apiKey) {
  if (typeof apiKey === "string" && apiKey.trim().length > 0)
    capturedApiKey = apiKey;
}
function telemetryApiKey() {
  return capturedApiKey;
}
function telemetryEndpointFrom(endpoint) {
  if (typeof endpoint !== "string")
    return;
  return safe(() => {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !url.pathname.endsWith("/v1/collect") || url.search !== "" || url.hash !== "") {
      return;
    }
    url.pathname = `${url.pathname.slice(0, -"/v1/collect".length)}/v1/telemetry`;
    return url.toString();
  });
}
function captureTelemetryEndpoint(endpoint) {
  const derived = telemetryEndpointFrom(endpoint);
  if (derived !== undefined)
    capturedEndpoint = derived;
}
function telemetryEndpoint() {
  return capturedEndpoint;
}
function cancelInitEvent() {
  initCancelled = true;
  cancelInitFallback();
}
function flushInitEvent(sinks) {
  if (initFlushed)
    return;
  initFlushed = true;
  cancelInitFallback();
  if (initCancelled)
    return;
  emitTelemetry(() => buildInitEvent(), sinks);
}
function deferInitEventForBatch(sinks) {
  if (initFlushed || initCancelled)
    return;
  afterDelay(() => flushInitEvent(sinks), 0);
}
function afterDelay(run, ms) {
  const schedule = safe(() => globalThis.setTimeout);
  if (typeof schedule !== "function")
    return () => {};
  const handle = safe(() => schedule.call(globalThis, () => run(), ms));
  return () => {
    const clear = safe(() => globalThis.clearTimeout);
    if (typeof clear !== "function")
      return;
    safe(() => clear.call(globalThis, handle));
  };
}
var INIT_FALLBACK_MS = 1000;
cancelInitFallback = afterDelay(() => flushInitEvent(), INIT_FALLBACK_MS);

// src/register.ts
function isContentResult(value) {
  return typeof value === "object" && value !== null && Array.isArray(value.content);
}
function normalizeResult(value) {
  if (isContentResult(value))
    return value;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }] };
}
function elapsedMs(end, start) {
  if (typeof end !== "number" || typeof start !== "number")
    return 0;
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0;
}
function clock() {
  const perf = safe(() => globalThis.performance);
  const now = safe(() => perf?.now);
  if (typeof now === "function") {
    const read2 = () => safe(() => now.call(perf));
    const start2 = read2();
    if (start2 !== undefined)
      return () => elapsedMs(read2(), start2);
  }
  const read = () => safe(() => Date.now());
  const start = read();
  return () => elapsedMs(read(), start);
}
function trackerFor(tool, tracking) {
  if (!tracking)
    return;
  const { toBackend, toOtel } = trackingOutputs(tracking);
  if (!toBackend && !toOtel)
    return;
  const shared = {
    toolStableKey: tool.stableKey,
    toolName: tool.name,
    callId: randomId(),
    ...tool.version !== undefined ? { toolVersion: tool.version } : {}
  };
  return (eventName, data) => track(tracking, eventName, { ...shared, ...data });
}
function toSpecTool(tool, channels) {
  const { tracking, telemetry, telemetrySinks, telemetryKey, telemetryEndpoint: telemetryEndpoint2 } = channels;
  return {
    name: tool.name,
    ...tool.title !== undefined ? { title: tool.title } : {},
    description: tool.description,
    ...tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {},
    ...tool.annotations !== undefined ? { annotations: tool.annotations } : {},
    async execute(input) {
      const trackCall = trackerFor(tool, tracking);
      if (!trackCall && !telemetry)
        return normalizeResult(await tool.execute(input));
      const callKey = telemetry ? resolveTelemetryKey(telemetryKey) : undefined;
      const sequence = telemetry ? nextCall(tool.stableKey, telemetryTenantScope(callKey)) : undefined;
      const callSinks = sequence ? batchTelemetrySinks(callKey, telemetryEndpoint2) : telemetrySinks;
      const elapsed = clock();
      trackCall?.("tool_call_request", { input });
      try {
        const response = normalizeResult(await tool.execute(input));
        const durationMs = elapsed();
        trackCall?.("tool_call_response", { response, duration_ms: durationMs });
        if (sequence) {
          emitTelemetry(() => buildToolCallEvent({ ...sequence, tool, outcome: "success", durationMs, response }), callSinks);
        }
        return response;
      } catch (error) {
        const durationMs = elapsed();
        trackCall?.("tool_call_response", {
          error: errorMessage(error),
          duration_ms: durationMs
        });
        if (sequence) {
          emitTelemetry(() => buildToolCallEvent({ ...sequence, tool, outcome: "error", durationMs, error }), callSinks);
        }
        throw error;
      }
    }
  };
}
var REGISTRATION_TIMEOUT_MS = 2000;
var PAGEHIDE = "pagehide";
function onPagehide(run) {
  const g = globalThis;
  const add = safe(() => g.addEventListener);
  const remove = safe(() => g.removeEventListener);
  if (typeof add !== "function" || typeof remove !== "function")
    return () => {};
  const listener = () => run();
  safe(() => add.call(g, PAGEHIDE, listener, { once: true }));
  return () => {
    safe(() => remove.call(g, PAGEHIDE, listener));
  };
}
function watchRegistration(tools, tracking, sinks) {
  const entries = tools.map((tool) => ({ tool, outcome: "pending" }));
  const elapsed = clock();
  const { registrationIndex, trigger } = nextRegistration();
  let emitted = false;
  const release = [];
  const emit = () => {
    if (emitted)
      return;
    emitted = true;
    for (const stop of release)
      stop();
    const settleMs = elapsed();
    emitTelemetry(() => buildToolRegistrationEvent({
      registrationIndex,
      trigger,
      settleMs,
      tools: entries,
      tracking
    }), sinks);
  };
  release.push(afterDelay(emit, REGISTRATION_TIMEOUT_MS), onPagehide(emit));
  return {
    record(index, result) {
      const entry = entries[index];
      if (!entry)
        return;
      entry.outcome = result.state;
      if (result.error !== undefined)
        entry.error = result.error;
    },
    emit
  };
}
function assertUniqueIdentities(tools) {
  const names = new Set;
  const keys = new Set;
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new TypeError(`registerTools: duplicate tool name "${tool.name}"`);
    }
    if (keys.has(tool.stableKey)) {
      throw new TypeError(`registerTools: duplicate stableKey "${tool.stableKey}"`);
    }
    names.add(tool.name);
    keys.add(tool.stableKey);
  }
}
function registerTools(tools, options = {}) {
  const telemetryOption = safe(() => ({ value: options.telemetry }));
  const tracking = safe(() => options.tracking);
  const telemetryLive = telemetryOption !== undefined && telemetryEnabled(telemetryOption.value);
  const apiKey = telemetryLive ? safe(() => tracking?.apiKey) : undefined;
  const endpoint = telemetryLive ? safe(() => tracking?.endpoint) : undefined;
  const telemetrySinks = telemetryLive ? batchTelemetrySinks(apiKey, endpoint) : undefined;
  const channels = {
    tracking,
    telemetry: telemetryLive,
    ...telemetryLive ? {
      telemetrySinks,
      telemetryKey: apiKey,
      telemetryEndpoint: endpoint
    } : {}
  };
  if (telemetryOption?.value === false)
    cancelInitEvent();
  if (telemetrySinks) {
    captureTelemetryApiKey(apiKey);
    captureTelemetryEndpoint(endpoint);
    deferInitEventForBatch(telemetrySinks);
  }
  assertUniqueIdentities(tools);
  const controller = new AbortController;
  const external = options.signal;
  if (external) {
    if (external.aborted)
      controller.abort(external.reason);
    else
      external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
  }
  const modelContext = options.modelContext ?? resolveModelContext();
  const result = (tool, state, error) => ({
    stableKey: tool.stableKey,
    name: tool.name,
    state,
    ...error !== undefined ? { error } : {}
  });
  const watch = channels.telemetry ? watchRegistration(tools, channels.tracking, channels.telemetrySinks) : undefined;
  const settle = async (tool) => {
    if (!modelContext)
      return result(tool, "unsupported");
    if (controller.signal.aborted)
      return result(tool, "aborted");
    try {
      await Promise.resolve(modelContext.registerTool(toSpecTool(tool, channels), {
        signal: controller.signal
      }));
      return result(tool, "registered");
    } catch (error) {
      if (controller.signal.aborted)
        return result(tool, "aborted");
      return result(tool, "failed", error);
    }
  };
  const ready = Promise.all(tools.map(async (tool, index) => {
    const settled = await settle(tool);
    watch?.record(index, settled);
    return settled;
  }));
  if (watch)
    ready.then(() => watch.emit());
  return {
    ready,
    signal: controller.signal,
    unregister() {
      controller.abort();
    }
  };
}
export {
  resolveModelContext,
  registerTools,
  defineTool
};
