"use client";

import { ShieldAlert, TimerReset } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

import type { InteractivePrompt } from "./ui-types";

type PromptResponse =
  | { action: "approve-once" | "approve-always" | "deny" }
  | { action: "answer"; value: string }
  | { action: "secret"; value: string }
  | { action: "sudo"; value: string };

type PromptCardProps = {
  prompt: InteractivePrompt;
  now?: number;
  labels: {
    approveOnce: string;
    approveAlways: string;
    deny: string;
    submit: string;
    cancel: string;
    expired: string;
    secretPlaceholder: string;
    sudoPlaceholder: string;
  };
  onRespond: (prompt: InteractivePrompt, response: PromptResponse) => Promise<void>;
};

export function PromptCard({ prompt, labels, onRespond, now }: PromptCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expired, setExpired] = useState(
    Boolean(prompt.expiresAt && (now === undefined || Date.parse(prompt.expiresAt) <= now)),
  );

  useEffect(() => {
    if (!prompt.expiresAt) return;
    const remaining = Date.parse(prompt.expiresAt) - (now ?? Date.now());
    const activateTimer = remaining > 0 ? window.setTimeout(() => setExpired(false), 0) : undefined;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => {
      if (activateTimer !== undefined) window.clearTimeout(activateTimer);
      window.clearTimeout(timer);
    };
  }, [now, prompt.expiresAt]);

  async function respond(response: PromptResponse) {
    if (submitting || expired) return;
    setSubmitting(true);
    try {
      await onRespond(prompt, response);
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setSubmitting(false);
    }
  }

  function submitValue(event: FormEvent) {
    event.preventDefault();
    const value = inputRef.current?.value ?? "";
    if (!value) return;
    void respond(
      prompt.kind === "clarification"
        ? { action: "answer", value }
        : prompt.kind === "sudo"
          ? { action: "sudo", value }
          : { action: "secret", value },
    );
  }

  if (expired) {
    return (
      <article className="prompt-card prompt-card--expired" aria-live="polite">
        <TimerReset aria-hidden="true" size={19} />
        <span>{labels.expired}</span>
      </article>
    );
  }

  return (
    <article
      className="prompt-card"
      role={prompt.kind === "approval" ? "alertdialog" : "dialog"}
      aria-labelledby={`prompt-title-${prompt.id}`}
      aria-describedby={prompt.description ? `prompt-description-${prompt.id}` : undefined}
      data-testid={prompt.kind === "approval" ? "approval-dialog" : `${prompt.kind}-dialog`}
    >
      <header>
        <ShieldAlert aria-hidden="true" size={20} />
        <h3 id={`prompt-title-${prompt.id}`} className="bidi-block">
          {prompt.title}
        </h3>
      </header>
      {prompt.description ? (
        <p id={`prompt-description-${prompt.id}`} className="bidi-block">
          {prompt.description}
        </p>
      ) : null}

      {prompt.kind === "approval" ? (
        <div className="prompt-card__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={submitting}
            data-testid="approval-approve"
            onClick={() => void respond({ action: "approve-once" })}
          >
            {labels.approveOnce}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={submitting}
            onClick={() => void respond({ action: "approve-always" })}
          >
            {labels.approveAlways}
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={submitting}
            data-testid="approval-deny"
            autoFocus
            onClick={() => void respond({ action: "deny" })}
          >
            {labels.deny}
          </button>
        </div>
      ) : prompt.options?.length ? (
        <div className="prompt-card__choices">
          {prompt.options.map((option) => (
            <button
              type="button"
              className="button button--secondary"
              disabled={submitting}
              key={option.value}
              onClick={() => void respond({ action: "answer", value: option.value })}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className="button button--ghost"
            disabled={submitting}
            onClick={() => void respond({ action: "answer", value: "" })}
          >
            {labels.cancel}
          </button>
        </div>
      ) : (
        <form onSubmit={submitValue} className="prompt-card__form">
          <input
            ref={inputRef}
            type={prompt.kind === "clarification" ? "text" : "password"}
            autoComplete="off"
            dir="auto"
            disabled={submitting}
            placeholder={
              prompt.kind === "sudo" ? labels.sudoPlaceholder : labels.secretPlaceholder
            }
          />
          <button type="submit" className="button button--primary" disabled={submitting}>
            {labels.submit}
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={submitting}
            onClick={() =>
              void respond(
                prompt.kind === "clarification"
                  ? { action: "answer", value: "" }
                  : prompt.kind === "sudo"
                    ? { action: "sudo", value: "" }
                    : { action: "secret", value: "" },
              )
            }
          >
            {labels.cancel}
          </button>
        </form>
      )}
    </article>
  );
}

export type { PromptResponse };
