import { VerbHint } from "../../desktop/VerbHint";

type ConflictBarProps = {
  path: string;
  onReload: () => void;
  onKeepMine: () => void;
};

export function ConflictBar({ path, onReload, onKeepMine }: ConflictBarProps) {
  return (
    <div className="file-conflict" role="status">
      <span className="file-conflict__message mono">Changed on disk</span>
      <span className="file-conflict__actions">
        <VerbHint verb="fs_read" arg={path}>
          <button type="button" onClick={onReload}>Reload</button>
        </VerbHint>
        <VerbHint verb="fs_write" arg={path}>
          <button type="button" onClick={onKeepMine}>Keep mine</button>
        </VerbHint>
      </span>
    </div>
  );
}
