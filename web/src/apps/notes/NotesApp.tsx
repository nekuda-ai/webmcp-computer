import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ls,
  parentPath,
  readFile,
  watch,
  whenPathIdle,
  writeFile,
  type FileEntry,
} from "../../kernel/fs";
import { useKernelStore } from "../../kernel/store";
import { VerbHint } from "../../desktop/VerbHint";
import type { AppComponentProps } from "../registry";
import { ConflictBar } from "../shared/ConflictBar";
import { resolveExternalFileChange, scheduleAutosave } from "../shared/fileBuffer";
import { MarkdownPreview } from "./MarkdownPreview";
import { notesTools } from "../../tools/registry";
import { useAppTools } from "../../tools/useAppTools";
import { errorMessage } from "../../shared";
import {
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "../../kernel/ownershipAdmission";

export function NotesApp({ process }: AppComponentProps) {
  useAppTools(process.pid, notesTools);
  const [notes, setNotes] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState(process.path ?? "~/notes/welcome.md");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [status, setStatus] = useState("Loading notes…");
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
  const osEvent = useKernelStore((state) => state.osEvent);
  const settleEvent = useKernelStore((state) => state.settleEvent);
  const preview = useKernelStore((state) => state.notesPreviewEnabledByPid[process.pid] ?? false);
  const setPreview = useKernelStore((state) => state.setNotesPreviewEnabled);
  const setProcessPath = useKernelStore((state) => state.setProcessPath);
  const setNoteSticky = useKernelStore((state) => state.setNoteSticky);
  const sticky = useKernelStore((state) => state.stickyNotes.some(({ path }) => path === activePath));
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

  const refreshNotes = useCallback(async () => {
    try {
      const entries = (await ls("~/notes")).filter(
        (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
      );
      setNotes(entries);
      if (entries.length > 0 && !entries.some((entry) => entry.path === activePath)) {
        setActivePath(entries[0]?.path ?? "~/notes/welcome.md");
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [activePath]);

  const loadNote = useCallback(async (path: string, flash = false) => {
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
    if (fileSystemStatus === "ready") void refreshNotes();
    return watch((change) => {
      if (
        change.path === "~/notes" ||
        parentPath(change.path) === "~/notes" ||
        (change.from !== undefined && parentPath(change.from) === "~/notes")
      ) {
        void refreshNotes();
      }
      if (change.path !== activePath) return;
      if (saving.current) {
        if (change.source === "agent") pendingAgentChange.current = true;
        return;
      }
      void reconcileExternalChange(activePath);
    });
  }, [activePath, fileSystemStatus, reconcileExternalChange, refreshNotes]);

  useEffect(() => {
    if (process.path) setActivePath(process.path);
  }, [process.path]);

  useEffect(() => {
    if (fileSystemStatus === "ready") void loadNote(activePath);
  }, [activePath, fileSystemStatus, loadNote]);

  useEffect(() => {
    return () => {
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, []);

  useEffect(() => () => flushRef.current(), []);

  const save = useCallback(async (
    autosave = false,
    ownershipAdmission?: MachineMutationAdmission,
  ) => {
    if (loadError) {
      setStatus("webmcp-computer: reload the note successfully before saving");
      return;
    }
    const action = osEvent("human", "fs_write", {
      path: activePath,
      appId: "notes",
      ...(autosave ? { autosave: true } : {}),
    });
    saving.current = true;
    pendingAgentChange.current = false;
    const snapshot = contentRef.current;
    try {
      await writeFile(activePath, snapshot, ownershipAdmission ?? "human");
      savedContentRef.current = snapshot;
      setSavedContent(snapshot);
      await whenPathIdle(activePath);
      const diskContent = await readFile(activePath);
      if (diskContent !== snapshot) {
        await reconcileExternalChange(activePath, true);
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
        void reconcileExternalChange(activePath, true);
      }
    }
  }, [activePath, loadError, osEvent, reconcileExternalChange, settleEvent]);

  const handleSaveShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const dirty = !loadError && content !== savedContent;

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
    <section className="notes-app">
      <aside className="notes-sidebar">
        <span className="micro">MARKDOWN NOTES</span>
        <div className="notes-list">
          {notes.map((note) => (
            <VerbHint key={note.path} verb="fs_read" arg={note.path}>
              <button
                className={note.path === activePath ? "is-active" : ""}
                type="button"
                onClick={() => {
                  setActivePath(note.path);
                  setProcessPath(process.pid, note.path);
                  osEvent("human", "fs_read", { path: note.path, appId: "notes" });
                }}
              >
                {note.name.replace(/\.md$/i, "")}
              </button>
            </VerbHint>
          ))}
        </div>
      </aside>
      <div className="notes-workspace">
        <header className="app-toolbar">
          <span className="app-path mono" title={activePath}>{activePath}</span>
          <VerbHint verb="notes_preview" arg={String(!preview)}>
            <button
              className="app-button"
              type="button"
              onClick={() => {
                const enabled = !preview;
                setPreview(process.pid, enabled);
                osEvent("human", "notes_preview", {
                  enabled,
                  appId: "notes",
                  pid: process.pid,
                });
              }}
            >
              {preview ? "Edit" : "Preview"}
            </button>
          </VerbHint>
          <VerbHint verb="notes_stick" arg={`${activePath}: ${String(!sticky)}`}>
            <button
              className="app-button"
              type="button"
              onClick={() => {
                setNoteSticky(activePath, !sticky);
                osEvent("human", "notes_stick", {
                  path: activePath,
                  sticky: !sticky,
                  appId: "notes",
                  pid: process.pid,
                });
              }}
            >
              {sticky ? "Unstick" : "Stick to desktop"}
            </button>
          </VerbHint>
          <VerbHint verb="fs_write" arg={activePath}>
            <button
              className="app-button app-button--primary"
              type="button"
              disabled={loadError}
              onClick={() => void save()}
            >
              Save
            </button>
          </VerbHint>
        </header>
        {conflict ? (
          <ConflictBar
            path={activePath}
            onReload={() => void loadNote(activePath, true)}
            onKeepMine={() => void save()}
          />
        ) : null}
        {loadError ? (
          <div className="app-load-error mono" role="alert">{status}</div>
        ) : preview ? (
          <MarkdownPreview content={content} />
        ) : (
          <VerbHint verb="fs_write" arg={activePath}>
            <textarea
              className={`notes-textarea${flashing ? " is-reloaded" : ""}`}
              aria-label={`Editing note ${activePath}`}
              value={content}
              onChange={(event) => applyContent(event.target.value)}
              onKeyDown={handleSaveShortcut}
            />
          </VerbHint>
        )}
        <footer className={`app-status mono${status.startsWith("webmcp-computer:") ? " is-error" : ""}`}>
          <span>{loadError ? "ERROR" : conflict ? "CONFLICT" : dirty ? "UNSAVED" : "CLEAN"}</span>
          <span>{status}</span>
        </footer>
      </div>
    </section>
  );
}
