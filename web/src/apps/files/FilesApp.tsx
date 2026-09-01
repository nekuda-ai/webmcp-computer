import { useCallback, useEffect, useState } from "react";
import type { AppComponentProps } from "../registry";
import {
  createFile,
  isTextFile,
  joinPath,
  ls,
  mkdir,
  mv,
  parentPath,
  rm,
  watch,
  type FileEntry,
  type FileSystemChange,
} from "../../kernel/fs";
import { useKernelStore } from "../../kernel/store";
import { showContextMenu } from "../../desktop/ContextMenu";
import { VerbHint } from "../../desktop/VerbHint";
import { filesTools } from "../../tools/registry";
import { useAppTools } from "../../tools/useAppTools";
import { errorMessage } from "../../shared";

function formatSize(entry: FileEntry): string {
  if (entry.kind === "directory") return "DIR";
  if (entry.size < 1_024) return `${entry.size} B`;
  return `${(entry.size / 1_024).toFixed(1)} KB`;
}

type PendingAction =
  | { kind: "create"; entryKind: "file" | "directory"; value: string }
  | { kind: "rename"; entry: FileEntry; value: string }
  | { kind: "delete"; entry: FileEntry };

function changeTouchesDirectory(change: FileSystemChange, directory: string): boolean {
  if (change.path === directory || parentPath(change.path) === directory) return true;
  return change.from !== undefined &&
    (change.from === directory || parentPath(change.from) === directory);
}

export async function createFilesAppEntry(
  entryPath: string,
  kind: "file" | "directory",
): Promise<void> {
  if (kind === "file") await createFile(entryPath, "", "human");
  else await mkdir(entryPath, "human");
}

export function FilesApp({ process }: AppComponentProps) {
  useAppTools(process.pid, filesTools);
  const [path, setPath] = useState(process.path ?? "~");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState("Loading filesystem…");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const spawn = useKernelStore((state) => state.spawn);
  const setProcessPath = useKernelStore((state) => state.setProcessPath);
  const osEvent = useKernelStore((state) => state.osEvent);
  const settleEvent = useKernelStore((state) => state.settleEvent);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);

  useEffect(() => {
    if (process.path) setPath(process.path);
  }, [process.path]);

  const refresh = useCallback(async () => {
    try {
      setEntries(await ls(path));
      setStatus("");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [path]);

  useEffect(() => {
    if (fileSystemStatus === "ready") void refresh();
    return watch((change) => {
      if (changeTouchesDirectory(change, path)) void refresh();
    });
  }, [fileSystemStatus, path, refresh]);

  const runMutation = async (
    verb: string,
    args: Record<string, unknown>,
    action: () => Promise<void>,
  ): Promise<boolean> => {
    const event = osEvent("human", verb, args);
    try {
      await action();
      settleEvent(event, true);
      setStatus("");
      return true;
    } catch (error) {
      const message = errorMessage(error);
      settleEvent(event, false, message);
      setStatus(message);
      return false;
    }
  };

  const openEntry = (entry: FileEntry) => {
    if (entry.kind === "directory") {
      setPath(entry.path);
      setProcessPath(process.pid, entry.path);
      osEvent("human", "fs_list", { path: entry.path });
      return;
    }
    if (!isTextFile(entry.path)) {
      setStatus(`verbos: unsupported text format: ${entry.path}`);
      return;
    }
    const editor = spawn("editor", { path: entry.path });
    osEvent("human", "editor_open_file", {
      path: entry.path,
      appId: "editor",
      pid: editor.pid,
    });
  };

  const createEntry = async (name: string, kind: "file" | "directory") => {
    let entryPath: string;
    try {
      entryPath = joinPath(path, name.trim());
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    const verb = kind === "file" ? "fs_write" : "fs_mkdir";
    const action = () => createFilesAppEntry(entryPath, kind);
    if (await runMutation(verb, { path: entryPath }, action)) {
      setPendingAction(null);
    }
  };

  const renameEntry = async (entry: FileEntry, name: string) => {
    if (name === entry.name) {
      setPendingAction(null);
      return;
    }
    let destination: string;
    try {
      destination = joinPath(path, name.trim());
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    if (await runMutation("fs_move", { from: entry.path, to: destination }, () =>
      mv(entry.path, destination, "human"),
    )) {
      setPendingAction(null);
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    if (await runMutation("fs_delete", { path: entry.path }, () => rm(entry.path, "human"))) {
      setPendingAction(null);
    }
  };

  const copyPath = async (entry: FileEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      setStatus(`Copied ${entry.path}`);
    } catch (error) {
      setStatus(`verbos: clipboard unavailable: ${errorMessage(error)}`);
    }
  };

  return (
    <section className="files-app">
      <header className="app-toolbar">
        <VerbHint verb="fs_list" arg={parentPath(path)}>
          <button
            className="app-button app-button--icon"
            type="button"
            disabled={path === "~"}
            aria-label="Go to parent folder"
            onClick={() => {
              const parent = parentPath(path);
              setPath(parent);
              setProcessPath(process.pid, parent);
              osEvent("human", "fs_list", { path: parent });
            }}
          >
            ↑
          </button>
        </VerbHint>
        <span className="app-path mono" title={path}>{path}</span>
        <VerbHint verb="fs_mkdir" arg={path}>
          <button
            className="app-button"
            type="button"
            onClick={() => setPendingAction({ kind: "create", entryKind: "directory", value: "" })}
          >
            New folder
          </button>
        </VerbHint>
      </header>

      {pendingAction ? (
        <form
          className="file-action-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (pendingAction.kind === "create") {
              void createEntry(pendingAction.value, pendingAction.entryKind);
            } else if (pendingAction.kind === "rename") {
              void renameEntry(pendingAction.entry, pendingAction.value);
            } else {
              void deleteEntry(pendingAction.entry);
            }
          }}
        >
          {pendingAction.kind === "delete" ? (
            <span className="file-action-bar__message">
              Delete {pendingAction.entry.name}
              {pendingAction.entry.kind === "directory" ? " and its contents" : ""}?
            </span>
          ) : (
            <VerbHint
              verb={pendingAction.kind === "create"
                ? pendingAction.entryKind === "file" ? "fs_write" : "fs_mkdir"
                : "fs_move"}
              arg={pendingAction.kind === "create" ? path : pendingAction.entry.path}
            >
              <input
                autoFocus
                aria-label={pendingAction.kind === "create"
                  ? `New ${pendingAction.entryKind} name`
                  : "New name"}
                value={pendingAction.value}
                onChange={(event) => setPendingAction({ ...pendingAction, value: event.target.value })}
                spellCheck={false}
              />
            </VerbHint>
          )}
          <VerbHint
            verb={
              pendingAction.kind === "create"
                ? pendingAction.entryKind === "file" ? "fs_write" : "fs_mkdir"
                : pendingAction.kind === "rename"
                  ? "fs_move"
                  : "fs_delete"
            }
          >
            <button className="app-button app-button--primary" type="submit">
              {pendingAction.kind === "create"
                ? pendingAction.entryKind === "file" ? "Create file" : "Create folder"
                : pendingAction.kind === "rename"
                  ? "Rename"
                  : "Delete"}
            </button>
          </VerbHint>
          <VerbHint
            verb={
              pendingAction.kind === "create"
                ? pendingAction.entryKind === "file" ? "fs_write" : "fs_mkdir"
                : pendingAction.kind === "rename"
                  ? "fs_move"
                  : "fs_delete"
            }
          >
            <button className="app-button" type="button" onClick={() => setPendingAction(null)}>
              Cancel
            </button>
          </VerbHint>
        </form>
      ) : null}

      <div
        className="file-list"
        role="list"
        aria-label={`Files in ${path}`}
        onContextMenu={(event) => {
          const target = event.target as Element;
          if (target.closest(".file-row")) return;
          showContextMenu(event, {
            label: `Files in ${path}`,
            items: [
              {
                label: "New file",
                verb: "fs_write",
                arg: path,
                onSelect: () => setPendingAction({ kind: "create", entryKind: "file", value: "" }),
              },
              {
                label: "New folder",
                verb: "fs_mkdir",
                arg: path,
                onSelect: () => setPendingAction({ kind: "create", entryKind: "directory", value: "" }),
              },
            ],
          });
        }}
      >
        {entries.map((entry) => (
          <div
            className="file-row"
            role="listitem"
            key={entry.path}
            onContextMenu={(event) => showContextMenu(event, {
              label: entry.name,
              items: [
                {
                  label: "Open",
                  verb: entry.kind === "directory" ? "fs_list" : "editor_open_file",
                  arg: entry.path,
                  onSelect: () => openEntry(entry),
                },
                { type: "separator" },
                {
                  label: "Rename…",
                  verb: "fs_move",
                  arg: entry.path,
                  onSelect: () => setPendingAction({ kind: "rename", entry, value: entry.name }),
                },
                {
                  label: "Delete",
                  verb: "fs_delete",
                  arg: entry.path,
                  onSelect: () => setPendingAction({ kind: "delete", entry }),
                },
                { type: "separator" },
                { label: "Copy path", onSelect: () => { void copyPath(entry); } },
              ],
            })}
          >
            <VerbHint verb={entry.kind === "directory" ? "fs_list" : "editor_open_file"} arg={entry.path}>
              <button
                className="file-row__open"
                type="button"
                onDoubleClick={() => openEntry(entry)}
              >
                <span className={`file-row__icon is-${entry.kind}`} aria-hidden="true" />
                <span className="file-row__name">{entry.name}</span>
                <span className="file-row__size mono">{formatSize(entry)}</span>
              </button>
            </VerbHint>
            <div className="file-row__actions">
              <VerbHint verb="fs_move" arg={entry.path}>
                <button
                  type="button"
                  aria-label={`Rename ${entry.name}`}
                  onClick={() => setPendingAction({ kind: "rename", entry, value: entry.name })}
                >
                  Rename
                </button>
              </VerbHint>
              <VerbHint verb="fs_delete" arg={entry.path}>
                <button
                  type="button"
                  aria-label={`Delete ${entry.name}`}
                  onClick={() => setPendingAction({ kind: "delete", entry })}
                >
                  Delete
                </button>
              </VerbHint>
            </div>
          </div>
        ))}
        {entries.length === 0 && status === "" ? (
          <p className="app-empty mono">EMPTY DIRECTORY</p>
        ) : null}
      </div>
      <footer className={`app-status mono${status.startsWith("verbos:") ? " is-error" : ""}`}>
        {status || `${entries.length} ITEM${entries.length === 1 ? "" : "S"}`}
      </footer>
    </section>
  );
}
