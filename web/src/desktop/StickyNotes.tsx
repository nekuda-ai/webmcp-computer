import { useCallback, useEffect, useState } from "react";
import { Rnd } from "react-rnd";
import { FileSystemError, readFile, watch } from "../kernel/fs";
import { STICKY_NOTE_HEIGHT, STICKY_NOTE_WIDTH } from "../kernel/stickyNotes";
import { useKernelStore } from "../kernel/store";
import type { StickyNoteRecord } from "../kernel/types";
import { VerbHint } from "./VerbHint";

function titleFor(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
}

function StickyNote({ note }: { note: StickyNoteRecord }) {
  const [content, setContent] = useState("");
  const moveStickyNote = useKernelStore((state) => state.moveStickyNote);
  const setNoteSticky = useKernelStore((state) => state.setNoteSticky);
  const osEvent = useKernelStore((state) => state.osEvent);

  const refresh = useCallback(async () => {
    try {
      setContent(await readFile(note.path));
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") {
        setNoteSticky(note.path, false);
        return;
      }
      setContent(error instanceof Error ? error.message : String(error));
    }
  }, [note.path, setNoteSticky]);

  useEffect(() => {
    void refresh();
    return watch((change) => {
      if ((change.path === note.path && change.operation === "delete") || change.from === note.path) {
        setNoteSticky(note.path, false);
        return;
      }
      if (change.path === note.path) void refresh();
    });
  }, [note.path, refresh, setNoteSticky]);

  return (
    <Rnd
      className="sticky-note"
      bounds="parent"
      dragHandleClassName="sticky-note__handle"
      cancel=".sticky-note__action"
      enableResizing={false}
      size={{ width: STICKY_NOTE_WIDTH, height: STICKY_NOTE_HEIGHT }}
      position={{ x: note.x, y: note.y }}
      onDragStop={(_event, data) => {
        const moved = moveStickyNote(note.path, data.x, data.y);
        if (moved) osEvent("human", "notes_stick", { path: note.path, sticky: true, x: moved.x, y: moved.y });
      }}
    >
      <article aria-label={`Sticky note ${titleFor(note.path)}`}>
        <header className="sticky-note__handle">
          <span>{titleFor(note.path)}</span>
          <VerbHint verb="notes_stick" arg={`${note.path}: false`}>
            <button
              className="sticky-note__action"
              type="button"
              aria-label={`Unstick ${titleFor(note.path)}`}
              onClick={() => {
                setNoteSticky(note.path, false);
                osEvent("human", "notes_stick", { path: note.path, sticky: false });
              }}
            >
              ×
            </button>
          </VerbHint>
        </header>
        <pre>{content}</pre>
      </article>
    </Rnd>
  );
}

export function StickyNotes() {
  const notes = useKernelStore((state) => state.stickyNotes);
  return (
    <div className="sticky-notes" aria-label="Sticky notes">
      {notes.map((note) => <StickyNote key={note.path} note={note} />)}
    </div>
  );
}
