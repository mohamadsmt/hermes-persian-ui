"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  contentToText,
  pendingPromptFromEvent,
  toolActivityFromEvent,
  type BootstrapInfo,
  type CapabilitySet,
  type ContextBreakdown,
  type HermesEvent,
  type HermesTransport,
  type Message,
  type ModelOption,
  type PendingPrompt,
  type ProjectTreePayload,
  type RollbackCheckpoint,
  type RollbackDiff,
  type SessionIdentity,
  type SessionSnapshot,
  type SessionSummary as HermesSessionSummary,
  type UsageStats,
  type WorkspaceEntry,
  isMethodNotFound,
} from "@/lib/hermes";
import { chatSessionScopeKey, useChatUiStore } from "@/store/chat-store";
import { useSessionRuntimeStore } from "@/store/session-runtime-store";
import { useHermesWorkspace } from "@/components/workspace/workspace-provider";

import { ArtifactRail } from "./artifact-rail";
import { ChatHeader } from "./chat-header";
import {
  findCommandOption,
  getWebCommandUnavailableReason,
  isWebCommandUnavailable,
  normalizeCommandCatalog,
  normalizeSlashCompletions,
  parseSlashCommand,
  resolveCanonicalCommand,
  type NormalizedCommandCatalog,
} from "./command-catalog";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { NewSessionDialog, type NewSessionSubmission } from "./new-session-dialog";
import type { PromptResponse } from "./prompt-card";
import { ProjectSessionBrowser, sessionsOutsideRenderedProjects } from "./project-session-browser";
import { SessionRail } from "./session-rail";
import { RecoveryDialog } from "./recovery-dialog";
import { SessionActionDialog } from "./session-action-dialog";
import { Transcript } from "./transcript";
import { WorkspaceFilesRail } from "./workspace-files-rail";
import {
  classifyToolOutcome,
  messagesToTranscript,
  parseToolArguments,
  reconcileSessionHistory,
  reduceTranscript,
} from "./transcript-state";
import { blobToDataUrl, synthesizeSpeech, transcribeAudioBlob, type SpeechPlayback } from "./voice";
import { REASONING_EFFORTS } from "./ui-types";
import type {
  Artifact,
  ChatMessage,
  ComposerAttachment,
  ConnectionPhase,
  InteractivePrompt,
  SessionSummary,
  SlashCompletion,
  ToolRun,
  TranscriptItem,
} from "./ui-types";

type ChatShellProps = {
  active?: boolean;
  initialProfile?: string;
  profileRequiredError?: boolean;
  storedSessionId?: string;
};

type Notice = { kind: "error" | "warning" | "info"; message: string };

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const HISTORY_MUTATING_COMMANDS = new Set([
  "undo",
  "retry",
  "rollback",
  "snapshot",
  "compress",
  "history",
]);
const CATALOG_MUTATING_COMMANDS = new Set([
  "reload",
  "reload-mcp",
  "reload-skills",
  "skills",
  "plugins",
  "bundles",
  "learn",
]);
const UI_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  reset: "clear",
  fork: "branch",
  resume: "sessions",
  switch: "sessions",
  q: "queue",
  commands: "help",
  knowledge: "journey",
  learning: "journey",
  "memory-graph": "journey",
};
const EMPTY_TRANSCRIPT_ITEMS: TranscriptItem[] = [];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function eventText(event: HermesEvent): string {
  const payload = record(event.payload);
  return contentToText(payload.delta ?? payload.text ?? payload.content ?? "");
}

function localId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function timestampToIso(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const millis = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  return new Date(millis).toISOString();
}

function toSessionSummary(session: HermesSessionSummary, untitled: string): SessionSummary {
  return {
    storedId: session.id,
    title: session.title || untitled,
    ...(session.preview ? { preview: session.preview } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    createdAt: timestampToIso(session.startedAt),
    updatedAt: timestampToIso(session.lastActive),
    messageCount: session.messageCount,
    ...(session.profile ? { profile: session.profile } : {}),
    ...(session.model ? { model: session.model } : {}),
    status: session.active ? "active" : "idle",
  };
}

function connectionPhase(state: HermesTransport["connectionState"]): ConnectionPhase {
  if (state === "open") return "connected";
  if (state === "connecting" || state === "idle") return "connecting";
  if (state === "reconnecting") return "reconnecting";
  if (state === "closed") return "disconnected";
  return "error";
}

function isProtocolIncompatibility(error: unknown): boolean {
  return error instanceof Error && /incompatible|desktop contract|protocol version|bootstrap response/iu.test(error.message);
}

function promptKey(prompt: PendingPrompt): string {
  if (prompt.kind === "approval") return prompt.requestId ?? `approval:${prompt.sessionId ?? "global"}`;
  return prompt.requestId;
}

function toInteractivePrompt(prompt: PendingPrompt, labels: {
  approval: string;
  clarification: string;
  sudo: string;
  secret: string;
}): InteractivePrompt {
  const id = promptKey(prompt);
  if (prompt.kind === "approval") {
    return {
      id,
      requestId: id,
      kind: "approval",
      title: labels.approval,
      description: prompt.description ?? prompt.command,
      ...(prompt.expiresAt ? { expiresAt: new Date(prompt.expiresAt).toISOString() } : {}),
    };
  }
  if (prompt.kind === "clarification") {
    return {
      id,
      requestId: prompt.requestId,
      kind: "clarification",
      title: prompt.question || labels.clarification,
      options: prompt.choices.map((choice) => ({ label: choice, value: choice })),
      ...(prompt.expiresAt ? { expiresAt: new Date(prompt.expiresAt).toISOString() } : {}),
    };
  }
  if (prompt.kind === "sudo") {
    return {
      id,
      requestId: prompt.requestId,
      kind: "sudo",
      title: labels.sudo,
      ...(prompt.expiresAt ? { expiresAt: new Date(prompt.expiresAt).toISOString() } : {}),
    };
  }
  return {
    id,
    requestId: prompt.requestId,
    kind: "secret",
    title: prompt.prompt ?? prompt.name ?? labels.secret,
    ...(prompt.expiresAt ? { expiresAt: new Date(prompt.expiresAt).toISOString() } : {}),
  };
}

function parseProgress(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const latin = value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const match = latin.match(/(\d{1,3})(?:\.\d+)?\s*%/);
  return match?.[1] ? Math.max(0, Math.min(100, Number(match[1]))) : undefined;
}

function artifactFromValue(value: unknown, toolId?: string): Artifact | null {
  const item = record(value);
  const content = optionalString(item.content ?? item.text ?? item.url ?? item.data_url);
  if (!content) return null;
  const rawKind = optionalString(item.kind ?? item.type)?.toLowerCase();
  const kind: Artifact["kind"] =
    rawKind === "markdown" || rawKind === "md"
      ? "markdown"
      : rawKind === "diff" || rawKind === "patch"
        ? "diff"
        : rawKind === "image" || rawKind?.startsWith("image/")
          ? "image"
          : rawKind === "html" || rawKind === "text/html"
            ? "html"
            : rawKind === "code"
              ? "code"
              : "text";
  return {
    id: optionalString(item.id) ?? localId("artifact"),
    title: optionalString(item.title ?? item.filename ?? item.name) ?? "Artifact",
    kind,
    content,
    ...(optionalString(item.language) ? { language: String(item.language) } : {}),
    ...(toolId ? { sourceToolId: toolId } : {}),
  };
}

export function ChatShell({
  active = true,
  initialProfile,
  profileRequiredError = false,
  storedSessionId,
}: ChatShellProps) {
  const locale = useLocale();
  const router = useRouter();
  const tApp = useTranslations("App");
  const tNav = useTranslations("Nav");
  const tSessions = useTranslations("Sessions");
  const tConnection = useTranslations("Connection");
  const tChat = useTranslations("Chat");
  const tComposer = useTranslations("Composer");
  const tActions = useTranslations("Actions");
  const tStatus = useTranslations("Status");
  const tTools = useTranslations("Tools");
  const tPrompts = useTranslations("Prompts");
  const tSettings = useTranslations("Settings");
  const tModels = useTranslations("Models");
  const tAttachments = useTranslations("Attachments");
  const tCommands = useTranslations("Commands");
  const tErrors = useTranslations("Errors");
  const queryClient = useQueryClient();
  const {
    publishRuntime,
    recordActivityEvent,
    setFeatureSupport,
    transport,
  } = useHermesWorkspace();

  const [connection, setConnection] = useState<ConnectionPhase>("connecting");
  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySet | undefined>();
  const [identity, setIdentity] = useState<SessionIdentity | null>(null);
  const identityRef = useRef<SessionIdentity | null>(null);
  identityRef.current = identity;
  const [activeStoredId, setActiveStoredId] = useState(storedSessionId);
  const [sessionTitle, setSessionTitle] = useState(tSessions("untitled"));
  const selectedRuntimeSession = useSessionRuntimeStore((state) => (
    state.selectedScopeKey ? state.sessions[state.selectedScopeKey] : undefined
  ));
  const runtimeSessions = useSessionRuntimeStore((state) => state.sessions);
  const transcriptItems = selectedRuntimeSession?.transcriptItems ?? EMPTY_TRANSCRIPT_ITEMS;
  const running = selectedRuntimeSession?.running ?? false;
  const eventScopeRef = useRef<string | null>(null);
  const setTranscriptItems = useCallback((update: TranscriptItem[] | ((current: TranscriptItem[]) => TranscriptItem[])) => {
    const runtimeState = useSessionRuntimeStore.getState();
    const scopeKey = eventScopeRef.current ?? runtimeState.selectedScopeKey;
    if (!scopeKey) return;
    runtimeState.updateTranscript(
      { scopeKey },
      typeof update === "function" ? update : () => update,
    );
  }, []);
  const setRunning = useCallback((value: boolean) => {
    const runtimeState = useSessionRuntimeStore.getState();
    const scopeKey = eventScopeRef.current ?? runtimeState.selectedScopeKey;
    if (!scopeKey) return;
    runtimeState.updateLiveState({ scopeKey }, {
      running: value,
      status: value ? "working" : "idle",
    });
  }, []);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [activeProfile, setActiveProfile] = useState(initialProfile ?? "default");
  const activeProfileRef = useRef(activeProfile);
  activeProfileRef.current = activeProfile;
  const [profiles, setProfiles] = useState<string[]>(["default"]);
  const [gatewayContract, setGatewayContract] = useState<number | undefined>();
  const [loadingSession, setLoadingSession] = useState(false);
  const [usageDialog, setUsageDialog] = useState<{
    loading: boolean;
    data?: UsageStats;
    context?: ContextBreakdown;
    error?: string;
  } | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  const [checkpoints, setCheckpoints] = useState<RollbackCheckpoint[]>([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<RollbackCheckpoint>();
  const [checkpointDiff, setCheckpointDiff] = useState<RollbackDiff>();
  const [sessionAction, setSessionAction] = useState<"branch" | "compress" | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [rightRailMode, setRightRailMode] = useState<"artifacts" | "files">("files");
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const loadedStoredIdRef = useRef<string | undefined>(undefined);
  const initialProfileRef = useRef(initialProfile);
  const activeStoredIdRef = useRef<string | undefined>(storedSessionId);
  activeStoredIdRef.current = activeStoredId;
  const resumeGenerationRef = useRef(0);
  const reconnectingRef = useRef(false);
  const pendingDeltasRef = useRef<string[]>([]);
  const deltaFrameRef = useRef<number | null>(null);
  const assistantRunIdRef = useRef<string | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  const reasoningIdRef = useRef<string | null>(null);
  const lastReasoningIdRef = useRef<string | null>(null);
  const reasoningSeenRef = useRef(false);
  const assistantPartSequenceRef = useRef(0);
  const drainingSessionScopesRef = useRef(new Set<string>());
  const activeListInFlightRef = useRef(false);
  const catalogRefreshAfterRunRef = useRef(false);
  const speechPlaybackRef = useRef<SpeechPlayback | null>(null);

  const openMobileRail = useChatUiStore((state) => state.openMobileRail);
  const setMobileRail = useChatUiStore((state) => state.setMobileRail);
  const artifactRailOpen = useChatUiStore((state) => state.artifactRailOpen);
  const setArtifactRailOpen = useChatUiStore((state) => state.setArtifactRailOpen);
  const artifactRailWidth = useChatUiStore((state) => state.artifactRailWidth);
  const setArtifactRailWidth = useChatUiStore((state) => state.setArtifactRailWidth);
  const artifactsBySession = useChatUiStore((state) => state.artifacts);
  const selectedArtifactIds = useChatUiStore((state) => state.selectedArtifactIds);
  const selectArtifact = useChatUiStore((state) => state.selectArtifact);
  const addArtifact = useChatUiStore((state) => state.addArtifact);
  const drafts = useChatUiStore((state) => state.drafts);
  const setDraft = useChatUiStore((state) => state.setDraft);
  const queuedPrompts = useChatUiStore((state) => state.queuedPrompts);
  const enqueuePrompt = useChatUiStore((state) => state.enqueuePrompt);
  const replaceQueuedPrompt = useChatUiStore((state) => state.replaceQueuedPrompt);
  const removeQueuedPrompt = useChatUiStore((state) => state.removeQueuedPrompt);
  const attachmentsBySession = useChatUiStore((state) => state.attachments);
  const setAttachments = useChatUiStore((state) => state.setAttachments);
  const modelSettings = useChatUiStore((state) => state.modelSettings);
  const setModelSettings = useChatUiStore((state) => state.setModelSettings);
  const commandPaletteOpen = useChatUiStore((state) => state.commandPaletteOpen);
  const setCommandPaletteOpen = useChatUiStore((state) => state.setCommandPaletteOpen);
  const clearSessionEphemera = useChatUiStore((state) => state.clearSessionEphemera);

  const composerKey = chatSessionScopeKey(activeProfile, identity?.storedId ?? activeStoredId);
  const draft = drafts[composerKey] ?? "";
  const queue = queuedPrompts[composerKey] ?? [];
  const attachments = attachmentsBySession[composerKey] ?? [];
  const currentModelSettings = modelSettings[composerKey] ?? {};
  const artifacts = artifactsBySession[composerKey] ?? [];
  const selectedArtifactId = selectedArtifactIds[composerKey] ?? null;
  const messages = useMemo(
    () => transcriptItems.flatMap((item) => (item.kind === "message" ? [item.message] : [])),
    [transcriptItems],
  );

  useEffect(() => {
    if (artifactRailOpen && selectedArtifactId) setRightRailMode("artifacts");
  }, [artifactRailOpen, selectedArtifactId]);

  const refreshCapabilities = useCallback(() => {
    setCapabilities(transport.capabilities);
  }, [transport]);

  const reportSessionSearchCapability = useCallback(
    (support: "available" | "unavailable") => {
      setFeatureSupport("sessionSearch", support);
    },
    [setFeatureSupport],
  );

  const reportWorkspaceCapability = useCallback(
    (
      operation: "list" | "read" | "validate",
      support: "available" | "unavailable",
    ) => {
      const feature = operation === "list"
        ? "workspaceList"
        : operation === "read"
          ? "workspaceRead"
          : "workspaceValidate";
      setFeatureSupport(feature, support);
      if (support === "available") {
        setFeatureSupport("workspaceFiles", "readOnly");
      } else if (operation === "list" || operation === "validate") {
        setFeatureSupport("workspaceFiles", "unavailable");
      }
    },
    [setFeatureSupport],
  );

  useEffect(() => {
    publishRuntime({
      activeProfile,
      activeStoredId,
      bootstrap,
      capabilities,
      connection,
      gatewayContract,
      identity,
      profiles,
      running,
      sessionTitle,
    });
  }, [
    activeProfile,
    activeStoredId,
    bootstrap,
    capabilities,
    connection,
    gatewayContract,
    identity,
    profiles,
    publishRuntime,
    running,
    sessionTitle,
  ]);

  useEffect(() => {
    const gatewayReady = connection === "connected" && capabilities?.gateway === true;
    setFeatureSupport("activity", gatewayReady ? "available" : "unavailable");
    setFeatureSupport("projects", gatewayContract !== undefined && gatewayContract >= 4 ? "available" : "readOnly");
    setFeatureSupport("recovery", gatewayContract !== undefined && gatewayContract >= 4 ? "available" : "unavailable");
  }, [capabilities?.gateway, connection, gatewayContract, setFeatureSupport]);

  const flushDeltas = useCallback((requestedScopeKey?: string) => {
    const runtimeStore = useSessionRuntimeStore.getState();
    const scopeKey = requestedScopeKey ?? eventScopeRef.current ?? runtimeStore.selectedScopeKey;
    if (!scopeKey) return;
    const session = runtimeStore.sessions[scopeKey];
    if (!session) return;
    const delta = session.stream.pendingTextDeltas.join("");
    const sequence = session.stream.assistantPartSequence;
    const id = session.stream.assistantMessageId
      ?? `${session.stream.assistantRunId ?? localId("assistant")}:text:${sequence}`;
    runtimeStore.setStreamMetadata({ scopeKey }, {
      pendingTextDeltas: [],
      deltaFrameId: null,
      assistantMessageId: delta ? id : session.stream.assistantMessageId,
      assistantPartSequence: session.stream.assistantMessageId || !delta ? sequence : sequence + 1,
    });
    if (runtimeStore.selectedScopeKey === scopeKey) {
      deltaFrameRef.current = null;
      pendingDeltasRef.current = [];
      assistantMessageIdRef.current = delta ? id : session.stream.assistantMessageId;
      assistantPartSequenceRef.current = session.stream.assistantMessageId || !delta ? sequence : sequence + 1;
    }
    if (!delta) return;
    runtimeStore.updateTranscript({ scopeKey }, (current) => reduceTranscript(current, {
      type: "message-delta",
      id,
      delta,
      createdAt: new Date().toISOString(),
    }));
  }, []);

  const queueDelta = useCallback(
    (delta: string, requestedScopeKey?: string) => {
      if (!delta) return;
      const runtimeStore = useSessionRuntimeStore.getState();
      const scopeKey = requestedScopeKey ?? eventScopeRef.current ?? runtimeStore.selectedScopeKey;
      if (!scopeKey) return;
      const session = runtimeStore.sessions[scopeKey];
      if (!session) return;
      const pendingTextDeltas = [...session.stream.pendingTextDeltas, delta];
      const deltaFrameId = session.stream.deltaFrameId
        ?? requestAnimationFrame(() => flushDeltas(scopeKey));
      runtimeStore.setStreamMetadata({ scopeKey }, { pendingTextDeltas, deltaFrameId });
      if (runtimeStore.selectedScopeKey === scopeKey) {
        pendingDeltasRef.current = pendingTextDeltas;
        deltaFrameRef.current = deltaFrameId;
      }
    },
    [flushDeltas],
  );

  const applySnapshot = useCallback(
    (
      snapshot: SessionSnapshot,
      ownerProfile: string,
      historyMessages: Message[] = snapshot.messages,
      options: { select?: boolean; expectedTranscriptRevision?: number } = {},
    ) => {
      const runtimeStore = useSessionRuntimeStore.getState();
      const scopeKey = runtimeStore.hydrateSnapshot(ownerProfile, snapshot, {
        messages: historyMessages,
        ...(options.expectedTranscriptRevision === undefined
          ? {}
          : { expectedTranscriptRevision: options.expectedTranscriptRevision }),
        title: snapshot.info?.title || tSessions("untitled"),
      });
      const hydrated = useSessionRuntimeStore.getState().sessions[scopeKey];
      if (options.select === false) return;
      useSessionRuntimeStore.getState().selectSession({ scopeKey });
      assistantRunIdRef.current = hydrated?.stream.assistantRunId ?? null;
      assistantMessageIdRef.current = hydrated?.stream.assistantMessageId ?? null;
      reasoningIdRef.current = hydrated?.stream.reasoningId ?? null;
      lastReasoningIdRef.current = hydrated?.stream.lastReasoningId ?? null;
      reasoningSeenRef.current = hydrated?.stream.reasoningSeen ?? false;
      assistantPartSequenceRef.current = hydrated?.stream.assistantPartSequence ?? 0;
      identityRef.current = snapshot.identity;
      activeStoredIdRef.current = snapshot.identity.storedId;
      setIdentity(snapshot.identity);
      setActiveStoredId(snapshot.identity.storedId);
      setUsageDialog(null);
      setSessionTitle(hydrated?.title || snapshot.info?.title || tSessions("untitled"));
      if (snapshot.info?.contract !== undefined) setGatewayContract(snapshot.info.contract);
      setModelSettings(chatSessionScopeKey(ownerProfile, snapshot.identity.storedId), {
        ...(snapshot.info?.model ? { model: snapshot.info.model } : {}),
        ...(snapshot.info?.provider ? { provider: snapshot.info.provider } : {}),
        // A resumed snapshot is authoritative. Missing reasoning must clear a
        // stale per-session cache instead of falling back to a fabricated tier.
        reasoning: snapshot.info?.reasoningEffort ?? "",
        ...(snapshot.info?.fast === undefined ? {} : { fast: snapshot.info.fast }),
        ...(snapshot.info?.yolo === undefined ? {} : { yolo: snapshot.info.yolo }),
      });
      setActiveProfile(ownerProfile);
    },
    [setModelSettings, tSessions],
  );

  const resumeStoredSession = useCallback(
    async (
      storedId: string,
      replacePath = false,
      ownerProfileInput?: string,
      transactional = false,
    ): Promise<boolean> => {
      const ownerProfile = ownerProfileInput ?? activeProfileRef.current;
      const generation = ++resumeGenerationRef.current;
      setLoadingSession(true);
      try {
        const runtimeStore = useSessionRuntimeStore.getState();
        let known = runtimeStore.findByStored(ownerProfile, storedId);
        if (known?.stream.pendingTextDeltas.length) {
          flushDeltas(known.scopeKey);
          known = useSessionRuntimeStore.getState().findByStored(ownerProfile, storedId);
        }
        const expectedTranscriptRevision = known?.transcriptRevision;
        let snapshot: SessionSnapshot;
        let durableMessages: Message[];
        if (known?.identity.runtimeId) {
          try {
            snapshot = await transport.sessionActivate(known.identity.runtimeId);
            durableMessages = snapshot.messages;
          } catch (error) {
            if (!isMethodNotFound(error)) throw error;
            const history = await transport.sessionMessages(storedId, ownerProfile).catch(() => null);
            snapshot = await transport.sessionResume(storedId, { profile: ownerProfile });
            durableMessages = reconcileSessionHistory(snapshot, history, storedId);
          }
        } else {
          // Read raw rows before resuming. The subsequent snapshot is then the
          // freshness authority and can reject an older/incomplete history read.
          const history = await transport.sessionMessages(storedId, ownerProfile).catch(() => null);
          snapshot = await transport.sessionResume(storedId, { profile: ownerProfile });
          durableMessages = reconcileSessionHistory(snapshot, history, storedId);
        }
        if (
          generation !== resumeGenerationRef.current
          || (!transactional && activeStoredIdRef.current !== storedId)
        ) return false;
        applySnapshot(snapshot, ownerProfile, durableMessages, {
          ...(expectedTranscriptRevision === undefined ? {} : { expectedTranscriptRevision }),
        });
        loadedStoredIdRef.current = storedId;
        setNotice(null);
        if (replacePath) {
          router.replace(
            `/${locale}/c/${encodeURIComponent(snapshot.identity.storedId)}?profile=${encodeURIComponent(ownerProfile)}`,
          );
        }
        return true;
      } catch (error) {
        if (generation !== resumeGenerationRef.current) return false;
        if (!transactional) {
          identityRef.current = null;
          setIdentity(null);
          setRunning(false);
        }
        refreshCapabilities();
        setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
        return false;
      } finally {
        if (generation === resumeGenerationRef.current) setLoadingSession(false);
      }
    },
    [applySnapshot, flushDeltas, locale, refreshCapabilities, router, setRunning, tErrors, transport],
  );

  const rebindLiveSessions = useCallback(async () => {
    const before = useSessionRuntimeStore.getState();
    const liveSessions = Object.values(before.sessions).filter(
      (session) => Boolean(session.identity.runtimeId),
    );
    await Promise.allSettled(liveSessions.map(async (session) => {
      if (!session.identity.runtimeId) return;
      if (session.stream.pendingTextDeltas.length) flushDeltas(session.scopeKey);
      const current = useSessionRuntimeStore.getState().sessions[session.scopeKey];
      const expectedTranscriptRevision = current?.transcriptRevision;
      let snapshot: SessionSnapshot;
      try {
        snapshot = await transport.sessionActivate(session.identity.runtimeId);
      } catch (error) {
        if (!isMethodNotFound(error)) throw error;
        snapshot = await transport.sessionResume(session.identity.storedId, {
          profile: session.profile,
        });
      }
      applySnapshot(snapshot, session.profile, snapshot.messages, {
        select: false,
        ...(expectedTranscriptRevision === undefined ? {} : { expectedTranscriptRevision }),
      });
    }));
    const after = useSessionRuntimeStore.getState();
    const selected = after.selectedScopeKey ? after.sessions[after.selectedScopeKey] : undefined;
    if (selected?.identity.runtimeId) {
      const nextIdentity: SessionIdentity = {
        storedId: selected.identity.storedId,
        runtimeId: selected.identity.runtimeId,
        ...(selected.identity.lineageRootId
          ? { lineageRootId: selected.identity.lineageRootId }
          : {}),
      };
      identityRef.current = nextIdentity;
      setIdentity(nextIdentity);
      setSessionTitle(selected.title || tSessions("untitled"));
    }
  }, [applySnapshot, flushDeltas, tSessions, transport]);

  useEffect(() => {
    const ownerProfile = initialProfile ?? activeProfileRef.current;
    if (initialProfile && initialProfile !== activeProfileRef.current) setActiveProfile(initialProfile);
    if (storedSessionId === activeStoredIdRef.current && identityRef.current?.storedId === storedSessionId) return;
    resumeGenerationRef.current += 1;
    activeStoredIdRef.current = storedSessionId;
    identityRef.current = null;
    loadedStoredIdRef.current = undefined;
    setActiveStoredId(storedSessionId);
    setIdentity(null);
    useSessionRuntimeStore.getState().selectSession(null);
    if (storedSessionId && profileRequiredError) {
      setNotice({kind: "error", message: tErrors("profileRequired")});
      return;
    }
    if (storedSessionId && connection === "connected") {
      void resumeStoredSession(storedSessionId, false, ownerProfile);
    }
  }, [connection, initialProfile, profileRequiredError, resumeStoredSession, storedSessionId, tErrors]);

  useEffect(() => {
    const unsubscribeState = transport.onConnectionState((state) => {
      const phase = connectionPhase(state);
      setConnection(phase);
      if (phase === "reconnecting") reconnectingRef.current = true;
      if (phase === "connected" && reconnectingRef.current) {
        reconnectingRef.current = false;
        void queryClient.invalidateQueries({ queryKey: ["hermes-commands"] });
        void rebindLiveSessions();
      }
    });
    let cancelled = false;
    void transport.connect().then(
      async (info) => {
        if (cancelled) return;
        setBootstrap(info);
        setCapabilities(transport.capabilities);
        const ownerProfile = initialProfileRef.current ?? "default";
        setActiveProfile(ownerProfile);
        if (
          !transport.capabilities.gateway &&
          transport.capabilities.httpFallback &&
          !activeStoredIdRef.current
        ) {
          try {
            const snapshot = await transport.sessionCreate(
              { profile: ownerProfile },
            );
            if (cancelled) return;
            applySnapshot(snapshot, ownerProfile);
            loadedStoredIdRef.current = snapshot.identity.storedId;
            router.replace(
              `/${locale}/c/${encodeURIComponent(snapshot.identity.storedId)}?profile=${encodeURIComponent(ownerProfile)}`,
            );
          } catch (error) {
            if (!cancelled) {
              setNotice({
                kind: "error",
                message: error instanceof Error ? error.message : tErrors("backendUnavailable"),
              });
            }
          }
        }
        try {
          const response = await fetch("/api/hermes/profiles", { cache: "no-store" });
          const payload = record(await response.json());
          const names = Array.isArray(payload.profiles)
            ? payload.profiles.map((item) => optionalString(record(item).name)).filter((name): name is string => Boolean(name))
            : [];
          if (names.length) setProfiles(names);
        } catch {
          // Profile discovery is optional; the active profile remains usable.
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        const incompatible = isProtocolIncompatibility(error);
        setConnection(incompatible ? "incompatible" : "error");
        setNotice({
          kind: "error",
          message: incompatible
            ? tErrors("incompatibleProtocol")
            : error instanceof Error
              ? error.message
              : tErrors("backendUnavailable"),
        });
      },
    );
    return () => {
      cancelled = true;
      unsubscribeState();
      speechPlaybackRef.current?.stop();
      speechPlaybackRef.current = null;
      transport.disconnect();
    };
  }, [applySnapshot, locale, queryClient, rebindLiveSessions, router, tErrors, transport]);

  useEffect(() => {
    const unsubscribe = transport.onEvent((event) => {
      if (event.type === "gateway.ready") {
        const payload = record(event.payload);
        const contract = Number(payload.desktop_contract ?? payload.contract);
        if (Number.isFinite(contract)) setGatewayContract(contract);
      }
      const runtimeStore = useSessionRuntimeStore.getState();
      const runtimeSession = event.sessionId
        ? runtimeStore.findByRuntime(event.sessionId)
          ?? runtimeStore.findByStored(activeProfileRef.current, event.sessionId)
        : undefined;
      recordActivityEvent(event, runtimeSession?.profile ?? activeProfileRef.current);
      if (event.sessionId && !runtimeSession) return;
      if (!runtimeSession) return;

      const scopeKey = runtimeSession.scopeKey;
      const selected = runtimeStore.selectedScopeKey === scopeKey;
      eventScopeRef.current = scopeKey;
      pendingDeltasRef.current = runtimeSession.stream.pendingTextDeltas;
      deltaFrameRef.current = runtimeSession.stream.deltaFrameId;
      assistantRunIdRef.current = runtimeSession.stream.assistantRunId;
      assistantMessageIdRef.current = runtimeSession.stream.assistantMessageId;
      reasoningIdRef.current = runtimeSession.stream.reasoningId;
      lastReasoningIdRef.current = runtimeSession.stream.lastReasoningId;
      reasoningSeenRef.current = runtimeSession.stream.reasoningSeen;
      assistantPartSequenceRef.current = runtimeSession.stream.assistantPartSequence;

      try {

      if (event.type === "message.start") {
        assistantRunIdRef.current = optionalString(record(event.payload).message_id) ?? localId("assistant");
        assistantMessageIdRef.current = null;
        reasoningIdRef.current = null;
        lastReasoningIdRef.current = null;
        reasoningSeenRef.current = false;
        assistantPartSequenceRef.current = 0;
        runtimeStore.updateLiveState({ scopeKey }, {
          status: "working",
          running: true,
          needsInput: false,
          error: null,
        });
        setRunning(true);
        return;
      }
      if (event.type === "message.delta") {
        setRunning(true);
        queueDelta(eventText(event));
        return;
      }
      if (event.type === "reasoning.delta" || event.type === "thinking.delta") {
        const delta = eventText(event);
        if (delta) {
          const id = reasoningIdRef.current
            ?? `${assistantRunIdRef.current ?? localId("assistant")}:reasoning:${assistantPartSequenceRef.current++}`;
          reasoningIdRef.current = id;
          lastReasoningIdRef.current = id;
          reasoningSeenRef.current = true;
          setTranscriptItems((current) => reduceTranscript(current, {
            type: "reasoning-delta",
            id,
            text: delta,
            createdAt: new Date().toISOString(),
          }));
        }
        return;
      }
      if (event.type === "reasoning.available") {
        const text = eventText(event);
        if (text) {
          const id = lastReasoningIdRef.current
            ?? `${assistantRunIdRef.current ?? localId("assistant")}:reasoning:${assistantPartSequenceRef.current++}`;
          reasoningIdRef.current = id;
          lastReasoningIdRef.current = id;
          reasoningSeenRef.current = true;
          setTranscriptItems((current) => {
            const replaced = reduceTranscript(current, {
              type: "reasoning-delta",
              id,
              text,
              replace: true,
              createdAt: new Date().toISOString(),
            });
            return reduceTranscript(replaced, { type: "reasoning-status", id, status: "complete" });
          });
        }
        return;
      }
      if (event.type === "message.complete") {
        if (deltaFrameRef.current !== null) cancelAnimationFrame(deltaFrameRef.current);
        flushDeltas();
        const payload = record(event.payload);
        const fullText = eventText(event);
        const interrupted = payload.status === "interrupted";
        const fallbackReasoning = optionalString(payload.reasoning ?? payload.reasoning_content);
        if (!reasoningSeenRef.current && fallbackReasoning) {
          const reasoningId = `${assistantRunIdRef.current ?? localId("assistant")}:reasoning:${assistantPartSequenceRef.current++}`;
          lastReasoningIdRef.current = reasoningId;
          reasoningSeenRef.current = true;
          setTranscriptItems((current) => {
            const appended = reduceTranscript(current, {
              type: "reasoning-delta",
              id: reasoningId,
              text: fallbackReasoning,
              createdAt: new Date().toISOString(),
            });
            return reduceTranscript(appended, { type: "reasoning-status", id: reasoningId, status: "complete" });
          });
        }
        const id = assistantMessageIdRef.current
          ?? `${assistantRunIdRef.current ?? localId("assistant")}:text:${assistantPartSequenceRef.current++}`;
        if (fullText || assistantMessageIdRef.current) {
          setTranscriptItems((current) => reduceTranscript(current, {
            type: "message-complete",
            id,
            ...(fullText ? { content: fullText } : {}),
            createdAt: new Date().toISOString(),
            status: interrupted ? "interrupted" : "complete",
          }));
        }
        if (lastReasoningIdRef.current) {
          setTranscriptItems((current) => reduceTranscript(current, {
            type: "reasoning-status",
            id: lastReasoningIdRef.current!,
            status: interrupted ? "interrupted" : "complete",
          }));
        }
        assistantRunIdRef.current = null;
        assistantMessageIdRef.current = null;
        reasoningIdRef.current = null;
        lastReasoningIdRef.current = null;
        setRunning(false);
        runtimeStore.updateLiveState({ scopeKey }, {
          status: "idle",
          running: false,
          needsInput: false,
          markUnread: !selected,
        });
        void queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
        if (catalogRefreshAfterRunRef.current) {
          catalogRefreshAfterRunRef.current = false;
          void queryClient.invalidateQueries({ queryKey: ["hermes-commands"] });
        }
        return;
      }
      if (event.type === "session.info") {
        const payload = record(event.payload);
        const hasReasoningEffort = Object.hasOwn(payload, "reasoning_effort");
        const eventContract = Number(payload.desktop_contract ?? payload.contract);
        if (Number.isFinite(eventContract)) setGatewayContract(eventContract);
        if (typeof payload.running === "boolean") setRunning(payload.running);
        const eventTitle = optionalString(payload.title);
        if (eventTitle) {
          runtimeStore.updateLiveState({ scopeKey }, { title: eventTitle });
          if (selected) setSessionTitle(eventTitle);
        }
        const stored = runtimeSession.identity.storedId;
        if (stored && (
          optionalString(payload.model)
          || optionalString(payload.provider)
          || hasReasoningEffort
          || typeof payload.fast === "boolean"
          || typeof payload.yolo === "boolean"
        )) {
          const eventProfile = runtimeSession.profile;
          setModelSettings(chatSessionScopeKey(eventProfile, stored), {
            ...(optionalString(payload.model) ? { model: String(payload.model) } : {}),
            ...(optionalString(payload.provider) ? { provider: String(payload.provider) } : {}),
            ...(hasReasoningEffort
              ? { reasoning: optionalString(payload.reasoning_effort) ?? "" }
              : {}),
            ...(typeof payload.fast === "boolean" ? { fast: payload.fast } : {}),
            ...(typeof payload.yolo === "boolean" ? { yolo: payload.yolo } : {}),
          });
        }
        return;
      }
      if (event.type === "session.title") {
        const title = optionalString(record(event.payload).title);
        if (title) {
          runtimeStore.updateLiveState({ scopeKey }, { title });
          if (selected) setSessionTitle(title);
        }
        void queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
        return;
      }
      if (event.type === "status.update") {
        const payload = record(event.payload);
        const status = String(payload.status ?? payload.kind ?? "");
        if (["idle", "complete", "completed", "interrupted", "error"].includes(status)) {
          setRunning(false);
        } else if (status === "waiting") {
          runtimeStore.updateLiveState({ scopeKey }, { status: "waiting", running: true, needsInput: true });
        } else if (status) {
          setRunning(true);
        }
      }

      const activity = toolActivityFromEvent(event);
      if (activity) {
        const payload = record(event.payload);
        if (event.type === "tool.start" || event.type === "tool.generating") {
          flushDeltas();
          if (reasoningIdRef.current) {
            setTranscriptItems((current) => reduceTranscript(current, {
              type: "reasoning-status",
              id: reasoningIdRef.current!,
              status: "complete",
            }));
          }
          assistantMessageIdRef.current = null;
          reasoningIdRef.current = null;
        }
        setTranscriptItems((current) => {
          const previousItem = current.find((item) => item.kind === "tool" && item.tool.id === activity.id);
          const previous = previousItem?.kind === "tool" ? previousItem.tool : undefined;
          const rawInput = activity.args ?? payload.args_text ?? activity.context;
          const rawOutput = activity.output ?? activity.rawOutput;
          const status: ToolRun["status"] = event.type === "tool.complete"
            ? classifyToolOutcome(payload)
            : "running";
          return reduceTranscript(current, {
            type: "upsert-tool",
            tool: {
              ...previous,
              id: activity.id,
              name: activity.name === "tool" && previous ? previous.name : activity.name || previous?.name || "tool",
              status,
              ...(rawInput === undefined ? {} : { input: parseToolArguments(rawInput) }),
              ...(rawOutput === undefined ? {} : { output: parseToolArguments(rawOutput) }),
              ...(activity.summary !== undefined || activity.progress !== undefined
                ? { summary: activity.summary ?? activity.progress }
                : {}),
              ...(parseProgress(activity.progress) === undefined
                ? {}
                : { progress: parseProgress(activity.progress) }),
              ...(activity.progress ? { progressText: activity.progress } : {}),
              ...(activity.inlineDiff ? { inlineDiff: activity.inlineDiff } : {}),
              ...(activity.durationSeconds === undefined
                ? {}
                : { durationSeconds: activity.durationSeconds }),
              ...(previous?.startedAt
                ? {}
                : { startedAt: new Date(event.receivedAt).toISOString() }),
              ...(event.type === "tool.complete"
                ? { finishedAt: new Date(event.receivedAt).toISOString() }
                : {}),
            },
          });
        });
        const artifactValues = Array.isArray(payload.artifacts)
          ? payload.artifacts
          : payload.artifact
            ? [payload.artifact]
            : [];
        for (const value of artifactValues) {
          const artifact = artifactFromValue(value, activity.id);
          if (artifact) {
            addArtifact(
              chatSessionScopeKey(runtimeSession.profile, runtimeSession.identity.storedId),
              artifact,
              { select: selected },
            );
          }
        }
      }

      const domainPrompt = pendingPromptFromEvent(event);
      if (domainPrompt) {
        const key = promptKey(domainPrompt);
        runtimeStore.setDomainPrompt({ scopeKey }, key, domainPrompt, { markUnread: !selected });
        const prompt = toInteractivePrompt(domainPrompt, {
          approval: tPrompts("approvalTitle"),
          clarification: tPrompts("clarificationTitle"),
          sudo: tPrompts("sudoTitle"),
          secret: tPrompts("secretTitle"),
        });
        setTranscriptItems((current) => reduceTranscript(current, { type: "upsert-prompt", prompt }));
      }
      if ([
        "secret.expire",
        "secret.expired",
        "sudo.expire",
        "sudo.expired",
        "clarify.expire",
        "clarify.expired",
        "approval.expire",
        "approval.expired",
      ].includes(event.type)) {
        const requestId = optionalString(record(event.payload).request_id);
        const kind = event.type.split(".", 1)[0];
        const fallbackId = kind === "approval" && event.sessionId ? `approval:${event.sessionId}` : undefined;
        const expiredId = requestId ?? fallbackId;
        if (expiredId) {
          setTranscriptItems((current) => reduceTranscript(current, { type: "expire-prompt", id: expiredId }));
          runtimeStore.removeDomainPrompt({ scopeKey }, expiredId);
        }
      }
      if (event.type === "error") {
        const message = optionalString(record(event.payload).message) ?? tErrors("generic");
        runtimeStore.updateLiveState({ scopeKey }, {
          status: "idle",
          running: false,
          error: message,
          markUnread: !selected,
        });
        if (selected) setNotice({ kind: "error", message });
        setRunning(false);
        const id = assistantMessageIdRef.current;
        if (id) {
          setTranscriptItems((current) => reduceTranscript(current, { type: "message-status", id, status: "error" }));
        }
      }
      } finally {
        useSessionRuntimeStore.getState().setStreamMetadata({ scopeKey }, {
          assistantRunId: assistantRunIdRef.current,
          assistantMessageId: assistantMessageIdRef.current,
          reasoningId: reasoningIdRef.current,
          lastReasoningId: lastReasoningIdRef.current,
          reasoningSeen: reasoningSeenRef.current,
          assistantPartSequence: assistantPartSequenceRef.current,
        });
        eventScopeRef.current = null;
      }
    });
    return unsubscribe;
  }, [addArtifact, flushDeltas, queryClient, queueDelta, recordActivityEvent, setModelSettings, setRunning, setTranscriptItems, tErrors, tPrompts, transport]);

  useEffect(() => {
    if (profileRequiredError) return;
    if (connection !== "connected" || !activeStoredId) return;
    if (loadedStoredIdRef.current === activeStoredId && identity?.storedId === activeStoredId) return;
    void resumeStoredSession(activeStoredId);
  }, [activeStoredId, connection, identity?.storedId, profileRequiredError, resumeStoredSession]);

  const sessionsQuery = useQuery({
    queryKey: ["hermes-sessions", activeProfile],
    queryFn: async () => {
      try {
        return await transport.sessionList({ profile: activeProfile, limit: 200 });
      } finally {
        refreshCapabilities();
      }
    },
    enabled: connection === "connected" && capabilities?.gateway === true && capabilities.sessions,
  });

  useEffect(() => {
    if (connection !== "connected" || capabilities?.gateway !== true || !capabilities.sessions) return;
    let cancelled = false;
    let unsupported = false;
    const confirmedStoredIds = new Set(
      (sessionsQuery.data ?? [])
        .filter((session) => session.profile === activeProfile)
        .map((session) => session.id),
    );
    const poll = async () => {
      if (cancelled || unsupported || activeListInFlightRef.current) return;
      activeListInFlightRef.current = true;
      try {
        const activeItems = await transport.sessionActiveList(identityRef.current?.runtimeId);
        if (cancelled) return;
        const seenRuntimeIds = new Set(activeItems.map((item) => item.identity.runtimeId));
        for (const item of activeItems) {
          const state = useSessionRuntimeStore.getState();
          const known = state.findByRuntime(item.identity.runtimeId)
            ?? state.findByStored(activeProfile, item.identity.storedId);
          if (!known && !confirmedStoredIds.has(item.identity.storedId)) continue;
          const profile = known?.profile ?? activeProfile;
          const scopeKey = state.registerSession({
            profile,
            storedId: item.identity.storedId,
            runtimeId: item.identity.runtimeId,
            ...(item.title ? { title: item.title } : {}),
          });
          useSessionRuntimeStore.getState().updateLiveState({ scopeKey }, {
            status: item.status,
            running: item.status !== "idle",
            needsInput: item.status === "waiting",
            ...(item.title ? { title: item.title } : {}),
          });
          if (
            useSessionRuntimeStore.getState().selectedScopeKey === scopeKey
            && identityRef.current?.runtimeId !== item.identity.runtimeId
          ) {
            const nextIdentity = item.identity;
            identityRef.current = nextIdentity;
            setIdentity(nextIdentity);
          }
        }
        const after = useSessionRuntimeStore.getState();
        for (const session of Object.values(after.sessions)) {
          const runtimeId = session.identity.runtimeId;
          if (runtimeId && !seenRuntimeIds.has(runtimeId)) after.dropRuntimeBinding(runtimeId);
        }
      } catch (error) {
        if (isMethodNotFound(error)) unsupported = true;
      } finally {
        activeListInFlightRef.current = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProfile, capabilities?.gateway, capabilities?.sessions, connection, sessionsQuery.data, transport]);

  const modelsQuery = useQuery({
    queryKey: ["hermes-models", identity?.runtimeId ?? "none"],
    queryFn: async () => {
      try {
        return await transport.models(identity ?? undefined);
      } finally {
        refreshCapabilities();
      }
    },
    enabled: connection === "connected",
  });

  const projectTreeEnabled =
    connection === "connected" &&
    capabilities?.gateway === true &&
    (gatewayContract ?? 0) >= 4;
  const projectsQuery = useQuery<ProjectTreePayload | null>({
    queryKey: ["hermes-projects", activeProfile, gatewayContract],
    queryFn: async () => {
      try {
        const payload = await transport.projects(activeProfile);
        setFeatureSupport("projects", "available");
        return payload;
      } catch {
        // Older gateways and a missing drill-in RPC degrade to local cwd
        // grouping. They must not disable the rest of the session rail.
        setFeatureSupport("projects", "readOnly");
        return null;
      }
    },
    enabled: projectTreeEnabled,
  });

  useEffect(() => {
    if (!sessionsQuery.error) return;
    setNotice({
      kind: "error",
      message: sessionsQuery.error instanceof Error ? sessionsQuery.error.message : tErrors("generic"),
    });
  }, [sessionsQuery.error, tErrors]);

  const commandsQuery = useQuery({
    queryKey: ["hermes-commands", activeProfile, identity?.runtimeId ?? "none"],
    queryFn: () => transport.commandCatalog(identity ?? undefined),
    enabled: connection === "connected" && capabilities?.gateway === true,
    staleTime: 60_000,
  });

  const sessions = useMemo(() => {
    const merged = new Map<string, SessionSummary>();
    for (const session of (sessionsQuery.data ?? []).filter((item) => item.profile === activeProfile)) {
      merged.set(session.id, toSessionSummary(session, tSessions("untitled")));
    }
    for (const runtime of Object.values(runtimeSessions)) {
      if (runtime.profile !== activeProfile) continue;
      const runtimeId = runtime.identity.runtimeId;
      const durable = merged.get(runtime.identity.storedId);
      if (!durable && !runtimeId) continue;
      const transcriptMessages = runtime.transcriptItems.filter((item) => item.kind === "message");
      const preview = [...transcriptMessages].reverse().find(
        (item) => item.kind === "message" && item.message.rawSource.trim(),
      );
      merged.set(runtime.identity.storedId, {
        ...(durable ?? {
          storedId: runtime.identity.storedId,
          title: runtime.title || tSessions("untitled"),
          profile: runtime.profile,
        }),
        runtimeId,
        title: runtime.title || durable?.title || tSessions("untitled"),
        ...(preview?.kind === "message" ? { preview: preview.message.rawSource } : {}),
        messageCount: Math.max(durable?.messageCount ?? 0, transcriptMessages.length),
        updatedAt: new Date(runtime.updatedAt).toISOString(),
        live: Boolean(runtimeId),
        ...(runtimeId ? { runtimeStatus: runtime.liveStatus } : {}),
        needsInput: runtime.needsInput,
        unread: runtime.unread,
        ...(runtime.error ? { error: runtime.error } : {}),
        status: runtimeId ? "active" : "idle",
      });
    }
    return [...merged.values()].sort((left, right) => (
      new Date(right.updatedAt ?? right.createdAt ?? 0).getTime()
      - new Date(left.updatedAt ?? left.createdAt ?? 0).getTime()
    ));
  }, [activeProfile, runtimeSessions, sessionsQuery.data, tSessions]);
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const commandCatalog = useMemo<NormalizedCommandCatalog>(
    () => normalizeCommandCatalog(commandsQuery.data, locale),
    [commandsQuery.data, locale],
  );
  const commands = useMemo(
    () => commandCatalog.groups.flatMap((group) => group.commands),
    [commandCatalog],
  );
  const slashAvailable = connection === "connected"
    && capabilities?.gateway === true
    && !commandsQuery.isError;
  const slashUnavailableReason = capabilities?.httpFallback && !capabilities.gateway
    ? tCommands("gatewayRequired")
    : commandsQuery.error instanceof Error
      ? `${tCommands("catalogUnavailable")} ${commandsQuery.error.message}`
      : connection === "connected"
        ? tCommands("catalogUnavailable")
        : tCommands("connectionRequired");
  const projectPayload = projectsQuery.data ?? null;
  const projectRecentSessions = useMemo(
    () => sessionsOutsideRenderedProjects(projectPayload, sessions),
    [projectPayload, sessions],
  );
  const dialogProfiles = useMemo(
    () => [...new Set([activeProfile, ...profiles])],
    [activeProfile, profiles],
  );
  const newSessionProjects = useMemo(() => {
    if (projectPayload?.projects.length) {
      return projectPayload.projects.map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.primaryPath ?? project.paths[0],
      }));
    }
    const byCwd = new Map<string, {id: string; name: string; cwd: string}>();
    for (const session of sessions) {
      if (!session.cwd || byCwd.has(session.cwd)) continue;
      const name = session.cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || session.cwd;
      byCwd.set(session.cwd, {id: `cwd:${session.cwd}`, name, cwd: session.cwd});
    }
    return [...byCwd.values()];
  }, [projectPayload, sessions]);

  useEffect(() => {
    if (!commandCatalog.warning) return;
    setNotice({ kind: "warning", message: commandCatalog.warning });
  }, [commandCatalog.warning]);

  const completeSlash = useCallback(async (text: string, signal: AbortSignal): Promise<SlashCompletion> => {
    const gatewayResult = await transport.completeSlash(identityRef.current ?? undefined, text, signal);
    const parsed = parseSlashCommand(text);
    const canonical = parsed ? resolveCanonicalCommand(parsed.normalizedName, commandCatalog) : undefined;
    const hasArgumentSlot = parsed !== null && /\s/u.test(text.slice(parsed.name.length + 1));
    if (canonical && hasArgumentSlot) {
      const replaceFrom = Math.max(0, Math.min(text.length, gatewayResult.replaceFrom));
      const needle = text.slice(replaceFrom).toLocaleLowerCase("en-US");
      const localItems = (() => {
        if (canonical === "model") {
          return models.flatMap((model) => {
            const searchable = `${model.id} ${model.provider}`.toLocaleLowerCase("en-US");
            return searchable.includes(needle)
              ? [{
                  text: `${model.id} --provider ${model.provider}`,
                  display: model.id,
                  meta: model.provider,
                }]
              : [];
          });
        }
        if (canonical === "profile") {
          return profiles
            .filter((profile) => profile.toLocaleLowerCase("en-US").includes(needle))
            .map((profile) => ({ text: profile, display: profile, meta: tSessions("profile") }));
        }
        if (["resume", "sessions", "switch"].includes(canonical)) {
          return sessions.flatMap((session) => {
            const searchable = `${session.storedId} ${session.title}`.toLocaleLowerCase("en-US");
            return searchable.includes(needle)
              ? [{ text: session.storedId, display: session.title, meta: session.storedId }]
              : [];
          });
        }
        if (canonical === "reasoning") {
          return REASONING_EFFORTS
            .filter((effort) => effort.includes(needle))
            .map((effort) => ({ text: effort, display: effort, meta: tModels("reasoning") }));
        }
        if (canonical === "yolo") {
          return ["on", "off", "status"]
            .filter((value) => value.includes(needle))
            .map((value) => ({ text: value, display: value, meta: tPrompts("yoloTitle") }));
        }
        return [];
      })();
      if (localItems.length) return { items: localItems, replaceFrom };
    }

    const completions = normalizeSlashCompletions(text, gatewayResult, commandCatalog);
    return {
      replaceFrom: gatewayResult.replaceFrom,
      items: completions.map((completion) => ({
        text: completion.text,
        display: completion.display,
        meta: completion.description,
      })),
    };
  }, [commandCatalog, models, profiles, sessions, tModels, tPrompts, tSessions, transport]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (event.key === "Escape" && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, commandPaletteOpen, setCommandPaletteOpen]);

  const navigateToSession = useCallback((
    storedId: string,
    mode: "push" | "replace" = "push",
    ownerProfile = activeProfile,
  ) => {
    const path = `/${locale}/c/${encodeURIComponent(storedId)}?profile=${encodeURIComponent(ownerProfile)}`;
    router[mode](path);
    activeStoredIdRef.current = storedId;
    setActiveStoredId(storedId);
  }, [activeProfile, locale, router]);

  async function createSession(input: NewSessionSubmission): Promise<SessionSnapshot | undefined> {
    if (connection !== "connected" || !capabilities?.gateway || !capabilities.sessions) return undefined;
    const ownerProfile = input.profile.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(ownerProfile) || ownerProfile === "all") {
      setNotice({kind: "error", message: tErrors("profileRequired")});
      return undefined;
    }
    const generation = ++resumeGenerationRef.current;
    setLoadingSession(true);
    try {
      const snapshot = await transport.sessionCreate({
        profile: ownerProfile,
        ...(input.title ? { title: input.title } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.fast === undefined ? {} : { fast: input.fast }),
      });
      if (generation === resumeGenerationRef.current) {
        applySnapshot(snapshot, ownerProfile);
        loadedStoredIdRef.current = snapshot.identity.storedId;
        navigateToSession(snapshot.identity.storedId, "push", ownerProfile);
      } else {
        applySnapshot(snapshot, ownerProfile, snapshot.messages, { select: false });
      }
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["hermes-projects"] });
      setMobileRail(null);
      return snapshot;
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
      return undefined;
    } finally {
      if (generation === resumeGenerationRef.current) setLoadingSession(false);
    }
  }

  async function selectSession(session: SessionSummary) {
    if (session.storedId === identity?.storedId) {
      resumeGenerationRef.current += 1;
      setLoadingSession(false);
      useSessionRuntimeStore.getState().markRead({
        profile: session.profile ?? activeProfile,
        storedId: session.storedId,
      });
      setMobileRail(null);
      return;
    }
    const ownerProfile = session.profile ?? activeProfile;
    const selected = await resumeStoredSession(session.storedId, false, ownerProfile, true);
    if (selected) navigateToSession(session.storedId, "push", ownerProfile);
    setMobileRail(null);
  }

  async function selectSearchResult(sessionId: string, ownerProfile: string) {
    if (!sessionId || !ownerProfile || ownerProfile === "all") return;
    const selected = await resumeStoredSession(sessionId, false, ownerProfile, true);
    if (selected) navigateToSession(sessionId, "push", ownerProfile);
    setMobileRail(null);
  }

  async function validateNewSessionCwd(profile: string, cwd: string) {
    try {
      const params = new URLSearchParams({profile, cwd});
      const response = await fetch(`/api/hermes/workspace/validate?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = record(await response.json());
      const canonicalPath = optionalString(payload.canonicalPath);
      if (!response.ok || payload.profile !== profile || !canonicalPath) {
        return {valid: false, error: optionalString(payload.error)};
      }
      setFeatureSupport("workspaceValidate", "available");
      return {valid: true, canonicalPath};
    } catch (error) {
      return {valid: false, error: error instanceof Error ? error.message : undefined};
    }
  }

  async function renameSession(session: SessionSummary, title: string) {
    try {
      const target: SessionIdentity | string = session.storedId === identity?.storedId && identity
        ? identity
        : session.storedId;
      await transport.sessionRename(target, title, activeProfile);
      if (session.storedId === identity?.storedId) setSessionTitle(title);
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    }
  }

  async function deleteSession(session: SessionSummary) {
    const active = identityRef.current;
    const deletingCurrent = active?.storedId === session.storedId;
    if (session.status === "active" && !deletingCurrent) {
      setNotice({ kind: "warning", message: tErrors("unsupported") });
      return;
    }
    let closedCurrent = false;
    try {
      // Hermes deliberately refuses to delete a session while its runtime is
      // active. Close only the current runtime first; inactive sessions can be
      // deleted directly by their durable stored id.
      if (deletingCurrent && active) {
        await transport.sessionClose(active);
        closedCurrent = true;
      }
      await transport.sessionDelete(session.storedId, activeProfile);
    } catch (error) {
      const message = error instanceof Error ? error.message : tErrors("generic");
      refreshCapabilities();
      if (closedCurrent) {
        // Closing preserves history. Restore a usable runtime if the durable
        // delete failed after close instead of leaving a stale identity active.
        loadedStoredIdRef.current = undefined;
        await resumeStoredSession(session.storedId, true);
      }
      setNotice({ kind: "error", message });
      return;
    }
    clearSessionEphemera(chatSessionScopeKey(activeProfile, session.storedId));
    useSessionRuntimeStore.getState().dropSession({
      profile: session.profile ?? activeProfile,
      storedId: session.storedId,
    });
    if (deletingCurrent) {
      resumeGenerationRef.current += 1;
      identityRef.current = null;
      activeStoredIdRef.current = undefined;
      setIdentity(null);
      setActiveStoredId(undefined);
      router.push(`/${locale}?profile=${encodeURIComponent(activeProfile)}`);
    }
    await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
  }

  async function closeSession(session: SessionSummary) {
    const active = identityRef.current;
    if (!active || active.storedId !== session.storedId || !capabilities?.gateway || !capabilities.sessions) return;
    try {
      await transport.sessionClose(active);
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
      throw error;
    }
    resumeGenerationRef.current += 1;
    identityRef.current = null;
    activeStoredIdRef.current = undefined;
    loadedStoredIdRef.current = undefined;
    setIdentity(null);
    setActiveStoredId(undefined);
    useSessionRuntimeStore.getState().dropRuntimeBinding(active.runtimeId);
    useSessionRuntimeStore.getState().selectSession(null);
    setUsageDialog(null);
    setRunning(false);
    router.push(`/${locale}?profile=${encodeURIComponent(activeProfile)}`);
    await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
  }

  async function showSessionUsage(session: SessionSummary) {
    const active = identityRef.current;
    if (!active || active.storedId !== session.storedId || !capabilities?.gateway || !capabilities.sessions) return;
    setUsageDialog({ loading: true });
    try {
      const [data, context] = await Promise.all([
        transport.sessionUsage(active),
        transport.sessionContextBreakdown(active).catch(() => undefined),
      ]);
      setFeatureSupport("contextBreakdown", context ? "available" : "unavailable");
      setUsageDialog({ loading: false, data, ...(context ? { context } : {}) });
    } catch (error) {
      refreshCapabilities();
      setUsageDialog({
        loading: false,
        error: error instanceof Error ? error.message : tErrors("generic"),
      });
    }
  }

  async function openRecovery() {
    const active = identityRef.current;
    if (!active || running || (gatewayContract ?? 0) < 4) return;
    setRecoveryOpen(true);
    setRecoveryLoading(true);
    setRecoveryError(undefined);
    setSelectedCheckpoint(undefined);
    setCheckpointDiff(undefined);
    try {
      setCheckpoints(await transport.rollbackList(active));
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : tErrors("generic"));
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function selectRecoveryCheckpoint(checkpoint: RollbackCheckpoint) {
    const active = identityRef.current;
    if (!active || recoveryBusy) return;
    setSelectedCheckpoint(checkpoint);
    setCheckpointDiff(undefined);
    setRecoveryError(undefined);
    setRecoveryLoading(true);
    try {
      setCheckpointDiff(await transport.rollbackDiff(active, checkpoint.hash));
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : tErrors("generic"));
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function undoLastTurn() {
    const active = identityRef.current;
    if (!active || running || recoveryBusy) return;
    const scopeKey = chatSessionScopeKey(activeProfileRef.current, active.storedId);
    setRecoveryBusy(true);
    setRecoveryError(undefined);
    try {
      const result = await transport.sessionUndo(active);
      const history = await transport.sessionHistory(active);
      useSessionRuntimeStore.getState().updateTranscript(
        { scopeKey },
        () => messagesToTranscript(history),
      );
      setDraft(scopeKey, result.message);
      if (useSessionRuntimeStore.getState().selectedScopeKey === scopeKey) {
        setNotice({ kind: "info", message: result.notice || tSessions("undoSuccess") });
      }
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : tErrors("generic"));
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function restoreCheckpoint(checkpoint: RollbackCheckpoint) {
    const active = identityRef.current;
    if (!active || running || recoveryBusy || (gatewayContract ?? 0) < 4) return;
    const ownerProfile = activeProfileRef.current;
    const scopeKey = chatSessionScopeKey(ownerProfile, active.storedId);
    setRecoveryBusy(true);
    setRecoveryError(undefined);
    try {
      const [processResult, delegationResult] = await Promise.all([
        transport.request("process.list", { session_id: active.runtimeId }),
        transport.request("delegation.status", { session_id: active.runtimeId }),
      ]);
      const processPayload = record(processResult);
      const activeProcesses = Array.isArray(processPayload.processes)
        ? processPayload.processes.filter((value) => {
            const status = String(record(value).status ?? "").toLowerCase();
            return !["complete", "completed", "exited", "failed", "killed"].includes(status);
          })
        : [];
      const delegationPayload = record(delegationResult);
      const activeSubagents = Array.isArray(delegationPayload.active)
        ? delegationPayload.active.length
        : Number(delegationPayload.active_count ?? 0);
      if (activeProcesses.length || activeSubagents > 0) throw new Error(tSessions("rollbackBusy"));
      if (!window.confirm(tSessions("rollbackConfirm"))) return;
      const result = await transport.rollbackRestore(active, checkpoint.hash);
      if (!result.success || result.historySynced !== true) {
        throw new Error(result.message || tSessions("rollbackSyncFailed"));
      }
      const history = await transport.sessionHistory(active);
      useSessionRuntimeStore.getState().updateTranscript(
        { scopeKey },
        () => messagesToTranscript(history),
      );
      useChatUiStore.getState().clearArtifacts(scopeKey);
      setWorkspaceRefreshKey((current) => current + 1);
      const verification = await transport.request("verification.status", {
        session_id: active.runtimeId,
        stored_session_id: active.storedId,
      }).catch(() => null);
      if (verification) {
        const verificationRecord = record(verification);
        recordActivityEvent({
          connectionEpoch: Date.now(),
          id: localId("rollback-verification"),
          payload: verificationRecord.verification ?? verificationRecord,
          receivedAt: Date.now(),
          sessionId: active.runtimeId,
          type: "verification.status",
        }, ownerProfile);
      }
      setRecoveryOpen(false);
      setNotice({ kind: "info", message: tSessions("rollbackSuccess") });
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : tErrors("generic"));
    } finally {
      setRecoveryBusy(false);
    }
  }

  function appendSystemMessage(content: string) {
    if (!content.trim()) return;
    setTranscriptItems((current) => reduceTranscript(current, {
      type: "append-message",
      message: {
        id: localId("command"),
        role: "system",
        content,
        rawSource: content,
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    }));
  }

  function appendCommandMessage(content: string): string {
    const id = localId("command-user");
    setTranscriptItems((current) => reduceTranscript(current, {
      type: "append-message",
      message: {
        id,
        role: "user",
        content,
        rawSource: content,
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    }));
    return id;
  }

  async function refreshCommandHistory(active: SessionIdentity) {
    const history = await transport.sessionHistory(active);
    if (identityRef.current?.runtimeId === active.runtimeId) {
      setTranscriptItems(messagesToTranscript(history));
    }
  }

  async function openProfileWorkspace(profile: string) {
    resumeGenerationRef.current += 1;
    identityRef.current = null;
    activeStoredIdRef.current = undefined;
    setActiveProfile(profile);
    setIdentity(null);
    useSessionRuntimeStore.getState().selectSession(null);
    setActiveStoredId(undefined);
    router.push(`/${locale}?profile=${encodeURIComponent(profile)}`);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["hermes-commands"] }),
    ]);
  }

  async function sendCommandPrompt(active: SessionIdentity, text: string) {
    const startedWhileRunning = running;
    const scopeKey = chatSessionScopeKey(activeProfileRef.current, active.storedId);
    const id = localId("command-send");
    setTranscriptItems((current) => {
      const ordinal = current.reduce(
        (max, item) => item.kind === "message" && item.message.userOrdinal !== undefined
          ? Math.max(max, item.message.userOrdinal)
          : max,
        -1,
      ) + 1;
      return reduceTranscript(current, {
        type: "append-message",
        message: {
          id,
          role: "user",
          content: text,
          rawSource: text,
          createdAt: new Date().toISOString(),
          status: "complete",
          userOrdinal: ordinal,
        },
      });
    });
    if (!startedWhileRunning) setRunning(true);
    try {
      await transport.send(active, text);
    } catch (error) {
      const runtimeStore = useSessionRuntimeStore.getState();
      if (!startedWhileRunning) {
        runtimeStore.updateLiveState({ scopeKey }, { status: "idle", running: false });
      }
      runtimeStore.updateTranscript({ scopeKey }, (current) => reduceTranscript(current, {
        type: "message-status",
        id,
        status: "error",
      }));
      throw error;
    }
  }

  async function dispatchUiCommand(
    parsed: NonNullable<ReturnType<typeof parseSlashCommand>>,
    canonical: string,
    active: SessionIdentity,
    activeKey: string,
  ): Promise<boolean> {
    const args = parsed.args;
    if (canonical === "new" || canonical === "clear") {
      const currentSession = sessions.find((session) => session.storedId === active.storedId);
      const snapshot = await createSession({
        profile: activeProfile,
        ...(args ? { title: args } : {}),
        ...(currentSession?.cwd ? { cwd: currentSession.cwd } : {}),
        ...(currentModelSettings.model ? { model: currentModelSettings.model } : {}),
        ...(currentModelSettings.provider ? { provider: currentModelSettings.provider } : {}),
        ...(currentModelSettings.reasoning ? { reasoningEffort: currentModelSettings.reasoning } : {}),
        ...(currentModelSettings.fast === undefined ? {} : { fast: currentModelSettings.fast }),
      });
      if (snapshot) appendSystemMessage(tCommands("sessionCreated"));
      return true;
    }
    if (canonical === "branch") {
      const snapshot = await branchSession(args || undefined);
      if (snapshot) appendSystemMessage(tCommands("sessionBranched"));
      return true;
    }
    if (canonical === "sessions") {
      if (!args) {
        setMobileRail("sessions");
        return true;
      }
      const needle = args.toLocaleLowerCase();
      const session = sessions.find((candidate) =>
        candidate.storedId.toLocaleLowerCase() === needle
        || candidate.title.toLocaleLowerCase() === needle,
      );
      if (!session) appendSystemMessage(tCommands("sessionNotFound", { session: args }));
      else await selectSession(session);
      return true;
    }
    if (canonical === "model") {
      if (!args) {
        appendSystemMessage(tCommands("currentModel", {
          model: currentModelSettings.model ?? tCommands("defaultValue"),
        }));
        return true;
      }
      const tokens = args.split(/\s+/u);
      const requested = tokens[0]?.toLocaleLowerCase();
      const providerFlag = tokens.findIndex((token) => token === "--provider");
      const requestedProvider = providerFlag >= 0 ? tokens[providerFlag + 1]?.toLocaleLowerCase() : undefined;
      const model = models.find((candidate) =>
        candidate.id.toLocaleLowerCase() === requested
        && (!requestedProvider || candidate.provider.toLocaleLowerCase() === requestedProvider),
      );
      if (!model) {
        appendSystemMessage(tCommands("modelNotFound", { model: tokens[0] ?? args }));
        return true;
      }
      if (messages.length > 8) setNotice({ kind: "warning", message: tModels("cacheWarning") });
      await transport.setModel(active, model.id, model.provider);
      setModelSettings(activeKey, { model: model.id, provider: model.provider });
      await queryClient.invalidateQueries({ queryKey: ["hermes-models"] });
      appendSystemMessage(tCommands("modelChanged", { model: model.id }));
      return true;
    }
    if (canonical === "profile") {
      if (!args) {
        appendSystemMessage(tCommands("currentProfile", { profile: activeProfile }));
        return true;
      }
      const profile = profiles.find((candidate) => candidate.toLocaleLowerCase() === args.toLocaleLowerCase());
      if (!profile) appendSystemMessage(tCommands("profileNotFound", { profile: args }));
      else await openProfileWorkspace(profile);
      return true;
    }
    if (canonical === "title") {
      if (!args) {
        appendSystemMessage(tCommands("currentTitle", { title: sessionTitle }));
        return true;
      }
      await transport.sessionRename(active, args, activeProfile);
      setSessionTitle(args);
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
      appendSystemMessage(tCommands("titleChanged", { title: args }));
      return true;
    }
    if (canonical === "reasoning") {
      if (!args) {
        appendSystemMessage(tCommands("currentReasoning", {
          effort: currentModelSettings.reasoning || tCommands("defaultValue"),
        }));
        return true;
      }
      const effort = REASONING_EFFORTS.find((candidate) => candidate === args.toLocaleLowerCase());
      if (!effort) {
        appendSystemMessage(tCommands("reasoningUsage", { values: REASONING_EFFORTS.join(" | ") }));
        return true;
      }
      await transport.request("config.set", {
        session_id: active.runtimeId,
        key: "reasoning",
        value: effort,
      });
      setModelSettings(activeKey, { reasoning: effort });
      appendSystemMessage(tCommands("reasoningChanged", { effort }));
      return true;
    }
    if (canonical === "yolo") {
      const action = (args || "status").toLocaleLowerCase();
      if (action === "status") {
        appendSystemMessage(currentModelSettings.yolo ? tCommands("yoloOn") : tCommands("yoloOff"));
        return true;
      }
      if (action !== "on" && action !== "off") {
        appendSystemMessage(tCommands("yoloUsage"));
        return true;
      }
      const result = record(await transport.request("config.set", {
        session_id: active.runtimeId,
        key: "yolo",
        value: action,
        scope: "session",
      }));
      const enabled = String(result.value ?? action).toLocaleLowerCase() === "1"
        || String(result.value ?? action).toLocaleLowerCase() === "on";
      setModelSettings(activeKey, { yolo: enabled });
      appendSystemMessage(enabled ? tCommands("yoloOn") : tCommands("yoloOff"));
      return true;
    }
    if (canonical === "queue") {
      if (!args) {
        appendSystemMessage(queue.length
          ? tCommands("queueCount", { count: queue.length })
          : tCommands("queueEmpty"));
      } else {
        enqueuePrompt(activeKey, args);
        appendSystemMessage(tCommands("queued"));
      }
      return true;
    }
    if (canonical === "steer") {
      if (!args) {
        appendSystemMessage(tCommands("steerUsage"));
        return true;
      }
      const accepted = await transport.steer(active, args);
      appendSystemMessage(accepted ? tCommands("steerAccepted") : tCommands("steerUnavailable"));
      return true;
    }
    if (canonical === "help") {
      setCommandPaletteOpen(true);
      return true;
    }
    if (canonical === "journey") {
      router.push(`/${locale}/knowledge`);
      return true;
    }
    if (canonical === "copy") {
      const assistantMessages = messages.filter((message) => message.role === "assistant" && message.rawSource.trim());
      const requested = args ? Number(args) : assistantMessages.length;
      if (!Number.isInteger(requested) || requested < 1 || requested > assistantMessages.length) {
        appendSystemMessage(assistantMessages.length
          ? tCommands("copyUsage", { count: assistantMessages.length })
          : tCommands("copyNothing"));
        return true;
      }
      await navigator.clipboard.writeText(assistantMessages[requested - 1]!.rawSource);
      appendSystemMessage(tCommands("copiedResponse", { number: requested }));
      return true;
    }
    return false;
  }

  async function dispatchSlashCommand(
    text: string,
    parsed: NonNullable<ReturnType<typeof parseSlashCommand>>,
    active: SessionIdentity,
    activeKey: string,
  ) {
    const commandMessageId = appendCommandMessage(text);
    setDraft(activeKey, "");
    const gatewayCanonical = resolveCanonicalCommand(parsed.normalizedName, commandCatalog);
    const canonical = UI_COMMAND_ALIASES[parsed.normalizedName] ?? gatewayCanonical;
    const known = findCommandOption(commandCatalog, parsed.normalizedName);
    const unavailable = known?.surface === "unavailable" || isWebCommandUnavailable(parsed.normalizedName, known?.category);

    try {
      if (!capabilities?.gateway) {
        appendSystemMessage(tCommands("gatewayRequired"));
        return;
      }
      if (unavailable) {
        appendSystemMessage(
          getWebCommandUnavailableReason(parsed.normalizedName, locale) ?? tCommands("webUnavailable"),
        );
        return;
      }
      if (await dispatchUiCommand(parsed, canonical, active, activeKey)) return;

      const result = await transport.executeCommand(active, text);
      const resultCommand = parseSlashCommand(result.resolvedCommand)?.normalizedName ?? canonical;
      if (result.kind === "prefill" || HISTORY_MUTATING_COMMANDS.has(resultCommand)) {
        await refreshCommandHistory(active);
      }
      if (CATALOG_MUTATING_COMMANDS.has(resultCommand)) {
        if (result.kind === "send") catalogRefreshAfterRunRef.current = true;
        else await queryClient.invalidateQueries({ queryKey: ["hermes-commands"] });
      }
      if (result.warning) appendSystemMessage(result.warning);
      if (result.kind === "output") {
        appendSystemMessage(result.output);
      } else if (result.kind === "prefill") {
        setDraft(activeKey, result.message);
        if (result.notice) appendSystemMessage(result.notice);
      } else {
        if (result.notice) appendSystemMessage(result.notice);
        await sendCommandPrompt(active, result.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : tErrors("generic");
      setTranscriptItems((current) => reduceTranscript(current, {
        type: "message-status",
        id: commandMessageId,
        status: "error",
      }));
      appendSystemMessage(message);
      setNotice({ kind: "error", message });
    }
  }

  async function dispatchMessage(
    source: string,
    mode: "send" | "steer" = "send",
    interpretSlash = true,
  ) {
    const active = identityRef.current;
    if (!active) return;
    const activeKey = chatSessionScopeKey(activeProfile, active.storedId);
    const readyAttachments = (useChatUiStore.getState().attachments[activeKey] ?? []).filter(
      (attachment) => attachment.status === "ready",
    );
    const baseText = source.trim() || (locale === "fa" ? "فایل پیوست‌شده را بررسی کن." : "Please review the attached file.");
    const slashCommand = interpretSlash ? parseSlashCommand(baseText) : null;
    if (slashCommand) {
      await dispatchSlashCommand(baseText, slashCommand, active, activeKey);
      return;
    }

    const fileReferences = [...new Set(
      readyAttachments
        .filter((attachment) => attachment.kind === "file")
        .map((attachment) => attachment.refText)
        .filter((reference): reference is string => Boolean(reference)),
    )];
    const text = [
      baseText,
      ...fileReferences.filter((reference) => !baseText.includes(reference)),
    ].join("\n\n");
    if (!text) return;
    if (mode === "steer") {
      try {
        const accepted = await transport.steer(active, text);
        if (accepted) {
          setDraft(activeKey, "");
          clearSubmittedAttachments(activeKey, readyAttachments.map((attachment) => attachment.id));
        } else {
          enqueuePrompt(activeKey, text);
          setDraft(activeKey, "");
        }
      } catch (error) {
        setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
      }
      return;
    }
    if (running) {
      enqueuePrompt(activeKey, text);
      setDraft(activeKey, "");
      return;
    }
    const userMessage: ChatMessage = {
      id: localId("user"),
      role: "user",
      content: text,
      rawSource: text,
      createdAt: new Date().toISOString(),
      status: "complete",
      userOrdinal: transcriptItems.reduce(
        (max, item) => item.kind === "message" && item.message.userOrdinal !== undefined
          ? Math.max(max, item.message.userOrdinal)
          : max,
        -1,
      ) + 1,
    };
    setTranscriptItems((current) => reduceTranscript(current, { type: "append-message", message: userMessage }));
    setRunning(true);
    try {
      await transport.send(active, text);
      setDraft(activeKey, "");
      clearSubmittedAttachments(activeKey, readyAttachments.map((attachment) => attachment.id));
    } catch (error) {
      const runtimeStore = useSessionRuntimeStore.getState();
      runtimeStore.updateLiveState({ scopeKey: activeKey }, {
        status: "idle",
        running: false,
        error: error instanceof Error ? error.message : tErrors("generic"),
        markUnread: true,
      });
      runtimeStore.updateTranscript({ scopeKey: activeKey }, (current) => reduceTranscript(current, {
        type: "message-status",
        id: userMessage.id,
        status: "error",
      }));
      if (runtimeStore.selectedScopeKey === activeKey) {
        setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
      }
    }
  }

  async function rewindAndSubmit(target: ChatMessage, text: string) {
    const active = identityRef.current;
    if (!active || target.userOrdinal === undefined || running || (gatewayContract ?? 0) < 4) return;
    const scopeKey = chatSessionScopeKey(activeProfileRef.current, active.storedId);
    if (!window.confirm(tChat("rewindConfirm"))) return;
    const previous = transcriptItems;
    const index = previous.findIndex((item) => item.kind === "message" && item.message.id === target.id);
    if (index < 0) {
      setNotice({ kind: "warning", message: tChat("rewindFailed") });
      return;
    }
    const replacement: ChatMessage = {
      id: localId("user-rewind"),
      role: "user",
      content: text,
      rawSource: text,
      createdAt: new Date().toISOString(),
      status: "complete",
      userOrdinal: target.userOrdinal,
    };
    setTranscriptItems([
      ...previous.slice(0, index),
      { kind: "message", key: `message:${replacement.id}`, message: replacement },
    ]);
    setRunning(true);
    try {
      await transport.send(active, text, {
        busyMode: "reject",
        truncateBeforeUserOrdinal: target.userOrdinal,
      });
      setDraft(chatSessionScopeKey(activeProfile, active.storedId), "");
    } catch (error) {
      try {
        const authoritative = await transport.sessionHistory(active);
        useSessionRuntimeStore.getState().updateTranscript(
          { scopeKey },
          () => messagesToTranscript(authoritative),
        );
      } catch {
        useSessionRuntimeStore.getState().updateTranscript({ scopeKey }, () => previous);
      }
      useSessionRuntimeStore.getState().updateLiveState(
        { scopeKey },
        { status: "idle", running: false },
      );
      if (useSessionRuntimeStore.getState().selectedScopeKey === scopeKey) {
        setNotice({
          kind: "error",
          message: error instanceof Error ? error.message : tChat("rewindFailed"),
        });
      }
    }
  }

  async function regenerateMessage(message: ChatMessage) {
    const assistantIndex = transcriptItems.findIndex(
      (item) => item.kind === "message" && item.message.id === message.id,
    );
    if (assistantIndex < 0) return;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      const item = transcriptItems[index];
      if (item?.kind === "message" && item.message.role === "user" && item.message.userOrdinal !== undefined) {
        await rewindAndSubmit(item.message, item.message.rawSource);
        return;
      }
    }
    setNotice({ kind: "warning", message: tChat("rewindFailed") });
  }

  const drainRuntimeQueue = useCallback(async (scopeKey: string) => {
    if (drainingSessionScopesRef.current.has(scopeKey)) return;
    const runtimeStore = useSessionRuntimeStore.getState();
    const session = runtimeStore.sessions[scopeKey];
    if (
      !session?.identity.runtimeId
      || session.running
      || session.needsInput
      || session.liveStatus !== "idle"
    ) return;
    const next = useChatUiStore.getState().shiftQueuedPrompt(scopeKey);
    if (!next) return;
    drainingSessionScopesRef.current.add(scopeKey);
    runtimeStore.setStreamMetadata({ scopeKey }, { processingQueue: true });
    const id = localId("user-queued");
    const userOrdinal = session.transcriptItems.reduce(
      (max, item) => item.kind === "message" && item.message.userOrdinal !== undefined
        ? Math.max(max, item.message.userOrdinal)
        : max,
      -1,
    ) + 1;
    runtimeStore.updateTranscript({ scopeKey }, (current) => reduceTranscript(current, {
      type: "append-message",
      message: {
        id,
        role: "user",
        content: next,
        rawSource: next,
        createdAt: new Date().toISOString(),
        status: "complete",
        userOrdinal,
      },
    }));
    runtimeStore.updateLiveState({ scopeKey }, {
      status: "starting",
      running: true,
      error: null,
    });
    try {
      await transport.send({
        storedId: session.identity.storedId,
        runtimeId: session.identity.runtimeId,
        ...(session.identity.lineageRootId
          ? { lineageRootId: session.identity.lineageRootId }
          : {}),
      }, next);
      const uiState = useChatUiStore.getState();
      const submitted = uiState.attachments[scopeKey]?.filter((item) => item.status === "ready") ?? [];
      for (const attachment of submitted) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      if (submitted.length) {
        const submittedIds = new Set(submitted.map((item) => item.id));
        uiState.setAttachments(
          scopeKey,
          (uiState.attachments[scopeKey] ?? []).filter((item) => !submittedIds.has(item.id)),
        );
      }
    } catch (error) {
      runtimeStore.updateTranscript({ scopeKey }, (current) => reduceTranscript(current, {
        type: "message-status",
        id,
        status: "error",
      }), { markUnread: true });
      runtimeStore.updateLiveState({ scopeKey }, {
        status: "idle",
        running: false,
        error: error instanceof Error ? error.message : tErrors("generic"),
        markUnread: true,
      });
    } finally {
      drainingSessionScopesRef.current.delete(scopeKey);
      useSessionRuntimeStore.getState().setStreamMetadata({ scopeKey }, { processingQueue: false });
    }
  }, [tErrors, transport]);

  useEffect(() => {
    if (connection !== "connected") return;
    const runtimeStore = useSessionRuntimeStore.getState();
    for (const session of Object.values(runtimeStore.sessions)) {
      if ((queuedPrompts[session.scopeKey]?.length ?? 0) > 0) {
        void drainRuntimeQueue(session.scopeKey);
      }
    }
  }, [connection, drainRuntimeQueue, queuedPrompts, runtimeSessions]);

  async function stopRun() {
    if (!identity) return;
    const target = useSessionRuntimeStore.getState().findByRuntime(identity.runtimeId);
    if (!target) return;
    try {
      await transport.stop(identity);
      const runtimeStore = useSessionRuntimeStore.getState();
      const latest = runtimeStore.sessions[target.scopeKey] ?? target;
      runtimeStore.updateLiveState({ scopeKey: target.scopeKey }, {
        status: "idle",
        running: false,
        needsInput: false,
      });
      const id = latest.stream.assistantMessageId
        ?? `${latest.stream.assistantRunId ?? localId("assistant")}:text:${latest.stream.assistantPartSequence}`;
      if (id) {
        runtimeStore.updateTranscript({ scopeKey: target.scopeKey }, (current) => {
          const exists = current.some((item) => item.kind === "message" && item.message.id === id);
          return exists
            ? reduceTranscript(current, { type: "message-status", id, status: "interrupted" })
            : reduceTranscript(current, {
                type: "append-message",
                message: {
                  id,
                  role: "assistant",
                  content: "",
                  rawSource: "",
                  createdAt: new Date().toISOString(),
                  status: "interrupted",
                },
              });
        });
      }
      if (latest.stream.lastReasoningId) {
        runtimeStore.updateTranscript({ scopeKey: target.scopeKey }, (current) => reduceTranscript(current, {
          type: "reasoning-status",
          id: latest.stream.lastReasoningId!,
          status: "interrupted",
        }));
      }
      runtimeStore.setStreamMetadata({ scopeKey: target.scopeKey }, {
        assistantRunId: null,
        assistantMessageId: null,
        reasoningId: null,
        lastReasoningId: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : tErrors("generic");
      useSessionRuntimeStore.getState().updateLiveState({ scopeKey: target.scopeKey }, {
        error: message,
        markUnread: true,
      });
      if (useSessionRuntimeStore.getState().selectedScopeKey === target.scopeKey) {
        setNotice({ kind: "error", message });
      }
    }
  }

  async function attachFiles(files: File[]) {
    if (!identity || !capabilities?.attachments) return;
    const targetIdentity = identity;
    const attachmentKey = chatSessionScopeKey(activeProfile, targetIdentity.storedId);
    const current = attachmentsBySession[attachmentKey] ?? [];
    const pending: ComposerAttachment[] = files.map((file) => {
      const kind = file.type.startsWith("image/") ? "image" : file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "file";
      const limit = kind === "image" ? MAX_IMAGE_BYTES : kind === "pdf" ? MAX_PDF_BYTES : MAX_FILE_BYTES;
      return {
        id: localId("attachment"),
        name: file.name,
        kind,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        status: file.size > limit ? "failed" : "uploading",
        ...(file.size > limit ? { error: tAttachments("tooLarge") } : {}),
        ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
        file,
      };
    });
    setAttachments(attachmentKey, [...current, ...pending]);
    await Promise.all(pending.map(async (attachment) => {
      if (attachment.status === "failed" || !attachment.file) return;
      try {
        const dataUrl = await blobToDataUrl(attachment.file);
        const remote = await transport.attach(targetIdentity, {
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          dataUrl,
        });
        const latest = useChatUiStore.getState().attachments[attachmentKey] ?? [];
        setAttachments(attachmentKey, latest.map((item) =>
          item.id === attachment.id
            ? {
                ...item,
                status: "ready",
                remoteId: remote.id,
                ...(remote.refText ? { refText: remote.refText } : {}),
                file: undefined,
              }
            : item,
        ));
      } catch (error) {
        refreshCapabilities();
        const latest = useChatUiStore.getState().attachments[attachmentKey] ?? [];
        setAttachments(attachmentKey, latest.map((item) =>
          item.id === attachment.id
            ? { ...item, status: "failed", error: error instanceof Error ? error.message : tAttachments("failed"), file: undefined }
            : item,
        ));
      }
    }));
  }

  async function attachWorkspaceEntry(entry: WorkspaceEntry) {
    const active = identityRef.current;
    if (!active || !capabilities?.attachments || running) return;
    const attachmentKey = chatSessionScopeKey(activeProfile, active.storedId);
    const pending: ComposerAttachment = {
      id: localId("workspace-attachment"),
      name: entry.name,
      kind: "file",
      size: entry.size ?? 0,
      mimeType: entry.mimeType ?? "application/octet-stream",
      status: "uploading",
    };
    const current = useChatUiStore.getState().attachments[attachmentKey] ?? [];
    setAttachments(attachmentKey, [...current, pending]);
    try {
      const remote = await transport.attach(active, {
        kind: "file",
        name: entry.name,
        mimeType: pending.mimeType,
        size: pending.size,
        path: entry.path,
      });
      const latest = useChatUiStore.getState().attachments[attachmentKey] ?? [];
      setAttachments(attachmentKey, latest.map((item) => item.id === pending.id
        ? {
            ...item,
            status: "ready",
            remoteId: remote.id,
            ...(remote.refText ? {refText: remote.refText} : {}),
          }
        : item));
    } catch (error) {
      const latest = useChatUiStore.getState().attachments[attachmentKey] ?? [];
      setAttachments(attachmentKey, latest.map((item) => item.id === pending.id
        ? {...item, status: "failed", error: error instanceof Error ? error.message : tAttachments("failed")}
        : item));
      throw error;
    }
  }

  function removeAttachment(id: string) {
    if (!identity) return;
    const attachmentKey = chatSessionScopeKey(activeProfile, identity.storedId);
    const current = attachmentsBySession[attachmentKey] ?? [];
    const target = current.find((item) => item.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    setAttachments(attachmentKey, current.filter((item) => item.id !== id));
  }

  function clearSubmittedAttachments(sessionId: string, submittedIds: string[]) {
    if (!submittedIds.length) return;
    const submitted = new Set(submittedIds);
    const current = useChatUiStore.getState().attachments[sessionId] ?? [];
    for (const attachment of current) {
      if (submitted.has(attachment.id) && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments(sessionId, current.filter((attachment) => !submitted.has(attachment.id)));
  }

  async function respondToPrompt(prompt: InteractivePrompt, response: PromptResponse) {
    const runtimeState = useSessionRuntimeStore.getState();
    const selectedScopeKey = runtimeState.selectedScopeKey;
    const domain = selectedScopeKey
      ? runtimeState.sessions[selectedScopeKey]?.domainPrompts[prompt.id]
      : undefined;
    if (!domain) return;
    let accepted = false;
    if (domain.kind === "approval" && (response.action === "approve-once" || response.action === "approve-always" || response.action === "deny")) {
      accepted = await transport.respondToApproval(
        domain,
        response.action === "approve-once" ? "once" : response.action === "approve-always" ? "always" : "deny",
      );
    } else if (domain.kind === "clarification" && response.action === "answer") {
      accepted = await transport.respondToClarification(domain, response.value);
    } else if (domain.kind === "sudo" && response.action === "sudo") {
      accepted = await transport.respondToSudo(domain, response.value);
    } else if (domain.kind === "secret" && response.action === "secret") {
      accepted = await transport.respondToSecret(domain, response.value);
    }
    if (accepted) {
      if (selectedScopeKey) {
        const runtimeStore = useSessionRuntimeStore.getState();
        runtimeStore.removeDomainPrompt({ scopeKey: selectedScopeKey }, prompt.id);
        runtimeStore.updateTranscript(
          { scopeKey: selectedScopeKey },
          (current) => reduceTranscript(current, { type: "remove-prompt", id: prompt.id }),
        );
      }
    }
  }

  async function changeModel(model: ModelOption) {
    if (!identity) return;
    const targetIdentity = identity;
    const scopeKey = chatSessionScopeKey(activeProfileRef.current, identity.storedId);
    if (messages.length > 8) setNotice({ kind: "warning", message: tModels("cacheWarning") });
    try {
      await transport.setModel(targetIdentity, model.id, model.provider);
      setModelSettings(scopeKey, { model: model.id, provider: model.provider });
      await queryClient.invalidateQueries({ queryKey: ["hermes-models"] });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    }
  }

  async function setSessionReasoning(value: string) {
    if (!identity) return;
    const targetIdentity = identity;
    const scopeKey = chatSessionScopeKey(activeProfileRef.current, identity.storedId);
    try {
      await transport.request("config.set", {
        session_id: targetIdentity.runtimeId,
        key: "reasoning",
        value,
      });
      setModelSettings(scopeKey, { reasoning: value });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    }
  }

  async function branchSession(name?: string): Promise<SessionSnapshot | undefined> {
    if (!identity) return undefined;
    const targetIdentity = identity;
    const ownerProfile = activeProfileRef.current;
    const generation = ++resumeGenerationRef.current;
    setSessionActionBusy(true);
    try {
      const snapshot = await transport.sessionBranch(targetIdentity, name);
      if (generation === resumeGenerationRef.current) {
        applySnapshot(snapshot, ownerProfile);
        loadedStoredIdRef.current = snapshot.identity.storedId;
        navigateToSession(snapshot.identity.storedId, "push", ownerProfile);
        setSessionAction(null);
      } else {
        applySnapshot(snapshot, ownerProfile, snapshot.messages, { select: false });
      }
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
      return snapshot;
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
      return undefined;
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function compressSession(focusTopic?: string) {
    if (!identity) return;
    const targetIdentity = identity;
    const scopeKey = chatSessionScopeKey(activeProfileRef.current, identity.storedId);
    setSessionActionBusy(true);
    try {
      const compressed = await transport.sessionCompress(targetIdentity, focusTopic);
      useSessionRuntimeStore.getState().updateTranscript(
        { scopeKey },
        () => messagesToTranscript(compressed),
      );
      if (useSessionRuntimeStore.getState().selectedScopeKey === scopeKey) setSessionAction(null);
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function transcribe(blob: Blob) {
    const text = await transcribeAudioBlob(blob);
    if (text) setDraft(composerKey, `${draft}${draft ? " " : ""}${text}`);
  }

  async function speak(text: string): Promise<SpeechPlayback> {
    speechPlaybackRef.current?.stop();
    speechPlaybackRef.current = null;
    const dataUrl = await synthesizeSpeech(text);
    const audio = new Audio(dataUrl);
    audio.preload = "auto";

    let settled = false;
    let resolveFinished: (() => void) | undefined;
    let rejectFinished: ((error: Error) => void) | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    const onEnded = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFinished?.();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectFinished?.(new Error(locale === "fa" ? "پخش صدای ساخته‌شده ناموفق بود." : "Audio playback failed."));
    };
    const playback: SpeechPlayback = {
      finished,
      stop: () => {
        if (settled) return;
        settled = true;
        cleanup();
        audio.pause();
        audio.removeAttribute("src");
        resolveFinished?.();
      },
    };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    speechPlaybackRef.current = playback;
    void finished.then(
      () => {
        if (speechPlaybackRef.current === playback) speechPlaybackRef.current = null;
      },
      () => {
        if (speechPlaybackRef.current === playback) speechPlaybackRef.current = null;
      },
    );
    try {
      await audio.play();
    } catch (error) {
      playback.stop();
      throw error;
    }
    return playback;
  }

  async function retryConnection() {
    setNotice(null);
    setConnection("connecting");
    try {
      const info = await transport.connect();
      setBootstrap(info);
      setCapabilities(transport.capabilities);
      if (
        !transport.capabilities.gateway &&
        transport.capabilities.httpFallback &&
        !activeStoredIdRef.current
      ) {
        const snapshot = await transport.sessionCreate(
          { profile: activeProfile },
        );
        applySnapshot(snapshot, activeProfile);
        loadedStoredIdRef.current = snapshot.identity.storedId;
        router.replace(
          `/${locale}/c/${encodeURIComponent(snapshot.identity.storedId)}?profile=${encodeURIComponent(activeProfile)}`,
        );
      }
    } catch (error) {
      const incompatible = isProtocolIncompatibility(error);
      setConnection(incompatible ? "incompatible" : "error");
      setNotice({
        kind: "error",
        message: incompatible
          ? tErrors("incompatibleProtocol")
          : error instanceof Error
            ? error.message
            : tErrors("backendUnavailable"),
      });
    }
  }

  const gatewaySessionControls = Boolean(
    connection === "connected" && capabilities?.gateway && capabilities.sessions,
  );
  const emptyState = (() => {
    if (connection === "incompatible") {
      return {
        title: tErrors("incompatibleProtocol"),
        body: tErrors("unsupported"),
      };
    }
    if (connection === "connecting") {
      return {
        title: tConnection("connecting"),
        body: tConnection("connectingDescription"),
      };
    }
    if (connection === "reconnecting") {
      return {
        title: tConnection("reconnecting"),
        body: tConnection("reconnectingDescription"),
      };
    }
    if (connection === "disconnected" || connection === "error") {
      return {
        title: connection === "disconnected" ? tConnection("disconnected") : tConnection("unavailable"),
        body: tConnection("disconnectedDescription"),
      };
    }
    if (capabilities?.sessions === false) {
      return {
        title: tChat("sessionsUnavailableTitle"),
        body: tChat("sessionsUnavailableDescription"),
      };
    }
    if (!identity) {
      return {
        title: tChat("firstLaunchTitle"),
        body: tChat("firstLaunchDescription"),
        action: gatewaySessionControls ? tChat("firstLaunchAction") : undefined,
      };
    }
    return { title: tChat("emptyTitle"), body: tChat("emptyDescription") };
  })();

  return (
    <div className="app-shell" data-testid="app-shell">
      <SessionRail
        sessions={sessions}
        activeSessionId={identity?.storedId ?? activeStoredId}
        locale={locale}
        loading={sessionsQuery.isLoading || loadingSession || (projectTreeEnabled && projectsQuery.isLoading)}
        mobileOpen={openMobileRail === "sessions"}
        labels={{
          title: tSessions("title"),
          newSession: tSessions("new"),
          search: tSessions("searchPlaceholder"),
          empty: tSessions("empty"),
          noResults: tSessions("noResults"),
          rename: tSessions("rename"),
          delete: tSessions("delete"),
          close: tSessions("close"),
          usage: tSessions("usage"),
          cancel: tSessions("cancel"),
          confirmDelete: tSessions("confirmDelete"),
          confirmClose: tSessions("confirmClose"),
          closeDescription: tSessions("closeDescription"),
          renameTitle: tSessions("renameTitle"),
          statusNeedsInput: tSessions("statusNeedsInput"),
          statusError: tSessions("statusError"),
          statusStarting: tSessions("statusStarting"),
          statusWorking: tSessions("statusWorking"),
          statusUnread: tSessions("statusUnread"),
          statusIdle: tSessions("statusIdle"),
        }}
        projectBrowser={(
          <ProjectSessionBrowser
            activeSessionId={identity?.storedId ?? activeStoredId}
            fallbackSessions={sessions}
            locale={locale}
            onSelectSession={(sessionId) => selectSearchResult(sessionId, activeProfile)}
            payload={projectPayload}
          />
        )}
        projectRecentSessions={projectRecentSessions}
        canCreate={gatewaySessionControls}
        canManage={gatewaySessionControls}
        onCloseMobile={() => setMobileRail(null)}
        onCreate={() => setNewSessionOpen(true)}
        onSelect={(session) => void selectSession(session)}
        onRename={renameSession}
        onDelete={deleteSession}
        onClose={gatewaySessionControls && identity ? closeSession : undefined}
        onUsage={gatewaySessionControls && identity ? showSessionUsage : undefined}
        searchEnabled={connection === "connected"}
        searchProfile={activeProfile}
        onSearchCapabilityChange={reportSessionSearchCapability}
        onSelectSearchResult={(result) => selectSearchResult(result.sessionId, result.profile)}
      />

      <section className="chat-main" id={active ? "main-content" : undefined}>
        <ChatHeader
          locale={locale}
          title={sessionTitle}
          connection={connection}
          backendVersion={bootstrap?.backend?.version}
          models={models}
          modelSettings={identity ? currentModelSettings : {}}
          profiles={profiles}
          activeProfile={activeProfile}
          capabilities={capabilities}
          running={running}
          labels={{
            appName: tApp("name"),
            openSessions: tNav("openSessions"),
            openWorkspace: tNav("openWorkspace"),
            settings: tNav("settings"),
            connected: tConnection("connected"),
            connecting: tConnection("connecting"),
            reconnecting: tConnection("reconnecting"),
            disconnected: tConnection("disconnected"),
            unavailable: tConnection("unavailable"),
            model: tModels("title"),
            profile: tSessions("profile"),
            reasoning: tModels("reasoning"),
            fastMode: tModels("fastMode"),
            theme: tSettings("theme"),
            branch: tSessions("branch"),
            compress: tSessions("compress"),
            recovery: tSessions("recovery"),
          }}
          onOpenSessions={() => setMobileRail("sessions")}
          onOpenArtifacts={() => {
            setRightRailMode("files");
            setArtifactRailOpen(true);
            setMobileRail("artifacts");
          }}
          onModelChange={changeModel}
          onProfileChange={openProfileWorkspace}
          onReasoningChange={setSessionReasoning}
          onBranch={() => setSessionAction("branch")}
          onCompress={() => setSessionAction("compress")}
          onRecovery={identity && !running && (gatewayContract ?? 0) >= 4 ? () => void openRecovery() : undefined}
        />

        {notice ? (
          <div className={`shell-notice shell-notice--${notice.kind}`} role="alert">
            <AlertTriangle aria-hidden="true" size={18} />
            <p className="bidi-block">{notice.message}</p>
            {connection === "error" || connection === "disconnected" || connection === "incompatible" ? (
              <button type="button" className="button button--secondary" onClick={() => void retryConnection()}>
                <RefreshCw aria-hidden="true" size={16} />
                {tConnection("retry")}
              </button>
            ) : null}
            <button type="button" className="icon-button" aria-label={tActions("close")} onClick={() => setNotice(null)}>
              <X aria-hidden="true" size={17} />
            </button>
          </div>
        ) : null}

        <Transcript
          items={transcriptItems}
          locale={locale}
          activeTitle={sessionTitle}
          labels={{
            emptyTitle: emptyState.title,
            emptyBody: emptyState.body,
            you: tChat("you"),
            assistant: tChat("assistant"),
            system: tChat("system"),
            tool: tChat("tool"),
            copy: tChat("copy"),
            copied: tChat("copied"),
            reasoning: tChat("reasoning"),
            jumpLatest: tChat("jumpToLatest"),
            interrupted: tChat("interrupted"),
            speak: tChat("speak"),
            stopSpeaking: tChat("stopSpeaking"),
            speechPreparing: tChat("speechPreparing"),
            toolRunning: tStatus("running"),
            toolComplete: tStatus("completed"),
            toolFailed: tStatus("failed"),
            toolCancelled: tStatus("cancelled"),
            toolQueued: tTools("queued"),
            toolInput: tTools("input"),
            toolOutput: tTools("output"),
            toolDetails: tTools("details"),
            approveOnce: tPrompts("approveOnce"),
            approveAlways: tPrompts("approveAlways"),
            deny: tPrompts("deny"),
            submit: tPrompts("submit"),
            cancel: tPrompts("cancel"),
            expired: tPrompts("expired"),
            secretPlaceholder: tPrompts("secretPlaceholder"),
            sudoPlaceholder: tPrompts("sudoPlaceholder"),
            edit: tChat("edit"),
            saveEdit: tChat("saveEdit"),
            regenerate: tChat("regenerate"),
          }}
          emptyActionLabel={emptyState.action}
          ttsEnabled={capabilities?.voice}
          onEmptyAction={emptyState.action ? () => setNewSessionOpen(true) : undefined}
          onSpeak={capabilities?.voice ? speak : undefined}
          onSpeechError={(message) => setNotice({ kind: "warning", message })}
          onPromptResponse={respondToPrompt}
          canRewind={Boolean(identity && !running && (gatewayContract ?? 0) >= 4)}
          onEditMessage={(message, text) => rewindAndSubmit(message, text)}
          onRegenerate={regenerateMessage}
        />

        <Composer
          sessionId={composerKey}
          value={draft}
          attachments={attachments}
          queue={queue}
          commands={commands}
          slashAvailable={slashAvailable}
          slashUnavailableReason={slashUnavailableReason}
          disabled={!identity || connection !== "connected" || loadingSession}
          running={running}
          attachmentsEnabled={capabilities?.attachments === true}
          voiceEnabled={capabilities?.voice}
          labels={{
            placeholder: tComposer("placeholder"),
            send: tComposer("send"),
            stop: tComposer("stop"),
            attach: tComposer("attach"),
            removeAttachment: tComposer("removeAttachment"),
            attachmentFailed: tComposer("attachmentFailed"),
            queue: tComposer("queue"),
            editQueued: tComposer("editQueued"),
            deleteQueued: tComposer("deleteQueued"),
            steer: tComposer("steer"),
            voice: tComposer("voice"),
            stopRecording: tComposer("stopRecording"),
            transcribe: tComposer("transcribe"),
            cancel: tComposer("cancel"),
            dropFiles: tComposer("dropFiles"),
            commandPalette: tComposer("commandPalette"),
          }}
          onChange={(value) => setDraft(composerKey, value)}
          onSend={(value) => dispatchMessage(value)}
          onStop={stopRun}
          onSteer={(value) => dispatchMessage(value, "steer")}
          onAttach={attachFiles}
          onRemoveAttachment={removeAttachment}
          onReplaceQueued={(index, value) => replaceQueuedPrompt(composerKey, index, value)}
          onRemoveQueued={(index) => removeQueuedPrompt(composerKey, index)}
          onVoice={transcribe}
          onVoiceError={(message) => setNotice({ kind: "warning", message })}
          onCompleteSlash={completeSlash}
        />
      </section>

      {rightRailMode === "files" ? (
        <WorkspaceFilesRail
          artifactCount={artifacts.length}
          locale={locale}
          mobileOpen={openMobileRail === "artifacts"}
          onAttach={
            identity && connection === "connected" && capabilities?.gateway && capabilities.attachments && !running
              ? attachWorkspaceEntry
              : undefined
          }
          onCapabilityChange={reportWorkspaceCapability}
          onClose={() => {
            setArtifactRailOpen(false);
            setMobileRail(null);
          }}
          onOpenArtifacts={() => setRightRailMode("artifacts")}
          open={artifactRailOpen}
          profile={activeProfile}
          refreshKey={workspaceRefreshKey}
          sessionId={identity?.storedId}
          width={artifactRailWidth}
        />
      ) : (
        <ArtifactRail
          artifacts={artifacts}
          selectedId={selectedArtifactId}
          open={artifactRailOpen}
          mobileOpen={openMobileRail === "artifacts"}
          width={artifactRailWidth}
          labels={{
            title: tTools("title"),
            empty: tAttachments("previewUnavailable"),
            close: tNav("closePanel"),
            resize: tNav("collapseSidebar"),
            previewUnavailable: tAttachments("previewUnavailable"),
          }}
          onSelect={(id) => selectArtifact(composerKey, id)}
          onClose={() => {
            setArtifactRailOpen(false);
            setMobileRail(null);
          }}
          onWidthChange={setArtifactRailWidth}
        />
      )}

      {openMobileRail ? (
        <button
          type="button"
          className="shell-overlay"
          aria-label={tNav("closePanel")}
          onClick={() => setMobileRail(null)}
        />
      ) : null}

      {usageDialog ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal usage-modal" role="dialog" aria-modal="true" aria-labelledby="usage-title" data-testid="usage-dialog">
            <h3 id="usage-title">{tSessions("usageTitle")}</h3>
            {usageDialog.loading ? (
              <p role="status">{tSessions("usageLoading")}</p>
            ) : usageDialog.error ? (
              <p className="danger-text bidi-block" role="alert">{usageDialog.error}</p>
            ) : usageDialog.data ? (
              <dl className="usage-grid">
                <div>
                  <dt>{tSessions("usageCalls")}</dt>
                  <dd>{usageDialog.data.calls.toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{tSessions("usageInput")}</dt>
                  <dd>{usageDialog.data.input.toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{tSessions("usageOutput")}</dt>
                  <dd>{usageDialog.data.output.toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{tSessions("usageTotal")}</dt>
                  <dd>{usageDialog.data.total.toLocaleString(locale)}</dd>
                </div>
                {usageDialog.data.contextPercent !== undefined ? (
                  <div>
                    <dt>{tSessions("usageContext")}</dt>
                    <dd>{new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(usageDialog.data.contextPercent / 100)}</dd>
                  </div>
                ) : null}
                {usageDialog.data.costUsd !== undefined ? (
                  <div>
                    <dt>{tSessions("usageCost")}</dt>
                    <dd dir="ltr">{new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(usageDialog.data.costUsd)}</dd>
                  </div>
                ) : null}
                {usageDialog.context ? (
                  <>
                    {([
                      ["contextSystem", usageDialog.context.systemPrompt],
                      ["contextHistory", usageDialog.context.history],
                      ["contextTools", usageDialog.context.tools],
                      ["contextAttachments", usageDialog.context.attachments],
                      ["contextOther", usageDialog.context.other],
                    ] as const).map(([label, value]) => value === undefined ? null : (
                      <div key={label}>
                        <dt>{tSessions(label)}</dt>
                        <dd>{value.toLocaleString(locale)}</dd>
                      </div>
                    ))}
                  </>
                ) : null}
              </dl>
            ) : null}
            <div className="modal__actions">
              <button type="button" className="button button--primary" onClick={() => setUsageDialog(null)}>
                {tActions("close")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <NewSessionDialog
        defaultCwd={sessions.find((session) => session.storedId === identity?.storedId)?.cwd}
        defaultProfile={activeProfile}
        locale={locale}
        models={models}
        onOpenChange={setNewSessionOpen}
        onSubmit={async (input) => {
          await createSession(input);
        }}
        onValidateCwd={validateNewSessionCwd}
        open={newSessionOpen}
        pending={loadingSession}
        profiles={dialogProfiles}
        projects={newSessionProjects}
      />

      <RecoveryDialog
        open={recoveryOpen}
        loading={recoveryLoading}
        busy={recoveryBusy}
        checkpoints={checkpoints}
        selected={selectedCheckpoint}
        diff={checkpointDiff}
        error={recoveryError}
        labels={{
          title: tSessions("recovery"),
          undo: tSessions("undo"),
          rollback: tSessions("rollback"),
          select: tSessions("rollbackSelect"),
          warning: tSessions("rollbackWarning"),
          close: tActions("close"),
          empty: tSessions("rollbackEmpty"),
        }}
        onClose={() => setRecoveryOpen(false)}
        onUndo={undoLastTurn}
        onSelect={selectRecoveryCheckpoint}
        onRestore={restoreCheckpoint}
      />

      <SessionActionDialog
        open={sessionAction !== null}
        busy={sessionActionBusy}
        label={sessionAction === "branch" ? tSessions("branch") : tSessions("compress")}
        placeholder={sessionAction === "branch" ? tSessions("branchName") : tSessions("compressFocus")}
        submitLabel={sessionAction === "branch" ? tSessions("branch") : tSessions("compress")}
        cancelLabel={tSessions("cancel")}
        onClose={() => setSessionAction(null)}
        onSubmit={async (value) => {
          if (sessionAction === "branch") await branchSession(value);
          else if (sessionAction === "compress") await compressSession(value);
        }}
      />

      <CommandPalette
        open={commandPaletteOpen}
        commands={commands}
        unavailableReason={slashAvailable ? undefined : slashUnavailableReason}
        labels={{
          title: tCommands("title"),
          search: tCommands("search"),
          noResults: tCommands("noResults"),
          close: tActions("close"),
        }}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(command) => {
          setDraft(composerKey, `/${command.name} `);
          setCommandPaletteOpen(false);
        }}
      />
    </div>
  );
}
