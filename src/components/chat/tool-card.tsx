"use client";

import {
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Clock3,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { redactSensitive, safeJson } from "@/lib/security/redact";
import type { ToolRun } from "./ui-types";

type ToolCardProps = {
  tool: ToolRun;
  onExpandedChange?: (open: boolean, trigger: HTMLElement) => void;
  labels: {
    running: string;
    complete: string;
    failed: string;
    cancelled: string;
    queued: string;
    input: string;
    output: string;
    details: string;
  };
};

const statusIcon = {
  queued: Clock3,
  running: LoaderCircle,
  complete: CheckCircle2,
  failed: TriangleAlert,
  cancelled: CircleStop,
};

function formatToolValue(value: unknown): string {
  if (typeof value !== "string") return safeJson(value);

  const trimmed = value.trim();
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") return safeJson(parsed);
    } catch {
      // Plain command output is intentionally rendered as-is below.
    }
  }

  return String(redactSensitive(value));
}

export function ToolCard({ tool, labels, onExpandedChange }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);
  const expandedCallbackRef = useRef(onExpandedChange);
  const mountedRef = useRef(false);
  const Icon = statusIcon[tool.status];

  useLayoutEffect(() => {
    expandedCallbackRef.current = onExpandedChange;
  });

  useLayoutEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (headerRef.current) expandedCallbackRef.current?.(open, headerRef.current);
  }, [open]);

  return (
    <article
      className="tool-card"
      data-testid="tool-card"
      data-status={tool.status}
      aria-busy={tool.status === "running"}
    >
      <button
        ref={headerRef}
        type="button"
        className="tool-card__header"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="tool-card__identity">
          <Icon
            aria-hidden="true"
            className={tool.status === "running" ? "spin" : undefined}
            size={18}
          />
          <bdi dir="ltr" className="technical-inline">
            {tool.name}
          </bdi>
        </span>
        <span className="tool-card__meta">
          {tool.durationSeconds !== undefined ? (
            <bdi dir="ltr" className="technical-inline">{tool.durationSeconds.toFixed(1)}s</bdi>
          ) : null}
          <span className={`status-pill status-pill--${tool.status}`}>
            {labels[tool.status]}
          </span>
          <ChevronDown aria-label={labels.details} size={17} />
        </span>
      </button>

      {tool.progress !== undefined && tool.status === "running" ? (
        <div
          className="tool-card__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={tool.progress}
        >
          <span style={{ inlineSize: `${Math.max(0, Math.min(100, tool.progress))}%` }} />
        </div>
      ) : null}

      {tool.summary || tool.progressText ? (
        <p className="tool-card__summary bidi-block">{tool.summary ?? tool.progressText}</p>
      ) : null}

      {open ? (
        <div className="tool-card__body">
          {tool.input !== undefined ? (
            <section>
              <h4>{labels.input}</h4>
              <pre dir="ltr" className="technical-block">
                <code>{formatToolValue(tool.input)}</code>
              </pre>
            </section>
          ) : null}
          {tool.output !== undefined ? (
            <section>
              <h4>{labels.output}</h4>
              <pre dir="ltr" className="technical-block">
                <code>{formatToolValue(tool.output)}</code>
              </pre>
            </section>
          ) : null}
          {tool.inlineDiff ? (
            <section>
              <h4>Diff</h4>
              <pre dir="ltr" className="technical-block">
                <code>{String(redactSensitive(tool.inlineDiff))}</code>
              </pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
