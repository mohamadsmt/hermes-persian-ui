"use client";

import { useState, type FormEvent } from "react";

interface SessionActionDialogProps {
  busy?: boolean;
  cancelLabel: string;
  label: string;
  onClose: () => void;
  onSubmit: (value?: string) => Promise<void>;
  open: boolean;
  placeholder: string;
  submitLabel: string;
}

export function SessionActionDialog({
  busy,
  cancelLabel,
  label,
  onClose,
  onSubmit,
  open,
  placeholder,
  submitLabel,
}: SessionActionDialogProps) {
  const [value, setValue] = useState("");
  if (!open) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(value.trim() || undefined);
    setValue("");
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="session-action-title">
        <h3 id="session-action-title">{label}</h3>
        <form onSubmit={(event) => void submit(event)}>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            dir="auto"
            autoFocus
            disabled={busy}
          />
          <div className="modal__actions">
            <button type="button" className="button button--ghost" onClick={onClose} disabled={busy}>{cancelLabel}</button>
            <button type="submit" className="button button--primary" disabled={busy}>{submitLabel}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
