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
} from "@/lib/hermes";
import { chatSessionScopeKey, useChatUiStore } from "@/store/chat-store";
import { useHermesWorkspace } from "@/components/workspace/workspace-provider";

import { ArtifactRail } from "./artifact-rail";
import { ChatHeader } from "./chat-header";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { NewSessionDialog, type NewSessionSubmission } from "./new-session-dialog";
import type { PromptResponse } from "./prompt-card";
import { ProjectSessionBrowser } from "./project-session-browser";
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
import type {
  Artifact,
  ChatMessage,
  CommandOption,
  ComposerAttachment,
  ConnectionPhase,
  InteractivePrompt,
  SessionSummary,
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

function parseCommands(value: unknown): CommandOption[] {
  const root = record(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(root.commands)
      ? root.commands
      : Array.isArray(root.catalog)
        ? root.catalog
        : [];
  return list.flatMap((item) => {
    if (typeof item === "string") return [{ name: item.replace(/^\//, "") }];
    const command = record(item);
    const name = optionalString(command.name ?? command.command)?.replace(/^\//, "");
    return name
      ? [{
          name,
          ...(optionalString(command.description ?? command.help) ? { description: String(command.description ?? command.help) } : {}),
          ...(optionalString(command.usage) ? { usage: String(command.usage) } : {}),
        }]
      : [];
  });
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
  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>([]);
  const domainPromptsRef = useRef(new Map<string, PendingPrompt>());
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [activeProfile, setActiveProfile] = useState(initialProfile ?? "default");
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
  const processingQueueRef = useRef(false);
  const speechPlaybackRef = useRef<SpeechPlayback | null>(null);
  const resumeStoredSessionRef = useRef<(storedId: string, replacePath?: boolean) => Promise<void>>(
    async () => undefined,
  );

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
  const shiftQueuedPrompt = useChatUiStore((state) => state.shiftQueuedPrompt);
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

  const flushDeltas = useCallback(() => {
    deltaFrameRef.current = null;
    const delta = pendingDeltasRef.current.join("");
    pendingDeltasRef.current = [];
    if (!delta) return;
    const id = assistantMessageIdRef.current ?? `${assistantRunIdRef.current ?? localId("assistant")}:text:${assistantPartSequenceRef.current++}`;
    assistantMessageIdRef.current = id;
    setTranscriptItems((current) => reduceTranscript(current, {
      type: "message-delta",
      id,
      delta,
      createdAt: new Date().toISOString(),
    }));
  }, []);

  const queueDelta = useCallback(
    (delta: string) => {
      if (!delta) return;
      pendingDeltasRef.current.push(delta);
      if (deltaFrameRef.current === null) {
        deltaFrameRef.current = requestAnimationFrame(flushDeltas);
      }
    },
    [flushDeltas],
  );

  const applySnapshot = useCallback(
    (
      snapshot: SessionSnapshot,
      ownerProfile: string,
      historyMessages: Message[] = snapshot.messages,
    ) => {
      if (deltaFrameRef.current !== null) cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
      pendingDeltasRef.current = [];
      assistantRunIdRef.current = null;
      assistantMessageIdRef.current = null;
      reasoningIdRef.current = null;
      lastReasoningIdRef.current = null;
      reasoningSeenRef.current = false;
      assistantPartSequenceRef.current = 0;
      identityRef.current = snapshot.identity;
      activeStoredIdRef.current = snapshot.identity.storedId;
      setIdentity(snapshot.identity);
      setActiveStoredId(snapshot.identity.storedId);
      let nextTranscript = messagesToTranscript(historyMessages);
      if (snapshot.inflight?.user) {
        const lastMessage = [...nextTranscript].reverse().find((item) => item.kind === "message");
        const duplicateUser = lastMessage?.kind === "message"
          && lastMessage.message.role === "user"
          && lastMessage.message.content === snapshot.inflight.user;
        if (!duplicateUser) {
          nextTranscript = reduceTranscript(nextTranscript, {
            type: "append-message",
            message: {
              id: localId("user-inflight"),
              role: "user",
              content: snapshot.inflight.user,
              rawSource: snapshot.inflight.user,
              createdAt: new Date().toISOString(),
              status: "complete",
              userOrdinal: nextTranscript.reduce(
                (max, item) => item.kind === "message" && item.message.userOrdinal !== undefined
                  ? Math.max(max, item.message.userOrdinal)
                  : max,
                -1,
              ) + 1,
            },
          });
        }
      }
      if (snapshot.inflight?.assistant) {
        const runId = localId("assistant-inflight");
        const id = `${runId}:text:0`;
        assistantRunIdRef.current = runId;
        assistantMessageIdRef.current = id;
        assistantPartSequenceRef.current = 1;
        nextTranscript = reduceTranscript(nextTranscript, {
          type: "message-complete",
          id,
          content: snapshot.inflight.assistant,
          createdAt: new Date().toISOString(),
          status: snapshot.inflight.streaming ? "streaming" : "complete",
        });
      }
      setTranscriptItems(nextTranscript);
      setUsageDialog(null);
      domainPromptsRef.current.clear();
      setRunning(snapshot.running ?? snapshot.info?.running ?? snapshot.inflight?.streaming ?? false);
      setSessionTitle(snapshot.info?.title || tSessions("untitled"));
      if (snapshot.info?.contract !== undefined) setGatewayContract(snapshot.info.contract);
      setModelSettings(chatSessionScopeKey(ownerProfile, snapshot.identity.storedId), {
        ...(snapshot.info?.model ? { model: snapshot.info.model } : {}),
        ...(snapshot.info?.provider ? { provider: snapshot.info.provider } : {}),
        // A resumed snapshot is authoritative. Missing reasoning must clear a
        // stale per-session cache instead of falling back to a fabricated tier.
        reasoning: snapshot.info?.reasoningEffort ?? "",
        ...(snapshot.info?.fast === undefined ? {} : { fast: snapshot.info.fast }),
      });
      setActiveProfile(ownerProfile);
    },
    [setModelSettings, tSessions],
  );

  const resumeStoredSession = useCallback(
    async (storedId: string, replacePath = false, ownerProfile = activeProfile) => {
      const generation = ++resumeGenerationRef.current;
      setLoadingSession(true);
      try {
        // Read raw rows before resuming. The subsequent snapshot is then the
        // freshness authority and can reject an older/incomplete history read.
        const history = await transport.sessionMessages(storedId, ownerProfile).catch(() => null);
        if (generation !== resumeGenerationRef.current || activeStoredIdRef.current !== storedId) return;
        const snapshot = await transport.sessionResume(storedId, { profile: ownerProfile });
        if (generation !== resumeGenerationRef.current || activeStoredIdRef.current !== storedId) return;
        const durableMessages = reconcileSessionHistory(snapshot, history, storedId);
        applySnapshot(snapshot, ownerProfile, durableMessages);
        loadedStoredIdRef.current = storedId;
        setNotice(null);
        if (replacePath) {
          router.replace(
            `/${locale}/c/${encodeURIComponent(snapshot.identity.storedId)}?profile=${encodeURIComponent(ownerProfile)}`,
          );
        }
      } catch (error) {
        if (generation !== resumeGenerationRef.current) return;
        identityRef.current = null;
        setIdentity(null);
        setRunning(false);
        refreshCapabilities();
        setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
      } finally {
        if (generation === resumeGenerationRef.current) setLoadingSession(false);
      }
    },
    [activeProfile, applySnapshot, locale, refreshCapabilities, router, tErrors, transport],
  );

  resumeStoredSessionRef.current = resumeStoredSession;

  useEffect(() => {
    const ownerProfile = initialProfile ?? activeProfile;
    if (initialProfile && initialProfile !== activeProfile) setActiveProfile(initialProfile);
    if (storedSessionId === activeStoredIdRef.current && identityRef.current?.storedId === storedSessionId) return;
    resumeGenerationRef.current += 1;
    activeStoredIdRef.current = storedSessionId;
    identityRef.current = null;
    loadedStoredIdRef.current = undefined;
    setActiveStoredId(storedSessionId);
    setIdentity(null);
    setRunning(false);
    setTranscriptItems([]);
    domainPromptsRef.current.clear();
    if (storedSessionId && profileRequiredError) {
      setNotice({kind: "error", message: tErrors("profileRequired")});
      return;
    }
    if (storedSessionId && connection === "connected") {
      void resumeStoredSession(storedSessionId, false, ownerProfile);
    }
  }, [activeProfile, connection, initialProfile, profileRequiredError, resumeStoredSession, storedSessionId, tErrors]);

  useEffect(() => {
    const unsubscribeState = transport.onConnectionState((state) => {
      const phase = connectionPhase(state);
      setConnection(phase);
      if (phase === "reconnecting") reconnectingRef.current = true;
      if (phase === "connected" && reconnectingRef.current && identityRef.current) {
        reconnectingRef.current = false;
        void resumeStoredSessionRef.current(identityRef.current.storedId, true);
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
  }, [applySnapshot, locale, router, tErrors, transport]);

  useEffect(() => {
    const unsubscribe = transport.onEvent((event) => {
      recordActivityEvent(event, activeProfile);
      if (event.type === "gateway.ready") {
        const payload = record(event.payload);
        const contract = Number(payload.desktop_contract ?? payload.contract);
        if (Number.isFinite(contract)) setGatewayContract(contract);
      }
      const active = identityRef.current;
      if (
        event.sessionId &&
        (!active || (event.sessionId !== active.runtimeId && event.sessionId !== active.storedId))
      ) return;

      if (event.type === "message.start") {
        assistantRunIdRef.current = optionalString(record(event.payload).message_id) ?? localId("assistant");
        assistantMessageIdRef.current = null;
        reasoningIdRef.current = null;
        lastReasoningIdRef.current = null;
        reasoningSeenRef.current = false;
        assistantPartSequenceRef.current = 0;
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
        void queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
        return;
      }
      if (event.type === "session.info") {
        const payload = record(event.payload);
        const hasReasoningEffort = Object.hasOwn(payload, "reasoning_effort");
        const eventContract = Number(payload.desktop_contract ?? payload.contract);
        if (Number.isFinite(eventContract)) setGatewayContract(eventContract);
        if (typeof payload.running === "boolean") setRunning(payload.running);
        if (optionalString(payload.title)) setSessionTitle(String(payload.title));
        const stored = identityRef.current?.storedId;
        if (stored && (
          optionalString(payload.model)
          || optionalString(payload.provider)
          || hasReasoningEffort
          || typeof payload.fast === "boolean"
        )) {
          const eventProfile = optionalString(payload.profile_name) ?? activeProfile;
          setModelSettings(chatSessionScopeKey(eventProfile, stored), {
            ...(optionalString(payload.model) ? { model: String(payload.model) } : {}),
            ...(optionalString(payload.provider) ? { provider: String(payload.provider) } : {}),
            ...(hasReasoningEffort
              ? { reasoning: optionalString(payload.reasoning_effort) ?? "" }
              : {}),
            ...(typeof payload.fast === "boolean" ? { fast: payload.fast } : {}),
          });
        }
        return;
      }
      if (event.type === "session.title") {
        const title = optionalString(record(event.payload).title);
        if (title) setSessionTitle(title);
        void queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
        return;
      }
      if (event.type === "status.update") {
        const payload = record(event.payload);
        const status = String(payload.status ?? payload.kind ?? "");
        if (["idle", "complete", "completed", "interrupted", "error"].includes(status)) setRunning(false);
        else if (status) setRunning(true);
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
            const stored = identityRef.current?.storedId;
            if (stored) addArtifact(chatSessionScopeKey(activeProfile, stored), artifact);
          }
        }
      }

      const domainPrompt = pendingPromptFromEvent(event);
      if (domainPrompt) {
        const key = promptKey(domainPrompt);
        domainPromptsRef.current.set(key, domainPrompt);
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
          domainPromptsRef.current.delete(expiredId);
        }
      }
      if (event.type === "error") {
        const message = optionalString(record(event.payload).message) ?? tErrors("generic");
        setNotice({ kind: "error", message });
        setRunning(false);
        const id = assistantMessageIdRef.current;
        if (id) {
          setTranscriptItems((current) => reduceTranscript(current, { type: "message-status", id, status: "error" }));
        }
      }
    });
    return unsubscribe;
  }, [activeProfile, addArtifact, flushDeltas, queryClient, queueDelta, recordActivityEvent, setModelSettings, tErrors, tPrompts, transport]);

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
    enabled:
      connection === "connected" &&
      capabilities?.gateway === true &&
      (gatewayContract ?? 0) >= 4,
  });

  useEffect(() => {
    if (!sessionsQuery.error) return;
    setNotice({
      kind: "error",
      message: sessionsQuery.error instanceof Error ? sessionsQuery.error.message : tErrors("generic"),
    });
  }, [sessionsQuery.error, tErrors]);

  const commandsQuery = useQuery({
    queryKey: ["hermes-commands", identity?.runtimeId ?? "none"],
    queryFn: async () => {
      try {
        return parseCommands(await transport.request("commands.catalog", identity ? { session_id: identity.runtimeId } : {}));
      } catch {
        return [];
      }
    },
    enabled: connection === "connected",
    staleTime: 60_000,
  });

  const sessions = useMemo(
    () =>
      (sessionsQuery.data ?? [])
        .filter((session) => session.profile === activeProfile)
        .map((session) => toSessionSummary(session, tSessions("untitled"))),
    [activeProfile, sessionsQuery.data, tSessions],
  );
  const models = modelsQuery.data ?? [];
  const commands = commandsQuery.data ?? [];
  const projectPayload = projectsQuery.data ?? null;
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

  async function createSession(input: NewSessionSubmission) {
    if (connection !== "connected" || !capabilities?.gateway || !capabilities.sessions) return;
    const ownerProfile = input.profile.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(ownerProfile) || ownerProfile === "all") {
      setNotice({kind: "error", message: tErrors("profileRequired")});
      return;
    }
    resumeGenerationRef.current += 1;
    identityRef.current = null;
    setIdentity(null);
    setRunning(false);
    setTranscriptItems([]);
    domainPromptsRef.current.clear();
    setLoadingSession(true);
    try {
      const snapshot = await transport.sessionCreate({
        profile: ownerProfile,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.fast === undefined ? {} : { fast: input.fast }),
      });
      setActiveProfile(ownerProfile);
      applySnapshot(snapshot, ownerProfile);
      loadedStoredIdRef.current = snapshot.identity.storedId;
      navigateToSession(snapshot.identity.storedId, "push", ownerProfile);
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["hermes-projects"] });
      setMobileRail(null);
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    } finally {
      setLoadingSession(false);
    }
  }

  async function selectSession(session: SessionSummary) {
    if (session.storedId === identity?.storedId) {
      setMobileRail(null);
      return;
    }
    resumeGenerationRef.current += 1;
    identityRef.current = null;
    setIdentity(null);
    setRunning(false);
    setTranscriptItems([]);
    domainPromptsRef.current.clear();
    loadedStoredIdRef.current = undefined;
    navigateToSession(session.storedId);
    setMobileRail(null);
  }

  function selectSearchResult(sessionId: string, ownerProfile: string) {
    if (!sessionId || !ownerProfile || ownerProfile === "all") return;
    resumeGenerationRef.current += 1;
    identityRef.current = null;
    loadedStoredIdRef.current = undefined;
    activeStoredIdRef.current = sessionId;
    setActiveProfile(ownerProfile);
    setIdentity(null);
    setRunning(false);
    setTranscriptItems([]);
    domainPromptsRef.current.clear();
    navigateToSession(sessionId, "push", ownerProfile);
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
    if (deletingCurrent) {
      resumeGenerationRef.current += 1;
      identityRef.current = null;
      activeStoredIdRef.current = undefined;
      setIdentity(null);
      setActiveStoredId(undefined);
      setTranscriptItems([]);
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
    setTranscriptItems([]);
    setUsageDialog(null);
    setRunning(false);
    domainPromptsRef.current.clear();
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
    setRecoveryBusy(true);
    setRecoveryError(undefined);
    try {
      const result = await transport.sessionUndo(active);
      const history = await transport.sessionHistory(active);
      setTranscriptItems(messagesToTranscript(history));
      setDraft(chatSessionScopeKey(activeProfile, active.storedId), result.message);
      setNotice({ kind: "info", message: result.notice || tSessions("undoSuccess") });
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
      setTranscriptItems(messagesToTranscript(history));
      useChatUiStore.getState().clearArtifacts(chatSessionScopeKey(activeProfile, active.storedId));
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
        }, activeProfile);
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

  async function dispatchMessage(source: string, mode: "send" | "steer" = "send") {
    const active = identityRef.current;
    if (!active) return;
    const activeKey = chatSessionScopeKey(activeProfile, active.storedId);
    const readyAttachments = (useChatUiStore.getState().attachments[activeKey] ?? []).filter(
      (attachment) => attachment.status === "ready",
    );
    const fileReferences = [...new Set(
      readyAttachments
        .filter((attachment) => attachment.kind === "file")
        .map((attachment) => attachment.refText)
        .filter((reference): reference is string => Boolean(reference)),
    )];
    const baseText = source.trim() || (locale === "fa" ? "فایل پیوست‌شده را بررسی کن." : "Please review the attached file.");
    const text = [
      baseText,
      ...(baseText.startsWith("/") ? [] : fileReferences.filter((reference) => !baseText.includes(reference))),
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
    const isCommand = text.startsWith("/")
      && commands.some((command) => text === `/${command.name}` || text.startsWith(`/${command.name} `));
    const userMessage: ChatMessage = {
      id: localId("user"),
      role: "user",
      content: text,
      rawSource: text,
      createdAt: new Date().toISOString(),
      status: "complete",
      ...(isCommand
        ? {}
        : {
            userOrdinal: transcriptItems.reduce(
              (max, item) => item.kind === "message" && item.message.userOrdinal !== undefined
                ? Math.max(max, item.message.userOrdinal)
                : max,
              -1,
            ) + 1,
          }),
    };
    setTranscriptItems((current) => reduceTranscript(current, { type: "append-message", message: userMessage }));
    setRunning(true);
    try {
      if (isCommand) {
        const result = await transport.command(active, text);
        setTranscriptItems((current) => reduceTranscript(current, {
          type: "append-message",
          message: {
            id: localId("command"),
            role: "system",
            content: result.output,
            rawSource: result.output,
            createdAt: new Date().toISOString(),
            status: "complete",
          },
        }));
        setRunning(false);
        setDraft(activeKey, "");
      } else {
        await transport.send(active, text);
        setDraft(activeKey, "");
        clearSubmittedAttachments(activeKey, readyAttachments.map((attachment) => attachment.id));
      }
    } catch (error) {
      setRunning(false);
      setTranscriptItems((current) => reduceTranscript(current, {
        type: "message-status",
        id: userMessage.id,
        status: "error",
      }));
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    }
  }

  async function rewindAndSubmit(target: ChatMessage, text: string) {
    const active = identityRef.current;
    if (!active || target.userOrdinal === undefined || running || (gatewayContract ?? 0) < 4) return;
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
        setTranscriptItems(messagesToTranscript(authoritative));
      } catch {
        setTranscriptItems(previous);
      }
      setRunning(false);
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : tChat("rewindFailed"),
      });
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

  useEffect(() => {
    if (running || processingQueueRef.current || !identity) return;
    const next = shiftQueuedPrompt(chatSessionScopeKey(activeProfile, identity.storedId));
    if (!next) return;
    processingQueueRef.current = true;
    void dispatchMessage(next).finally(() => {
      processingQueueRef.current = false;
    });
    // dispatchMessage reads current connection/session refs; queue length triggers this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, identity, queue.length, running, shiftQueuedPrompt]);

  async function stopRun() {
    if (!identity) return;
    try {
      await transport.stop(identity);
      setRunning(false);
      const id = assistantMessageIdRef.current
        ?? `${assistantRunIdRef.current ?? localId("assistant")}:text:${assistantPartSequenceRef.current++}`;
      if (id) {
        setTranscriptItems((current) => {
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
        assistantMessageIdRef.current = null;
      }
      if (lastReasoningIdRef.current) {
        setTranscriptItems((current) => reduceTranscript(current, {
          type: "reasoning-status",
          id: lastReasoningIdRef.current!,
          status: "interrupted",
        }));
      }
      assistantRunIdRef.current = null;
      reasoningIdRef.current = null;
      lastReasoningIdRef.current = null;
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
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
    const domain = domainPromptsRef.current.get(prompt.id);
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
      domainPromptsRef.current.delete(prompt.id);
      setTranscriptItems((current) => reduceTranscript(current, { type: "remove-prompt", id: prompt.id }));
    }
  }

  async function changeModel(model: ModelOption) {
    if (!identity) return;
    if (messages.length > 8) setNotice({ kind: "warning", message: tModels("cacheWarning") });
    try {
      await transport.setModel(identity, model.id, model.provider);
      setModelSettings(chatSessionScopeKey(activeProfile, identity.storedId), { model: model.id, provider: model.provider });
      await queryClient.invalidateQueries({ queryKey: ["hermes-models"] });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    }
  }

  async function setSessionReasoning(value: string) {
    if (!identity) return;
    try {
      await transport.request("config.set", {
        session_id: identity.runtimeId,
        key: "reasoning",
        value,
      });
      setModelSettings(chatSessionScopeKey(activeProfile, identity.storedId), { reasoning: value });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    }
  }

  async function branchSession(name?: string) {
    if (!identity) return;
    setSessionActionBusy(true);
    try {
      const snapshot = await transport.sessionBranch(identity, name);
      applySnapshot(snapshot, activeProfile);
      loadedStoredIdRef.current = snapshot.identity.storedId;
      navigateToSession(snapshot.identity.storedId, "push", activeProfile);
      setSessionAction(null);
      await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    } catch (error) {
      refreshCapabilities();
      setNotice({ kind: "error", message: error instanceof Error ? error.message : tErrors("generic") });
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function compressSession(focusTopic?: string) {
    if (!identity) return;
    setSessionActionBusy(true);
    try {
      const compressed = await transport.sessionCompress(identity, focusTopic);
      setTranscriptItems(messagesToTranscript(compressed));
      setSessionAction(null);
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
        loading={sessionsQuery.isLoading || loadingSession}
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
          onProfileChange={async (profile) => {
            resumeGenerationRef.current += 1;
            identityRef.current = null;
            activeStoredIdRef.current = undefined;
            setActiveProfile(profile);
            setIdentity(null);
            setRunning(false);
            setTranscriptItems([]);
            domainPromptsRef.current.clear();
            setActiveStoredId(undefined);
            router.push(`/${locale}?profile=${encodeURIComponent(profile)}`);
            await queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
          }}
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
        onSubmit={createSession}
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
