"use client";

import { create } from "zustand";

import { messagesToTranscript, reduceTranscript } from "@/components/chat/transcript-state";
import type { TranscriptAction } from "@/components/chat/transcript-state";
import type { TranscriptItem } from "@/components/chat/ui-types";
import type {
  LiveSessionStatus,
  Message,
  PendingPrompt,
  SessionIdentity,
  SessionSnapshot,
} from "@/lib/hermes";

/** Runtime state is keyed by profile as well as durable id to prevent cross-profile leaks. */
export function sessionRuntimeScopeKey(profile: string, storedId: string): string {
  return `${profile}:${storedId}`;
}

export type RuntimeSessionIdentity = Omit<SessionIdentity, "runtimeId"> & {
  runtimeId?: string;
};

export type SessionStreamMetadata = {
  pendingTextDeltas: string[];
  deltaFrameId: number | null;
  assistantRunId: string | null;
  assistantMessageId: string | null;
  reasoningId: string | null;
  lastReasoningId: string | null;
  reasoningSeen: boolean;
  assistantPartSequence: number;
  processingQueue: boolean;
};

export type SessionRuntimeEntry = {
  scopeKey: string;
  profile: string;
  identity: RuntimeSessionIdentity;
  title: string;
  transcriptItems: TranscriptItem[];
  running: boolean;
  liveStatus: LiveSessionStatus;
  needsInput: boolean;
  unread: boolean;
  error: string | null;
  domainPrompts: Record<string, PendingPrompt>;
  stream: SessionStreamMetadata;
  /** Monotonic local revision used to reject async snapshots that started earlier. */
  revision: number;
  /** Changes only when transcript content changes. */
  transcriptRevision: number;
  /** Optional caller-owned monotonic snapshot version. */
  snapshotVersion?: number;
  updatedAt: number;
};

export type SessionRuntimeReference =
  | string
  | { scopeKey: string }
  | { runtimeId: string }
  | { profile: string; storedId: string };

export type RegisterRuntimeSessionInput = {
  profile: string;
  storedId: string;
  runtimeId?: string;
  lineageRootId?: string;
  title?: string;
};

export type SnapshotHydrationOptions = {
  /** Reconciled durable messages may be supplied instead of snapshot.messages. */
  messages?: Message[];
  /** Fully prepared transcript, taking precedence over messages. */
  transcriptItems?: TranscriptItem[];
  /** Apply only if the session has not changed since this revision was captured. */
  expectedRevision?: number;
  /**
   * Preserve a newer live transcript/stream on mismatch while still applying
   * snapshot identity and live metadata. Prefer this for activate/poll races.
   */
  expectedTranscriptRevision?: number;
  /** Reject a snapshot older than the last applied caller-owned version. */
  version?: number;
  title?: string;
  now?: number;
};

export type SessionLiveStatePatch = {
  status?: LiveSessionStatus;
  running?: boolean;
  needsInput?: boolean;
  title?: string;
  error?: string | null;
  /** Explicit event-level unread control; it is ignored for the selected session. */
  markUnread?: boolean;
  now?: number;
};

export type TranscriptUpdate =
  | TranscriptAction
  | ((items: TranscriptItem[]) => TranscriptItem[]);

export type TranscriptUpdateOptions = {
  /** Background event handlers opt in; ordinary local updates remain read. */
  markUnread?: boolean;
  now?: number;
};

export type SessionAttention = "waiting" | "running" | "unread" | "idle";

export function sessionAttention(session: SessionRuntimeEntry): SessionAttention {
  if (session.needsInput || session.liveStatus === "waiting") return "waiting";
  if (
    session.running
    || session.liveStatus === "starting"
    || session.liveStatus === "working"
  ) return "running";
  if (session.unread) return "unread";
  return "idle";
}

export type SessionRuntimeStore = {
  sessions: Record<string, SessionRuntimeEntry>;
  runtimeToScope: Record<string, string>;
  selectedScopeKey: string | null;
  registerSession: (input: RegisterRuntimeSessionInput) => string;
  hydrateSnapshot: (
    profile: string,
    snapshot: SessionSnapshot,
    options?: SnapshotHydrationOptions,
  ) => string;
  bindRuntime: (reference: SessionRuntimeReference, runtimeId: string) => boolean;
  updateLiveState: (
    reference: SessionRuntimeReference,
    patch: SessionLiveStatePatch,
  ) => boolean;
  selectSession: (reference: SessionRuntimeReference | null) => boolean;
  markRead: (reference: SessionRuntimeReference) => boolean;
  updateTranscript: (
    reference: SessionRuntimeReference,
    update: TranscriptUpdate,
    options?: TranscriptUpdateOptions,
  ) => boolean;
  setDomainPrompt: (
    reference: SessionRuntimeReference,
    key: string,
    prompt: PendingPrompt,
    options?: { markUnread?: boolean; now?: number },
  ) => boolean;
  removeDomainPrompt: (
    reference: SessionRuntimeReference,
    key: string,
    options?: { now?: number },
  ) => boolean;
  setStreamMetadata: (
    reference: SessionRuntimeReference,
    update:
      | Partial<SessionStreamMetadata>
      | ((metadata: SessionStreamMetadata) => SessionStreamMetadata),
  ) => boolean;
  getRevision: (reference: SessionRuntimeReference) => number | undefined;
  findByRuntime: (runtimeId: string) => SessionRuntimeEntry | undefined;
  findByStored: (profile: string, storedId: string) => SessionRuntimeEntry | undefined;
  dropRuntimeBinding: (runtimeId: string) => boolean;
  resetRuntimeBindings: () => void;
  dropSession: (reference: SessionRuntimeReference) => boolean;
  reset: () => void;
};

const EMPTY_STREAM: Readonly<SessionStreamMetadata> = {
  pendingTextDeltas: [],
  deltaFrameId: null,
  assistantRunId: null,
  assistantMessageId: null,
  reasoningId: null,
  lastReasoningId: null,
  reasoningSeen: false,
  assistantPartSequence: 0,
  processingQueue: false,
};

function emptyStream(): SessionStreamMetadata {
  return { ...EMPTY_STREAM, pendingTextDeltas: [] };
}

function emptySession(input: RegisterRuntimeSessionInput, now = Date.now()): SessionRuntimeEntry {
  const scopeKey = sessionRuntimeScopeKey(input.profile, input.storedId);
  return {
    scopeKey,
    profile: input.profile,
    identity: {
      storedId: input.storedId,
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      ...(input.lineageRootId ? { lineageRootId: input.lineageRootId } : {}),
    },
    title: input.title ?? "",
    transcriptItems: [],
    running: false,
    liveStatus: "idle",
    needsInput: false,
    unread: false,
    error: null,
    domainPrompts: {},
    stream: emptyStream(),
    revision: 0,
    transcriptRevision: 0,
    updatedAt: now,
  };
}

function resolveScopeKey(
  state: Pick<SessionRuntimeStore, "sessions" | "runtimeToScope">,
  reference: SessionRuntimeReference,
): string | undefined {
  if (typeof reference === "string") {
    if (state.sessions[reference]) return reference;
    return state.runtimeToScope[reference];
  }
  if ("scopeKey" in reference) return state.sessions[reference.scopeKey] ? reference.scopeKey : undefined;
  if ("runtimeId" in reference) return state.runtimeToScope[reference.runtimeId];
  const scopeKey = sessionRuntimeScopeKey(reference.profile, reference.storedId);
  return state.sessions[scopeKey] ? scopeKey : undefined;
}

function withRuntimeBinding(
  sessions: Record<string, SessionRuntimeEntry>,
  runtimeToScope: Record<string, string>,
  scopeKey: string,
  runtimeId: string,
  now: number,
): {
  sessions: Record<string, SessionRuntimeEntry>;
  runtimeToScope: Record<string, string>;
} {
  const current = sessions[scopeKey];
  if (!current) return { sessions, runtimeToScope };

  const nextSessions = { ...sessions };
  const nextIndex = { ...runtimeToScope };
  const previousRuntimeId = current.identity.runtimeId;
  if (previousRuntimeId && previousRuntimeId !== runtimeId) delete nextIndex[previousRuntimeId];

  const previousScope = nextIndex[runtimeId];
  if (previousScope && previousScope !== scopeKey) {
    const previousSession = nextSessions[previousScope];
    if (previousSession?.identity.runtimeId === runtimeId) {
      const { runtimeId: _removed, ...identity } = previousSession.identity;
      void _removed;
      nextSessions[previousScope] = {
        ...previousSession,
        identity,
        running: false,
        liveStatus: "idle",
        needsInput: false,
        revision: previousSession.revision + 1,
        updatedAt: now,
      };
    }
  }

  nextIndex[runtimeId] = scopeKey;
  if (previousRuntimeId !== runtimeId) {
    nextSessions[scopeKey] = {
      ...current,
      identity: { ...current.identity, runtimeId },
      revision: current.revision + 1,
      updatedAt: now,
    };
  }
  return { sessions: nextSessions, runtimeToScope: nextIndex };
}

function snapshotStatus(snapshot: SessionSnapshot): LiveSessionStatus {
  if (snapshot.status) return snapshot.status;
  if (snapshot.running ?? snapshot.info?.running ?? snapshot.inflight?.streaming) return "working";
  return "idle";
}

function snapshotTranscript(
  snapshot: SessionSnapshot,
  messages: Message[],
  prepared?: TranscriptItem[],
): { items: TranscriptItem[]; stream: SessionStreamMetadata } {
  let items = prepared ?? messagesToTranscript(messages);
  const stream = emptyStream();
  const inflight = snapshot.inflight;

  if (inflight?.user) {
    const lastMessage = [...items].reverse().find((item) => item.kind === "message");
    const duplicateUser = lastMessage?.kind === "message"
      && lastMessage.message.role === "user"
      && lastMessage.message.content === inflight.user;
    if (!duplicateUser) {
      const nextOrdinal = items.reduce(
        (max, item) => item.kind === "message" && item.message.userOrdinal !== undefined
          ? Math.max(max, item.message.userOrdinal)
          : max,
        -1,
      ) + 1;
      items = reduceTranscript(items, {
        type: "append-message",
        message: {
          id: `${snapshot.identity.runtimeId}:inflight:user`,
          role: "user",
          content: inflight.user,
          rawSource: inflight.user,
          status: "complete",
          userOrdinal: nextOrdinal,
        },
      });
    }
  }

  if (inflight?.assistant) {
    const runId = `${snapshot.identity.runtimeId}:inflight`;
    const messageId = `${runId}:text:0`;
    stream.assistantRunId = runId;
    stream.assistantMessageId = messageId;
    stream.assistantPartSequence = 1;
    items = reduceTranscript(items, {
      type: "message-complete",
      id: messageId,
      content: inflight.assistant,
      status: inflight.streaming ? "streaming" : "complete",
    });
  }

  return { items, stream };
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set, get) => ({
  sessions: {},
  runtimeToScope: {},
  selectedScopeKey: null,

  registerSession: (input) => {
    const scopeKey = sessionRuntimeScopeKey(input.profile, input.storedId);
    const now = Date.now();
    set((state) => {
      const current = state.sessions[scopeKey];
      let sessions: Record<string, SessionRuntimeEntry> = {
        ...state.sessions,
        [scopeKey]: current
          ? {
              ...current,
              identity: {
                ...current.identity,
                ...(input.lineageRootId ? { lineageRootId: input.lineageRootId } : {}),
              },
              ...(input.title === undefined ? {} : { title: input.title }),
              updatedAt: now,
            }
          : emptySession(input, now),
      };
      let runtimeToScope = state.runtimeToScope;
      if (input.runtimeId) {
        ({ sessions, runtimeToScope } = withRuntimeBinding(
          sessions,
          runtimeToScope,
          scopeKey,
          input.runtimeId,
          now,
        ));
      }
      return { sessions, runtimeToScope };
    });
    return scopeKey;
  },

  hydrateSnapshot: (profile, snapshot, options = {}) => {
    const scopeKey = sessionRuntimeScopeKey(profile, snapshot.identity.storedId);
    const now = options.now ?? Date.now();
    set((state) => {
      const current = state.sessions[scopeKey];
      const staleVersion = Boolean(
        current
        && options.version !== undefined
        && current.snapshotVersion !== undefined
        && options.version < current.snapshotVersion
      );
      const changedSinceRequest = Boolean(
        current
        && options.expectedRevision !== undefined
        && current.revision !== options.expectedRevision
      );
      if (staleVersion || changedSinceRequest) return state;
      const transcriptChangedSinceRequest = Boolean(
        current
        && options.expectedTranscriptRevision !== undefined
        && current.transcriptRevision !== options.expectedTranscriptRevision
      );

      const base = current ?? emptySession({
        profile,
        storedId: snapshot.identity.storedId,
        runtimeId: snapshot.identity.runtimeId,
        lineageRootId: snapshot.identity.lineageRootId,
      }, now);
      const hydrated = snapshotTranscript(
        snapshot,
        options.messages ?? snapshot.messages,
        options.transcriptItems,
      );
      let sessions = { ...state.sessions, [scopeKey]: base };
      let runtimeToScope = state.runtimeToScope;
      ({ sessions, runtimeToScope } = withRuntimeBinding(
        sessions,
        runtimeToScope,
        scopeKey,
        snapshot.identity.runtimeId,
        now,
      ));
      const boundBase = sessions[scopeKey]!;
      const hasPendingPrompts = Object.keys(boundBase.domainPrompts).length > 0;
      const liveStatus = hasPendingPrompts ? "waiting" : snapshotStatus(snapshot);
      const running = hasPendingPrompts || (snapshot.running
        ?? snapshot.info?.running
        ?? snapshot.inflight?.streaming
        ?? (liveStatus !== "idle"));
      const promptItems = hasPendingPrompts
        ? boundBase.transcriptItems.filter((item) => item.kind === "prompt")
        : [];
      const hydratedItems = promptItems.reduce(
        (items, promptItem) => items.some((item) => item.key === promptItem.key)
          ? items
          : [...items, promptItem],
        hydrated.items,
      );
      const next: SessionRuntimeEntry = {
        ...boundBase,
        identity: { ...snapshot.identity },
        title: options.title ?? snapshot.info?.title ?? boundBase.title,
        transcriptItems: transcriptChangedSinceRequest
          ? boundBase.transcriptItems
          : hydratedItems,
        running,
        liveStatus,
        needsInput: hasPendingPrompts || liveStatus === "waiting",
        error: null,
        domainPrompts: boundBase.domainPrompts,
        stream: transcriptChangedSinceRequest || hasPendingPrompts
          ? boundBase.stream
          : hydrated.stream,
        revision: boundBase.revision + 1,
        transcriptRevision: transcriptChangedSinceRequest
          ? boundBase.transcriptRevision
          : boundBase.transcriptRevision + 1,
        ...(options.version === undefined ? {} : { snapshotVersion: options.version }),
        updatedAt: now,
      };
      sessions = { ...sessions, [scopeKey]: next };
      return { sessions, runtimeToScope };
    });
    return scopeKey;
  },

  bindRuntime: (reference, runtimeId) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    const now = Date.now();
    set((current) => withRuntimeBinding(
      current.sessions,
      current.runtimeToScope,
      scopeKey,
      runtimeId,
      now,
    ));
    return true;
  },

  updateLiveState: (reference, patch) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    set((current) => {
      const session = current.sessions[scopeKey];
      if (!session) return current;
      const hasPendingPrompts = Object.keys(session.domainPrompts).length > 0;
      const liveStatus = hasPendingPrompts ? "waiting" : patch.status ?? session.liveStatus;
      const running = hasPendingPrompts || (patch.running
        ?? (patch.status === undefined ? session.running : liveStatus !== "idle"));
      const needsInput = hasPendingPrompts || (patch.needsInput
        ?? (patch.status === undefined ? session.needsInput : liveStatus === "waiting"));
      const completedInBackground = current.selectedScopeKey !== scopeKey
        && liveStatus === "idle"
        && (session.liveStatus === "working" || session.liveStatus === "waiting");
      const explicitUnread = patch.markUnread === true && current.selectedScopeKey !== scopeKey;
      return {
        sessions: {
          ...current.sessions,
          [scopeKey]: {
            ...session,
            ...(patch.title === undefined ? {} : { title: patch.title }),
            running,
            liveStatus,
            needsInput,
            unread: current.selectedScopeKey === scopeKey
              ? false
              : session.unread || completedInBackground || explicitUnread,
            ...(patch.error === undefined ? {} : { error: patch.error }),
            revision: session.revision + 1,
            updatedAt: patch.now ?? Date.now(),
          },
        },
      };
    });
    return true;
  },

  selectSession: (reference) => {
    if (reference === null) {
      set({ selectedScopeKey: null });
      return true;
    }
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    set((current) => {
      const session = current.sessions[scopeKey];
      if (!session) return current;
      return {
        selectedScopeKey: scopeKey,
        sessions: session.unread
          ? {
              ...current.sessions,
              [scopeKey]: {
                ...session,
                unread: false,
                revision: session.revision + 1,
                updatedAt: Date.now(),
              },
            }
          : current.sessions,
      };
    });
    return true;
  },

  markRead: (reference) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    const session = scopeKey ? state.sessions[scopeKey] : undefined;
    if (!scopeKey || !session) return false;
    if (!session.unread) return true;
    set((current) => ({
      sessions: {
        ...current.sessions,
        [scopeKey]: {
          ...current.sessions[scopeKey]!,
          unread: false,
          revision: current.sessions[scopeKey]!.revision + 1,
          updatedAt: Date.now(),
        },
      },
    }));
    return true;
  },

  updateTranscript: (reference, update, options = {}) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    set((current) => {
      const session = current.sessions[scopeKey];
      if (!session) return current;
      const transcriptItems = typeof update === "function"
        ? update(session.transcriptItems)
        : reduceTranscript(session.transcriptItems, update);
      if (transcriptItems === session.transcriptItems) return current;
      const remainingPromptIds = new Set(
        transcriptItems.flatMap((item) => item.kind === "prompt" ? [item.prompt.id] : []),
      );
      const removedPromptIds = session.transcriptItems.flatMap((item) => (
        item.kind === "prompt" && !remainingPromptIds.has(item.prompt.id)
          ? [item.prompt.id]
          : []
      ));
      const domainPrompts = removedPromptIds.length ? { ...session.domainPrompts } : session.domainPrompts;
      for (const promptId of removedPromptIds) delete domainPrompts[promptId];
      const needsInput = removedPromptIds.length
        ? Object.keys(domainPrompts).length > 0
        : session.needsInput;
      return {
        sessions: {
          ...current.sessions,
          [scopeKey]: {
            ...session,
            transcriptItems,
            domainPrompts,
            needsInput,
            liveStatus: removedPromptIds.length
              ? needsInput
                ? "waiting"
                : session.liveStatus === "waiting"
                  ? session.running ? "working" : "idle"
                  : session.liveStatus
              : session.liveStatus,
            unread: options.markUnread === true && current.selectedScopeKey !== scopeKey
              ? true
              : session.unread,
            revision: session.revision + 1,
            transcriptRevision: session.transcriptRevision + 1,
            updatedAt: options.now ?? Date.now(),
          },
        },
      };
    });
    return true;
  },

  setDomainPrompt: (reference, key, prompt, options = {}) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    set((current) => {
      const session = current.sessions[scopeKey];
      if (!session) return current;
      return {
        sessions: {
          ...current.sessions,
          [scopeKey]: {
            ...session,
            domainPrompts: { ...session.domainPrompts, [key]: prompt },
            running: true,
            liveStatus: "waiting",
            needsInput: true,
            unread: options.markUnread === true && current.selectedScopeKey !== scopeKey
              ? true
              : session.unread,
            revision: session.revision + 1,
            updatedAt: options.now ?? Date.now(),
          },
        },
      };
    });
    return true;
  },

  removeDomainPrompt: (reference, key, options = {}) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    const session = scopeKey ? state.sessions[scopeKey] : undefined;
    if (!scopeKey || !session) return false;
    if (!Object.hasOwn(session.domainPrompts, key)) return true;
    set((current) => {
      const target = current.sessions[scopeKey];
      if (!target) return current;
      const domainPrompts = { ...target.domainPrompts };
      delete domainPrompts[key];
      const needsInput = Object.keys(domainPrompts).length > 0;
      return {
        sessions: {
          ...current.sessions,
          [scopeKey]: {
            ...target,
            domainPrompts,
            needsInput,
            liveStatus: needsInput ? "waiting" : target.running ? "working" : "idle",
            revision: target.revision + 1,
            updatedAt: options.now ?? Date.now(),
          },
        },
      };
    });
    return true;
  },

  setStreamMetadata: (reference, update) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    set((current) => {
      const session = current.sessions[scopeKey];
      if (!session) return current;
      const stream = typeof update === "function"
        ? update(session.stream)
        : { ...session.stream, ...update };
      if (stream === session.stream) return current;
      return {
        sessions: {
          ...current.sessions,
          [scopeKey]: {
            ...session,
            stream,
            revision: session.revision + 1,
            updatedAt: Date.now(),
          },
        },
      };
    });
    return true;
  },

  getRevision: (reference) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    return scopeKey ? state.sessions[scopeKey]?.revision : undefined;
  },

  findByRuntime: (runtimeId) => {
    const state = get();
    const scopeKey = state.runtimeToScope[runtimeId];
    return scopeKey ? state.sessions[scopeKey] : undefined;
  },

  findByStored: (profile, storedId) => get().sessions[sessionRuntimeScopeKey(profile, storedId)],

  dropRuntimeBinding: (runtimeId) => {
    const state = get();
    const scopeKey = state.runtimeToScope[runtimeId];
    if (!scopeKey) return false;
    set((current) => {
      const runtimeToScope = { ...current.runtimeToScope };
      delete runtimeToScope[runtimeId];
      const session = current.sessions[scopeKey];
      if (!session || session.identity.runtimeId !== runtimeId) return { runtimeToScope };
      const { runtimeId: _removed, ...identity } = session.identity;
      void _removed;
      return {
        runtimeToScope,
        sessions: {
          ...current.sessions,
          [scopeKey]: {
            ...session,
            identity,
            running: false,
            liveStatus: "idle",
            needsInput: false,
            revision: session.revision + 1,
            updatedAt: Date.now(),
          },
        },
      };
    });
    return true;
  },

  resetRuntimeBindings: () => set((state) => ({
    runtimeToScope: {},
    sessions: Object.fromEntries(Object.entries(state.sessions).map(([scopeKey, session]) => {
      const { runtimeId: _removed, ...identity } = session.identity;
      void _removed;
      return [scopeKey, {
        ...session,
        identity,
        running: false,
        liveStatus: "idle" as const,
        needsInput: false,
        revision: session.revision + 1,
        updatedAt: Date.now(),
      }];
    })),
  })),

  dropSession: (reference) => {
    const state = get();
    const scopeKey = resolveScopeKey(state, reference);
    if (!scopeKey) return false;
    set((current) => {
      const sessions = { ...current.sessions };
      delete sessions[scopeKey];
      const runtimeToScope = Object.fromEntries(
        Object.entries(current.runtimeToScope).filter(([, value]) => value !== scopeKey),
      );
      return {
        sessions,
        runtimeToScope,
        selectedScopeKey: current.selectedScopeKey === scopeKey ? null : current.selectedScopeKey,
      };
    });
    return true;
  },

  reset: () => set({ sessions: {}, runtimeToScope: {}, selectedScopeKey: null }),
}));

export const __sessionRuntimeTesting = {
  emptyStream,
  resolveScopeKey,
  snapshotStatus,
};
