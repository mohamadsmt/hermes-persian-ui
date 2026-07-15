"use client";

import { History, LoaderCircle, RotateCcw, X } from "lucide-react";

import type { RollbackCheckpoint, RollbackDiff } from "@/lib/hermes";

interface RecoveryDialogProps {
  busy?: boolean;
  checkpoints: RollbackCheckpoint[];
  diff?: RollbackDiff;
  error?: string;
  labels: {
    title: string;
    undo: string;
    rollback: string;
    select: string;
    warning: string;
    close: string;
    empty: string;
  };
  loading?: boolean;
  onClose: () => void;
  onRestore: (checkpoint: RollbackCheckpoint) => Promise<void>;
  onSelect: (checkpoint: RollbackCheckpoint) => Promise<void>;
  onUndo: () => Promise<void>;
  open: boolean;
  selected?: RollbackCheckpoint;
}

export function RecoveryDialog({
  busy,
  checkpoints,
  diff,
  error,
  labels,
  loading,
  onClose,
  onRestore,
  onSelect,
  onUndo,
  open,
  selected,
}: RecoveryDialogProps) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <header className="recovery-modal__header">
          <h3 id="recovery-title"><History aria-hidden="true" size={19} />{labels.title}</h3>
          <button type="button" className="icon-button" aria-label={labels.close} onClick={onClose} disabled={busy}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <button type="button" className="button button--secondary" onClick={() => void onUndo()} disabled={busy}>
          <RotateCcw aria-hidden="true" size={16} />
          {labels.undo}
        </button>

        <div className="recovery-modal__body">
          <div className="recovery-checkpoints" aria-label={labels.select}>
            <strong>{labels.rollback}</strong>
            {loading ? <LoaderCircle aria-hidden="true" className="spin" size={20} /> : null}
            {!loading && !checkpoints.length ? <p>{labels.empty}</p> : null}
            {checkpoints.map((checkpoint) => (
              <button
                key={checkpoint.hash}
                type="button"
                className={selected?.hash === checkpoint.hash ? "recovery-checkpoint recovery-checkpoint--active" : "recovery-checkpoint"}
                onClick={() => void onSelect(checkpoint)}
                disabled={busy}
              >
                <bdi dir="ltr">{checkpoint.hash.slice(0, 10)}</bdi>
                <span className="bidi-block">{checkpoint.message || labels.select}</span>
                {checkpoint.timestamp ? <time dir="ltr">{checkpoint.timestamp}</time> : null}
              </button>
            ))}
          </div>
          <div className="recovery-preview">
            {error ? <p className="danger-text" role="alert">{error}</p> : null}
            {diff?.stat ? <pre dir="ltr">{diff.stat}</pre> : null}
            {diff ? <pre className="recovery-diff" dir="ltr">{diff.diff}</pre> : <p>{labels.select}</p>}
          </div>
        </div>

        {selected ? (
          <div className="recovery-modal__restore">
            <p className="danger-text">{labels.warning}</p>
            <button type="button" className="button button--danger" onClick={() => void onRestore(selected)} disabled={busy || !diff}>
              {busy ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <RotateCcw aria-hidden="true" size={16} />}
              {labels.rollback}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
