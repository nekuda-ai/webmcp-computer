import { APP_IDS, type ProcessRecord, type StickyNoteRecord, type WindowRect } from "./types";

export const SESSION_STORAGE_KEY = "webmcp_computer.session.v1";

export type SessionSnapshot = {
  version: 1;
  processes: ProcessRecord[];
  minimizedPids: number[];
  nextPid: number;
  nextSpawnCount: number;
  lastSpawnOrigin: Pick<WindowRect, "x" | "y"> | null;
  stickyNotes: StickyNoteRecord[];
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function processRecord(value: unknown): value is ProcessRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ProcessRecord>;
  const rect = record.windowRect;
  return Number.isInteger(record.pid) && (record.pid ?? 0) >= 2 &&
    APP_IDS.includes(record.appId as (typeof APP_IDS)[number]) &&
    (record.path === undefined || typeof record.path === "string") &&
    (record.cwd === undefined || typeof record.cwd === "string") &&
    rect !== undefined && finiteNumber(rect.x) && finiteNumber(rect.y) &&
    finiteNumber(rect.width) && finiteNumber(rect.height) &&
    Number.isInteger(record.zIndex) && typeof record.focused === "boolean";
}

function origin(value: unknown): value is SessionSnapshot["lastSpawnOrigin"] {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const candidate = value as Partial<WindowRect>;
  return finiteNumber(candidate.x) && finiteNumber(candidate.y);
}

function stickyNote(value: unknown): value is StickyNoteRecord {
  if (value === null || typeof value !== "object") return false;
  const note = value as Partial<StickyNoteRecord>;
  return typeof note.path === "string" && finiteNumber(note.x) && finiteNumber(note.y);
}

export function serializeSession(snapshot: SessionSnapshot): string {
  return JSON.stringify(snapshot);
}

export function deserializeSession(serialized: string | null): SessionSnapshot | null {
  if (serialized === null) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (value === null || typeof value !== "object") return null;
    const snapshot = value as Partial<SessionSnapshot>;
    const stickyNotes = snapshot.stickyNotes ?? [];
    const minimizedPids = snapshot.minimizedPids ?? [];
    if (snapshot.version !== 1 || !Array.isArray(snapshot.processes) ||
      !snapshot.processes.every(processRecord) || !Number.isInteger(snapshot.nextPid) ||
      (snapshot.nextPid ?? 0) < 2 || !Number.isInteger(snapshot.nextSpawnCount) ||
      (snapshot.nextSpawnCount ?? -1) < 0 || !origin(snapshot.lastSpawnOrigin) ||
      !Array.isArray(minimizedPids) ||
      !minimizedPids.every((pid) => Number.isInteger(pid) && pid >= 2 &&
        snapshot.processes?.some((process) => process.pid === pid)) ||
      new Set(minimizedPids).size !== minimizedPids.length ||
      !Array.isArray(stickyNotes) || !stickyNotes.every(stickyNote)) {
      return null;
    }
    return {
      ...(snapshot as Omit<SessionSnapshot, "minimizedPids" | "stickyNotes">),
      minimizedPids,
      stickyNotes,
    };
  } catch {
    return null;
  }
}
