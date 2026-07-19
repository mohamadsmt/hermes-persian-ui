"use client";

import {
  Boxes,
  GitBranch,
  History,
  Moon,
  MoreHorizontal,
  PanelLeft,
  PanelRightOpen,
  Pin,
  PinOff,
  Settings,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { CapabilitySet } from "@/lib/hermes";
import type { ConnectionPhase } from "./ui-types";

type ChatHeaderProps = {
  locale: string;
  title: string;
  connection: ConnectionPhase;
  backendVersion?: string;
  capabilities?: CapabilitySet;
  running?: boolean;
  inspectorPinned?: boolean;
  labels: {
    openSessions: string;
    openWorkspace: string;
    settings: string;
    connected: string;
    connecting: string;
    reconnecting: string;
    disconnected: string;
    unavailable: string;
    theme: string;
    branch: string;
    compress: string;
    recovery: string;
    more: string;
    pinInspector: string;
    unpinInspector: string;
  };
  onOpenSessions: () => void;
  onOpenArtifacts: () => void;
  onBranch: () => Promise<void> | void;
  onCompress: () => Promise<void> | void;
  onRecovery?: () => void;
  onToggleInspectorPin?: () => void;
};

export function ChatHeader({
  locale,
  title,
  connection,
  backendVersion,
  capabilities,
  running,
  inspectorPinned,
  labels,
  onOpenSessions,
  onOpenArtifacts,
  onBranch,
  onCompress,
  onRecovery,
  onToggleInspectorPin,
}: ChatHeaderProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRootRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const statusLabel =
    connection === "connected"
      ? labels.connected
      : connection === "connecting"
        ? labels.connecting
        : connection === "reconnecting"
          ? labels.reconnecting
          : connection === "disconnected"
            ? labels.disconnected
            : labels.unavailable;

  function closeMore({ restoreFocus = false } = {}) {
    setMoreOpen(false);
    if (restoreFocus) requestAnimationFrame(() => moreTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!moreOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!moreRootRef.current?.contains(event.target as Node)) closeMore();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMore({ restoreFocus: true });
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  return (
    <header className="chat-header">
      <div className="chat-header__identity">
        <button
          type="button"
          className="icon-button chat-header__panel-trigger chat-header__sessions-trigger header-mobile-action"
          aria-label={labels.openSessions}
          onClick={onOpenSessions}
        >
          <PanelRightOpen aria-hidden="true" className="rtl-mirror" size={18} />
        </button>
        <h1 className="chat-header__title bidi-block" dir="auto">{title}</h1>
      </div>

      <div className="chat-header__controls">
        <div
          className={`connection-badge connection-badge--${connection}`}
          data-testid="connection-status"
          title={backendVersion ? `${statusLabel} · ${backendVersion}` : statusLabel}
          role="status"
        >
          <span aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>

        <button
          type="button"
          className="icon-button chat-header__panel-trigger chat-header__inspector-trigger"
          aria-label={labels.openWorkspace}
          onClick={onOpenArtifacts}
        >
          <PanelLeft aria-hidden="true" size={18} />
        </button>

        <div className="header-more" ref={moreRootRef}>
          <button
            ref={moreTriggerRef}
            type="button"
            className="icon-button"
            aria-label={labels.more}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            data-testid="header-more-trigger"
            onClick={() => setMoreOpen((current) => !current)}
          >
            <MoreHorizontal aria-hidden="true" size={19} />
          </button>
          {moreOpen ? (
            <div className="header-more__menu" role="menu" data-testid="header-more-menu">
              {capabilities?.branch ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMore();
                    void onBranch();
                  }}
                >
                  <GitBranch aria-hidden="true" size={16} />
                  <span>{labels.branch}</span>
                </button>
              ) : null}
              {capabilities?.compress ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMore();
                    void onCompress();
                  }}
                >
                  <Boxes aria-hidden="true" size={16} />
                  <span>{labels.compress}</span>
                </button>
              ) : null}
              {onRecovery ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMore();
                    onRecovery();
                  }}
                  disabled={running}
                >
                  <History aria-hidden="true" size={16} />
                  <span>{labels.recovery}</span>
                </button>
              ) : null}
              {onToggleInspectorPin ? (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={inspectorPinned ?? false}
                  onClick={() => {
                    closeMore();
                    onToggleInspectorPin();
                  }}
                >
                  {inspectorPinned ? <PinOff aria-hidden="true" size={16} /> : <Pin aria-hidden="true" size={16} />}
                  <span>{inspectorPinned ? labels.unpinInspector : labels.pinInspector}</span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                data-testid="theme-toggle"
                onClick={() => {
                  closeMore();
                  setTheme(resolvedTheme === "dark" ? "light" : "dark");
                }}
              >
                {resolvedTheme === "dark" ? <Sun aria-hidden="true" size={16} /> : <Moon aria-hidden="true" size={16} />}
                <span>{labels.theme}</span>
              </button>
              <Link href={`/${locale}/settings`} role="menuitem" onClick={() => closeMore()}>
                <Settings aria-hidden="true" size={16} />
                <span>{labels.settings}</span>
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
