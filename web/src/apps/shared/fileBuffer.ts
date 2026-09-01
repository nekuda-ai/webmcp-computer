export type ExternalFileResolution =
  | { kind: "reload"; content: string; savedContent: string }
  | { kind: "conflict"; content: string; savedContent: string };

export const AUTOSAVE_DELAY_MS = 500;

export type AutosaveClock = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type AutosaveHandle = {
  cancel(): void;
  flush(): void;
};

const browserClock: AutosaveClock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function scheduleAutosave(
  save: () => void,
  canSave: () => boolean,
  clock: AutosaveClock = browserClock,
): AutosaveHandle {
  let pending = true;
  let scheduled = true;
  const savePending = () => {
    if (!pending) return;
    pending = false;
    if (canSave()) save();
  };
  const handle = clock.setTimeout(() => {
    if (!scheduled) return;
    scheduled = false;
    savePending();
  }, AUTOSAVE_DELAY_MS);
  const cancel = () => {
    if (!scheduled) return;
    scheduled = false;
    clock.clearTimeout(handle);
  };
  return {
    cancel,
    flush() {
      cancel();
      savePending();
    },
  };
}

export function resolveExternalFileChange(
  content: string,
  savedContent: string,
  diskContent: string,
  forceConflict = false,
): ExternalFileResolution {
  if (forceConflict || content !== savedContent) {
    return { kind: "conflict", content, savedContent };
  }
  return { kind: "reload", content: diskContent, savedContent: diskContent };
}
