"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Check, Copy, LoaderCircle, Sparkles, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MarkdownRenderer } from "./markdown-renderer";
import { PromptCard, type PromptResponse } from "./prompt-card";
import { ToolCard } from "./tool-card";
import type { InteractivePrompt, TranscriptItem } from "./ui-types";
import type { SpeechPlayback } from "./voice";

type TranscriptProps = {
  items: TranscriptItem[];
  locale: string;
  activeTitle?: string;
  emptyActionLabel?: string;
  ttsEnabled?: boolean;
  labels: {
    emptyTitle: string;
    emptyBody: string;
    you: string;
    assistant: string;
    system: string;
    tool: string;
    copy: string;
    copied: string;
    reasoning: string;
    jumpLatest: string;
    interrupted: string;
    speak: string;
    stopSpeaking: string;
    speechPreparing: string;
    toolRunning: string;
    toolComplete: string;
    toolFailed: string;
    toolCancelled: string;
    toolQueued: string;
    toolInput: string;
    toolOutput: string;
    toolDetails: string;
    approveOnce: string;
    approveAlways: string;
    deny: string;
    submit: string;
    cancel: string;
    expired: string;
    secretPlaceholder: string;
    sudoPlaceholder: string;
  };
  onPromptResponse: (
    prompt: InteractivePrompt,
    response: PromptResponse,
  ) => Promise<void>;
  onEmptyAction?: () => void;
  onSpeak?: (text: string) => Promise<SpeechPlayback>;
  onSpeechError?: (message: string) => void;
};

function formatTimestamp(value: string | undefined, locale: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return undefined;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function Transcript({
  items,
  locale,
  activeTitle,
  emptyActionLabel,
  ttsEnabled,
  labels,
  onPromptResponse,
  onEmptyAction,
  onSpeak,
  onSpeechError,
}: TranscriptProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const userScrollGenerationRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const lastSignature = useMemo(() => {
    const last = items.at(-1);
    if (!last) return "empty";
    if (last.kind === "message") return `${last.key}:${last.message.content.length}:${last.message.status}`;
    if (last.kind === "reasoning") return `${last.key}:${last.reasoning.content.length}:${last.reasoning.status}`;
    if (last.kind === "tool") {
      const outputLength = typeof last.tool.output === "string"
        ? last.tool.output.length
        : JSON.stringify(last.tool.output ?? "").length;
      return `${last.key}:${last.tool.status}:${last.tool.progress}:${outputLength}`;
    }
    return `${last.key}:${last.prompt.submitted}:${last.prompt.expiresAt}`;
  }, [items]);

  // TanStack Virtual deliberately returns stateful functions; this component
  // must stay outside React Compiler memoization to preserve its scroll model.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => {
      const item = items[index];
      if (item?.kind === "message") return Math.max(110, Math.min(420, item.message.content.length * 0.32));
      if (item?.kind === "reasoning") return Math.max(70, Math.min(220, item.reasoning.content.length * 0.18));
      return 180;
    },
    overscan: 7,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const viewport = viewportRef.current;
      if (!items.length || !viewport) return;
      // The transcript's end padding includes the measured composer height.
      // Scrolling to the physical bottom therefore keeps the final item above
      // the overlay; virtualizer alignment only knows about the item itself.
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      followLatestRef.current = true;
      setShowJump(false);
    },
    [items.length],
  );

  useEffect(() => {
    if (!followLatestRef.current) return;
    const frame = requestAnimationFrame(() => scrollToLatest("auto"));
    return () => cancelAnimationFrame(frame);
  }, [lastSignature, scrollToLatest]);

  const handleExpandedChange = useCallback((source: Element) => {
    const virtualItem = source.closest(".transcript-virtual-item") as HTMLElement | null;
    const wasFollowingLatest = followLatestRef.current;
    const userScrollGeneration = userScrollGenerationRef.current;
    requestAnimationFrame(() => {
      if (virtualItem) virtualizer.measureElement(virtualItem);
      if (wasFollowingLatest && userScrollGeneration === userScrollGenerationRef.current) {
        // Measuring can itself emit a scroll event while the virtual total is
        // being replaced. Honour the pre-expansion anchor unless the user has
        // actually initiated a new scroll in the meantime, then settle once
        // more after React receives the virtualizer's updated size.
        requestAnimationFrame(() => {
          scrollToLatest("auto");
          requestAnimationFrame(() => {
            if (userScrollGeneration === userScrollGenerationRef.current) scrollToLatest("auto");
          });
        });
      }
    });
  }, [scrollToLatest, virtualizer]);

  const markUserScrollIntent = useCallback(() => {
    userScrollGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const composer = viewport
      ?.closest(".chat-main")
      ?.querySelector<HTMLElement>(".composer-wrap");
    if (!viewport || !composer || typeof ResizeObserver === "undefined") return;

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      const wasFollowingLatest = followLatestRef.current;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        if (wasFollowingLatest && followLatestRef.current) {
          // The composer's new inset contributes to scrollHeight. Scrolling to
          // that physical bottom keeps the final item above the overlay instead
          // of aligning it to the obscured viewport edge.
          viewport.scrollTop = viewport.scrollHeight;
          followLatestRef.current = true;
          setShowJump(false);
          return;
        }
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        setShowJump(distance >= 96);
      });
    });
    observer.observe(composer);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  function handleScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const following = distance < 96;
    followLatestRef.current = following;
    setShowJump(!following);
  }

  return (
    <main className="transcript-panel" aria-label={activeTitle}>
      <div
        ref={viewportRef}
        className="transcript-viewport"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        data-testid="transcript"
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
      >
        {!items.length ? (
          <div className="transcript-empty">
            <span className="transcript-empty__icon">
              <Sparkles aria-hidden="true" size={25} />
            </span>
            <h2>{labels.emptyTitle}</h2>
            <p>{labels.emptyBody}</p>
            {emptyActionLabel && onEmptyAction ? (
              <button type="button" className="button button--primary" onClick={onEmptyAction}>
                {emptyActionLabel}
              </button>
            ) : null}
          </div>
        ) : (
          <div
            className="transcript-virtual-space"
            style={{ blockSize: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = items[virtualItem.index];
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="transcript-virtual-item"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {item.kind === "message" ? (
                    <MessageBubble
                      message={item.message}
                      locale={locale}
                      labels={labels}
                      ttsEnabled={ttsEnabled}
                      onSpeak={onSpeak}
                      onSpeechError={onSpeechError}
                    />
                  ) : item.kind === "reasoning" ? (
                    <ReasoningDisclosure
                      reasoning={item.reasoning}
                      locale={locale}
                      label={labels.reasoning}
                      onExpandedChange={handleExpandedChange}
                    />
                  ) : item.kind === "tool" ? (
                    <ToolCard
                      tool={item.tool}
                      onExpandedChange={(_open, trigger) => handleExpandedChange(trigger)}
                      labels={{
                        running: labels.toolRunning,
                        complete: labels.toolComplete,
                        failed: labels.toolFailed,
                        cancelled: labels.toolCancelled,
                        queued: labels.toolQueued,
                        input: labels.toolInput,
                        output: labels.toolOutput,
                        details: labels.toolDetails,
                      }}
                    />
                  ) : (
                    <PromptCard
                      prompt={item.prompt}
                      onRespond={onPromptResponse}
                      labels={{
                        approveOnce: labels.approveOnce,
                        approveAlways: labels.approveAlways,
                        deny: labels.deny,
                        submit: labels.submit,
                        cancel: labels.cancel,
                        expired: labels.expired,
                        secretPlaceholder: labels.secretPlaceholder,
                        sudoPlaceholder: labels.sudoPlaceholder,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {showJump ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => scrollToLatest()}
          data-testid="jump-latest"
        >
          <ArrowDown aria-hidden="true" size={17} />
          {labels.jumpLatest}
        </button>
      ) : null}
    </main>
  );
}

function ReasoningDisclosure({
  reasoning,
  locale,
  label,
  onExpandedChange,
}: {
  reasoning: Extract<TranscriptItem, { kind: "reasoning" }>["reasoning"];
  locale: string;
  label: string;
  onExpandedChange: (source: Element) => void;
}) {
  const timestamp = formatTimestamp(reasoning.createdAt, locale);
  return (
    <details
      className={`reasoning-card reasoning-card--${reasoning.status ?? "complete"}`}
      data-testid="reasoning"
      data-status={reasoning.status ?? "complete"}
      onToggle={(event) => onExpandedChange(event.currentTarget)}
    >
      <summary>
        <span>{label}</span>
        {reasoning.status === "streaming" ? (
          <LoaderCircle aria-hidden="true" className="spin" size={15} />
        ) : null}
        {timestamp ? <time dateTime={reasoning.createdAt}>{timestamp}</time> : null}
      </summary>
      <div className="reasoning-card__content">
        <MarkdownRenderer
          source={reasoning.content}
          isStreaming={reasoning.status === "streaming"}
          copyable={false}
        />
      </div>
    </details>
  );
}

function MessageBubble({
  message,
  locale,
  labels,
  ttsEnabled,
  onSpeak,
  onSpeechError,
}: {
  message: Extract<TranscriptItem, { kind: "message" }>["message"];
  locale: string;
  labels: TranscriptProps["labels"];
  ttsEnabled?: boolean;
  onSpeak?: TranscriptProps["onSpeak"];
  onSpeechError?: TranscriptProps["onSpeechError"];
}) {
  const [copied, setCopied] = useState(false);
  const [speechState, setSpeechState] = useState<"idle" | "preparing" | "playing">("idle");
  const playbackRef = useRef<SpeechPlayback | null>(null);
  const roleLabel =
    message.role === "user"
      ? labels.you
      : message.role === "assistant"
        ? labels.assistant
        : message.role === "system"
          ? labels.system
          : labels.tool;
  const timestamp = formatTimestamp(message.createdAt, locale);

  async function copyRaw() {
    await navigator.clipboard.writeText(message.rawSource);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  }

  useEffect(() => () => playbackRef.current?.stop(), []);

  async function toggleSpeech() {
    if (playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
      setSpeechState("idle");
      return;
    }
    if (!onSpeak || !message.rawSource.trim()) return;
    setSpeechState("preparing");
    try {
      const playback = await onSpeak(message.rawSource);
      playbackRef.current = playback;
      setSpeechState("playing");
      await playback.finished;
      if (playbackRef.current === playback) {
        playbackRef.current = null;
        setSpeechState("idle");
      }
    } catch (error) {
      playbackRef.current = null;
      setSpeechState("idle");
      onSpeechError?.(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <article
      className={`message message--${message.role} message--${message.status ?? "complete"}`}
      data-testid="message"
      data-role={message.role}
      data-status={message.status ?? "complete"}
    >
      <header className="message__header">
        <span>{roleLabel}</span>
        {message.model ? (
          <bdi className="technical-inline" dir="ltr">
            {message.model}
          </bdi>
        ) : null}
        {timestamp ? <time dateTime={message.createdAt}>{timestamp}</time> : null}
      </header>
      {message.reasoning ? (
        <details className="message__reasoning">
          <summary>{labels.reasoning}</summary>
          <MarkdownRenderer source={message.reasoning} />
        </details>
      ) : null}
      <div className="message__content">
        <MarkdownRenderer
          source={message.content}
          isStreaming={message.status === "streaming"}
          copyable={false}
        />
      </div>
      <footer className="message__footer">
        {message.status === "interrupted" ? (
          <span className="message__interrupted">{labels.interrupted}</span>
        ) : null}
        {ttsEnabled && onSpeak && message.role === "assistant" && message.status !== "streaming" && message.rawSource.trim() ? (
          <button
            type="button"
            className="message-copy"
            aria-label={
              speechState === "preparing"
                ? labels.speechPreparing
                : speechState === "playing"
                  ? labels.stopSpeaking
                  : labels.speak
            }
            aria-pressed={speechState === "playing"}
            data-testid="speak-message"
            onClick={() => void toggleSpeech()}
            disabled={speechState === "preparing"}
          >
            {speechState === "preparing" ? (
              <LoaderCircle aria-hidden="true" className="spin" size={15} />
            ) : speechState === "playing" ? (
              <Square aria-hidden="true" size={14} />
            ) : (
              <Volume2 aria-hidden="true" size={15} />
            )}
            {speechState === "preparing"
              ? labels.speechPreparing
              : speechState === "playing"
                ? labels.stopSpeaking
                : labels.speak}
          </button>
        ) : null}
        <button
          type="button"
          className="message-copy"
          aria-label={copied ? labels.copied : labels.copy}
          data-testid="copy-message"
          onClick={() => void copyRaw()}
        >
          {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
          {copied ? labels.copied : labels.copy}
        </button>
      </footer>
    </article>
  );
}
