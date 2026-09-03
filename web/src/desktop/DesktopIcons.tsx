import { useCallback, useEffect, useState } from "react";
import {
  isTextFile,
  ls,
  parentPath,
  rm,
  watch,
  type FileEntry,
  type FileSystemChange,
} from "../kernel/fs";
import { useKernelStore } from "../kernel/store";
import { errorMessage } from "../shared";
import { showContextMenu } from "./ContextMenu";
import { VerbHint } from "./VerbHint";

function touchesDesktop(change: FileSystemChange): boolean {
  return change.path === "~/desktop" || parentPath(change.path) === "~/desktop" ||
    (change.from !== undefined &&
      (change.from === "~/desktop" || parentPath(change.from) === "~/desktop"));
}

function EntryGlyph({ entry }: { entry: FileEntry }) {
  if (entry.kind === "directory") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M3.5 9.5A2.5 2.5 0 0 1 6 7h7l3 3h10a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 26 26H6a2.5 2.5 0 0 1-2.5-2.5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8 3.5h11l6 6v19H8z" />
      <path d="M19 3.5v6h6M12 15h9M12 19h9M12 23h6" />
    </svg>
  );
}

export function DesktopIcons() {
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);
  const spawn = useKernelStore((state) => state.spawn);
  const focus = useKernelStore((state) => state.focus);
  const setProcessPath = useKernelStore((state) => state.setProcessPath);
  const osEvent = useKernelStore((state) => state.osEvent);
  const settleEvent = useKernelStore((state) => state.settleEvent);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await ls("~/desktop"));
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    if (fileSystemStatus === "ready") void refresh();
    return watch((change) => {
      if (touchesDesktop(change)) void refresh();
    });
  }, [fileSystemStatus, refresh]);

  useEffect(() => {
    if (pendingDelete && !entries.some((entry) => entry.path === pendingDelete.path)) {
      setPendingDelete(null);
      setDeleteError(null);
    }
  }, [entries, pendingDelete]);

  const open = (entry: FileEntry) => {
    if (entry.kind === "file" && isTextFile(entry.path)) {
      const process = spawn("editor", { path: entry.path });
      osEvent("human", "editor_open_file", {
        path: entry.path,
        appId: "editor",
        pid: process.pid,
      });
      return;
    }
    const existing = [...useKernelStore.getState().processes]
      .filter(({ appId }) => appId === "files")
      .sort((left, right) => right.zIndex - left.zIndex)[0];
    const directory = entry.kind === "directory" ? entry.path : parentPath(entry.path);
    const process = existing ?? spawn("files", { path: directory });
    if (existing) {
      setProcessPath(existing.pid, directory);
      focus(existing.pid);
    }
    osEvent("human", "files_reveal", {
      path: entry.path,
      directory,
      appId: "files",
      pid: process.pid,
    });
  };

  const deleteEntry = async (entry: FileEntry) => {
    const event = osEvent("human", "fs_delete", { path: entry.path });
    try {
      await rm(entry.path, "human");
      settleEvent(event, true);
      setPendingDelete(null);
      setDeleteError(null);
    } catch (error) {
      const message = errorMessage(error);
      settleEvent(event, false, message);
      setDeleteError(message);
    }
  };

  const copyPath = (entry: FileEntry) => {
    void navigator.clipboard.writeText(entry.path).catch(() => undefined);
  };

  return (
    <div className="desktop-icons" data-analytics-block="" aria-label="Desktop files">
      {pendingDelete ? (
        <form
          className="file-action-bar desktop-icons__confirm"
          onSubmit={(event) => {
            event.preventDefault();
            void deleteEntry(pendingDelete);
          }}
        >
          <span className="file-action-bar__message">
            {deleteError ?? (
              <>
                Delete {pendingDelete.name}
                {pendingDelete.kind === "directory" ? " and its contents" : ""}?
              </>
            )}
          </span>
          <VerbHint verb="fs_delete" arg={pendingDelete.path}>
            <button className="app-button app-button--primary" type="submit">Delete</button>
          </VerbHint>
          <button
            className="app-button"
            type="button"
            onClick={() => {
              setPendingDelete(null);
              setDeleteError(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {entries.map((entry) => {
        const verb = entry.kind === "file" && isTextFile(entry.path)
          ? "editor_open_file"
          : "files_reveal";
        return (
          <VerbHint key={entry.path} verb={verb} arg={entry.path}>
            <button
              className="desktop-icon"
              type="button"
              data-desktop-path={entry.path}
              aria-label={`Open ${entry.name}`}
              onDoubleClick={() => open(entry)}
              onContextMenu={(event) => showContextMenu(event, {
                label: entry.name,
                items: [
                  {
                    label: "Open",
                    verb,
                    arg: entry.path,
                    onSelect: () => open(entry),
                  },
                  { type: "separator" },
                  {
                    label: "Delete",
                    verb: "fs_delete",
                    arg: entry.path,
                    onSelect: () => {
                      setDeleteError(null);
                      setPendingDelete(entry);
                    },
                  },
                  { type: "separator" },
                  { label: "Copy path", onSelect: () => copyPath(entry) },
                ],
              })}
            >
              <span className="desktop-icon__glyph"><EntryGlyph entry={entry} /></span>
              <span className="desktop-icon__name">{entry.name}</span>
            </button>
          </VerbHint>
        );
      })}
    </div>
  );
}
