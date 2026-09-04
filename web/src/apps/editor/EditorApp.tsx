import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  isTextFile,
  normalizePath,
  readFile,
  stat,
  watch,
  whenPathIdle,
  writeFile,
} from "../../kernel/fs";
import { useKernelStore } from "../../kernel/store";
import { VerbHint } from "../../desktop/VerbHint";
import type { AppComponentProps } from "../registry";
import { ConflictBar } from "../shared/ConflictBar";
import { resolveExternalFileChange, scheduleAutosave } from "../shared/fileBuffer";
import { editorTools } from "../../tools/registry";
import { useAppTools } from "../../tools/useAppTools";
import { errorMessage } from "../../shared";
import {
  assertMachineMutationAdmission,
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "../../kernel/ownershipAdmission";

export function EditorApp({ process }: AppComponentProps) {
  useAppTools(process.pid, editorTools);
  const [openPath, setOpenPath] = useState(process.path ?? "~/desktop/brief.md");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [status, setStatus] = useState(process.path ? "Loading…" : "Open a text file");
  const [flashing, setFlashing] = useState(false);
  const [conflict, setConflictState] = useState(false);
  const [loadError, setLoadErrorState] = useState(false);
  // Mirrored in refs so the unmount flush reads current truth even when the
  // state update and the unmount land in the same React commit.
  const conflictRef = useRef(false);
  const loadErrorRef = useRef(false);
  const contentRef = useRef("");
  const savedContentRef = useRef("");
  const saving = useRef(false);
  const pendingAgentChange = useRef(false);
  const flashTimer = useRef<number | undefined>(undefined);
  const autosaveRef = useRef<ReturnType<typeof scheduleAutosave> | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const setProcessPath = useKernelStore((state) => state.setProcessPath);
  const osEvent = useKernelStore((state) => state.osEvent);
  const settleEvent = useKernelStore((state) => state.settleEvent);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);
  flushRef.current = () => autosaveRef.current?.flush();

  const setConflict = useCallback((value: boolean) => {
    conflictRef.current = value;
    setConflictState(value);
  }, []);

  const setLoadError = useCallback((value: boolean) => {
    loadErrorRef.current = value;
    setLoadErrorState(value);
  }, []);

  const applyContent = useCallback((next: string, saved = false) => {
    contentRef.current = next;
    setContent(next);
    if (saved) {
      savedContentRef.current = next;
      setSavedContent(next);
    }
  }, []);

  const flashReload = useCallback(() => {
    setFlashing(true);
    if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashing(false), 650);
  }, []);

  const load = useCallback(async (path: string, flash = false) => {
    try {
      const next = await readFile(path);
      applyContent(next, true);
      setLoadError(false);
      setConflict(false);
      setStatus(flash ? "Reloaded after filesystem change" : "Saved on disk");
      if (flash) flashReload();
    } catch (error) {
      setLoadError(true);
      setStatus(errorMessage(error));
    }
  }, [applyContent, flashReload]);

  const reconcileExternalChange = useCallback(async (path: string, forceConflict = false) => {
    try {
      const diskContent = await readFile(path);
      const resolution = resolveExternalFileChange(
        contentRef.current,
        savedContentRef.current,
        diskContent,
        forceConflict,
      );
      if (resolution.kind === "conflict") {
        setConflict(true);
        setStatus("Changed on disk — choose Reload or Keep mine");
        return;
      }
      applyContent(resolution.content, true);
      setConflict(false);
      setStatus("Reloaded after filesystem change");
      flashReload();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [applyContent, flashReload]);

  useEffect(() => {
    if (!process.path) return;
    setOpenPath(process.path);
    if (fileSystemStatus === "ready") void load(process.path);
  }, [fileSystemStatus, load, process.path]);

  useEffect(() => {
    return watch((change) => {
      if (!process.path || change.path !== process.path) return;
      if (saving.current) {
        if (change.source === "agent") pendingAgentChange.current = true;
        return;
      }
      void reconcileExternalChange(process.path);
    });
  }, [process.path, reconcileExternalChange]);

  useEffect(() => {
    return () => {
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, []);

  useEffect(() => () => flushRef.current(), []);

  const openFile = async (event: FormEvent) => {
    event.preventDefault();
    const action = osEvent("human", "editor_open_file", { path: openPath, pid: process.pid });
    try {
      const ownershipAdmission = captureMachineMutationAdmission("human");
      const path = normalizePath(openPath.trim());
      const file = await stat(path);
      if (file.kind !== "file") throw new Error(`webmcp-computer: is a directory: ${path}`);
      if (!isTextFile(path)) throw new Error(`webmcp-computer: not a text file: ${path} (${file.size} bytes)`);
      assertMachineMutationAdmission(ownershipAdmission);
      setProcessPath(process.pid, path);
      setOpenPath(path);
      setLoadError(false);
      setStatus("Loading…");
      settleEvent(action, true);
    } catch (error) {
      const message = errorMessage(error);
      settleEvent(action, false, message);
      setLoadError(true);
      setStatus(message);
    }
  };

  const save = useCallback(async (
    autosave = false,
    ownershipAdmission?: MachineMutationAdmission,
  ) => {
    if (loadError) {
      setStatus("webmcp-computer: reload the file successfully before saving");
      return;
    }
    if (!process.path) {
      setStatus("webmcp-computer: open a file before saving");
      return;
    }
    const path = process.path;
    const action = osEvent("human", "fs_write", {
      path,
      pid: process.pid,
      ...(autosave ? { autosave: true } : {}),
    });
    saving.current = true;
    pendingAgentChange.current = false;
    const snapshot = contentRef.current;
    try {
      await writeFile(path, snapshot, ownershipAdmission ?? "human");
      savedContentRef.current = snapshot;
      setSavedContent(snapshot);
      await whenPathIdle(path);
      const diskContent = await readFile(path);
      if (diskContent !== snapshot) {
        await reconcileExternalChange(path, true);
      } else {
        setConflict(false);
        setStatus("Saved on disk");
      }
      settleEvent(action, true);
    } catch (error) {
      const message = errorMessage(error);
      settleEvent(action, false, message);
      setStatus(message);
    } finally {
      saving.current = false;
      if (pendingAgentChange.current) {
        pendingAgentChange.current = false;
        void reconcileExternalChange(path, true);
      }
    }
  }, [loadError, osEvent, process.path, process.pid, reconcileExternalChange, settleEvent]);

  const handleSaveShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const dirty = !loadError && process.path !== undefined && content !== savedContent;

  useEffect(() => {
    autosaveRef.current = null;
    if (!dirty || conflict || fileSystemStatus !== "ready") return undefined;
    setStatus("Autosave pending");
    let ownershipAdmission: MachineMutationAdmission;
    try {
      ownershipAdmission = captureMachineMutationAdmission("human");
    } catch (error) {
      setStatus(errorMessage(error));
      return undefined;
    }
    const autosave = scheduleAutosave(
      () => void save(true, ownershipAdmission),
      () =>
        !conflictRef.current && !loadErrorRef.current &&
        useKernelStore.getState().fileSystemStatus === "ready",
    );
    autosaveRef.current = autosave;
    return autosave.cancel;
  }, [conflict, content, dirty, fileSystemStatus, loadError, save]);

  return (
    <section className="editor-app">
      <form className="app-toolbar editor-open" onSubmit={(event) => void openFile(event)}>
        <VerbHint verb="editor_open_file" arg={openPath}>
          <input
            value={openPath}
            onChange={(event) => setOpenPath(event.target.value)}
            aria-label="File path"
            spellCheck={false}
          />
        </VerbHint>
        <VerbHint verb="editor_open_file" arg={openPath}>
          <button className="app-button" type="submit">Open</button>
        </VerbHint>
        <VerbHint verb="fs_write" arg={process.path ?? "path required"}>
          <button
            className="app-button app-button--primary"
            type="button"
            disabled={loadError}
            onClick={() => void save()}
          >
            Save
          </button>
        </VerbHint>
      </form>
      {process.path ? (
        <>
          {conflict ? (
            <ConflictBar
              path={process.path}
              onReload={() => void load(process.path as string, true)}
              onKeepMine={() => void save()}
            />
          ) : null}
          {loadError ? (
            <div className="app-load-error mono" role="alert">{status}</div>
          ) : (
            <VerbHint verb="fs_write" arg={process.path}>
              <textarea
                className={`editor-textarea${flashing ? " is-reloaded" : ""}`}
                aria-label={`Editing ${process.path}`}
                value={content}
                onChange={(event) => applyContent(event.target.value)}
                onKeyDown={handleSaveShortcut}
                spellCheck={false}
              />
            </VerbHint>
          )}
        </>
      ) : (
        <div className="editor-empty">
          <span className="micro">EDITOR READY</span>
          <p>Enter a ~-rooted path, then open it.</p>
        </div>
      )}
      <footer className={`app-status mono${status.startsWith("webmcp-computer:") ? " is-error" : ""}`}>
        <span className="editor-save-state">
          <span className={`editor-dirty-dot${dirty ? " is-dirty" : ""}`} aria-hidden="true" />
          {loadError ? "ERROR" : conflict ? "CONFLICT" : dirty ? "UNSAVED" : "CLEAN"}
        </span>
        <span>{status}</span>
        <span>{content.length} CHARS</span>
      </footer>
    </section>
  );
}
