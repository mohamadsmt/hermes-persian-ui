"use client";

import {
  Boxes,
  GitBranch,
  History,
  Menu,
  Moon,
  PanelLeft,
  Settings,
  Sparkles,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";

import {
  REASONING_EFFORTS,
  type ConnectionPhase,
  type KnownReasoningEffort,
  type SessionModelSettings,
} from "./ui-types";
import type { CapabilitySet, ModelOption } from "@/lib/hermes";

const REASONING_LABELS: Record<KnownReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

type ChatHeaderProps = {
  locale: string;
  title: string;
  connection: ConnectionPhase;
  backendVersion?: string;
  models: ModelOption[];
  modelSettings: SessionModelSettings;
  profiles: string[];
  activeProfile?: string;
  capabilities?: CapabilitySet;
  running?: boolean;
  labels: {
    appName: string;
    openSessions: string;
    openWorkspace: string;
    settings: string;
    connected: string;
    connecting: string;
    reconnecting: string;
    disconnected: string;
    unavailable: string;
    model: string;
    profile: string;
    reasoning: string;
    fastMode: string;
    theme: string;
    branch: string;
    compress: string;
    recovery: string;
  };
  onOpenSessions: () => void;
  onOpenArtifacts: () => void;
  onModelChange: (model: ModelOption) => Promise<void> | void;
  onProfileChange: (profile: string) => Promise<void> | void;
  onReasoningChange: (reasoning: string) => Promise<void> | void;
  onFastChange?: (fast: boolean) => Promise<void> | void;
  onBranch: () => Promise<void> | void;
  onCompress: () => Promise<void> | void;
  onRecovery?: () => void;
};

export function ChatHeader({
  locale,
  title,
  connection,
  backendVersion,
  models,
  modelSettings,
  profiles,
  activeProfile,
  capabilities,
  running,
  labels,
  onOpenSessions,
  onOpenArtifacts,
  onModelChange,
  onProfileChange,
  onReasoningChange,
  onFastChange,
  onBranch,
  onCompress,
  onRecovery,
}: ChatHeaderProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const currentModel =
    models.find(
      (option) =>
        option.id === modelSettings.model &&
        (!modelSettings.provider || option.provider === modelSettings.provider),
    ) ?? models.find((option) => option.current);
  const currentReasoning = modelSettings.reasoning ?? "";
  const hasAuthoritativeReasoning = currentReasoning.length > 0;
  const hasKnownReasoning = REASONING_EFFORTS.some(
    (reasoning) => reasoning === currentReasoning,
  );
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

  return (
    <header className="chat-header">
      <div className="chat-header__identity">
        <button
          type="button"
          className="icon-button header-mobile-action"
          aria-label={labels.openSessions}
          onClick={onOpenSessions}
        >
          <Menu aria-hidden="true" size={21} />
        </button>
        <span className="app-mark" aria-hidden="true">
          <Sparkles size={18} />
        </span>
        <div>
          <span className="chat-header__brand">{labels.appName}</span>
          <h1 className="chat-header__title bidi-block">{title}</h1>
        </div>
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

        {capabilities?.models && models.length ? (
          <label className="header-select model-select">
            <span className="sr-only">{labels.model}</span>
            <select
              data-testid="model-picker"
              value={currentModel ? `${currentModel.provider}:${currentModel.id}` : ""}
              onChange={(event) => {
                const option = models.find(
                  (item) => `${item.provider}:${item.id}` === event.target.value,
                );
                if (option) void onModelChange(option);
              }}
              disabled={running}
              dir="ltr"
            >
              {models.map((model) => (
                <option
                  value={`${model.provider}:${model.id}`}
                  key={`${model.provider}:${model.id}`}
                  disabled={!model.authenticated}
                >
                  {model.id} · {model.providerName}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {profiles.length > 1 ? (
          <label className="header-select profile-select">
            <span className="sr-only">{labels.profile}</span>
            <select
              value={activeProfile ?? profiles[0]}
              onChange={(event) => void onProfileChange(event.target.value)}
              disabled={running}
            >
              {profiles.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {currentModel?.supportsReasoning ? (
          <label className="header-select reasoning-select">
            <span className="sr-only">{labels.reasoning}</span>
            <select
              data-testid="reasoning-picker"
              value={currentReasoning}
              onChange={(event) => void onReasoningChange(event.target.value)}
              disabled={running || !hasAuthoritativeReasoning}
              dir="ltr"
            >
              {!hasAuthoritativeReasoning ? (
                <option value="">—</option>
              ) : null}
              {hasAuthoritativeReasoning && !hasKnownReasoning ? (
                <option value={currentReasoning}>{currentReasoning}</option>
              ) : null}
              {REASONING_EFFORTS.map((reasoning) => (
                <option key={reasoning} value={reasoning}>
                  {REASONING_LABELS[reasoning]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {currentModel?.supportsFast && onFastChange ? (
          <label className="fast-toggle" title={labels.fastMode}>
            <input
              type="checkbox"
              checked={modelSettings.fast ?? false}
              onChange={(event) => void onFastChange(event.target.checked)}
              disabled={running}
            />
            <span>{labels.fastMode}</span>
          </label>
        ) : null}

        {capabilities?.branch ? (
          <button type="button" className="icon-button header-wide-action" aria-label={labels.branch} onClick={() => void onBranch()}>
            <GitBranch aria-hidden="true" size={19} />
          </button>
        ) : null}
        {capabilities?.compress ? (
          <button type="button" className="icon-button header-wide-action" aria-label={labels.compress} onClick={() => void onCompress()}>
            <Boxes aria-hidden="true" size={19} />
          </button>
        ) : null}
        {onRecovery ? (
          <button type="button" className="icon-button header-wide-action" aria-label={labels.recovery} onClick={onRecovery} disabled={running}>
            <History aria-hidden="true" size={19} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button"
          aria-label={labels.theme}
          data-testid="theme-toggle"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {resolvedTheme === "dark" ? <Sun aria-hidden="true" size={19} /> : <Moon aria-hidden="true" size={19} />}
        </button>
        <Link className="icon-button" href={`/${locale}/settings`} aria-label={labels.settings}>
          <Settings aria-hidden="true" size={19} />
        </Link>
        <button
          type="button"
          className="icon-button header-mobile-action"
          aria-label={labels.openWorkspace}
          onClick={onOpenArtifacts}
        >
          <PanelLeft aria-hidden="true" size={20} />
        </button>
      </div>
    </header>
  );
}
