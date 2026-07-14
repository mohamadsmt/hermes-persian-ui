"use client";

import { create } from "zustand";
import type {
  Artifact,
  ComposerAttachment,
  SessionModelSettings,
} from "@/components/chat/ui-types";

type Rail = "sessions" | "artifacts";

type ChatUiState = {
  openMobileRail: Rail | null;
  artifactRailOpen: boolean;
  artifactRailWidth: number;
  selectedArtifactIds: Record<string, string | null>;
  artifacts: Record<string, Artifact[]>;
  drafts: Record<string, string>;
  queuedPrompts: Record<string, string[]>;
  attachments: Record<string, ComposerAttachment[]>;
  modelSettings: Record<string, SessionModelSettings>;
  commandPaletteOpen: boolean;
  setMobileRail: (rail: Rail | null) => void;
  setArtifactRailOpen: (open: boolean) => void;
  setArtifactRailWidth: (width: number) => void;
  addArtifact: (sessionKey: string, artifact: Artifact) => void;
  selectArtifact: (sessionKey: string, id: string | null) => void;
  setDraft: (sessionId: string, value: string) => void;
  enqueuePrompt: (sessionId: string, value: string) => void;
  replaceQueuedPrompt: (sessionId: string, index: number, value: string) => void;
  removeQueuedPrompt: (sessionId: string, index: number) => void;
  shiftQueuedPrompt: (sessionId: string) => string | undefined;
  setAttachments: (sessionId: string, files: ComposerAttachment[]) => void;
  setModelSettings: (
    sessionId: string,
    settings: Partial<SessionModelSettings>,
  ) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  clearSessionEphemera: (sessionId: string) => void;
};

const clampRailWidth = (width: number) => Math.min(560, Math.max(280, width));

/** Browser-only state is namespaced by profile as well as durable session id.
 * The durable id itself remains untouched for URLs and Hermes RPC calls. */
export function chatSessionScopeKey(profile: string, storedId?: string): string {
  return `${profile}:${storedId ?? "new"}`;
}

export const useChatUiStore = create<ChatUiState>((set, get) => ({
  openMobileRail: null,
  artifactRailOpen: false,
  artifactRailWidth: 360,
  selectedArtifactIds: {},
  artifacts: {},
  drafts: {},
  queuedPrompts: {},
  attachments: {},
  modelSettings: {},
  commandPaletteOpen: false,
  setMobileRail: (openMobileRail) => set({ openMobileRail }),
  setArtifactRailOpen: (artifactRailOpen) => set({ artifactRailOpen }),
  setArtifactRailWidth: (artifactRailWidth) =>
    set({ artifactRailWidth: clampRailWidth(artifactRailWidth) }),
  addArtifact: (sessionKey, artifact) =>
    set((state) => {
      const current = state.artifacts[sessionKey] ?? [];
      const exists = current.some((item) => item.id === artifact.id);
      return {
        artifacts: {
          ...state.artifacts,
          [sessionKey]: exists
            ? current.map((item) => (item.id === artifact.id ? artifact : item))
            : [artifact, ...current],
        },
        selectedArtifactIds: { ...state.selectedArtifactIds, [sessionKey]: artifact.id },
        artifactRailOpen: true,
      };
    }),
  selectArtifact: (sessionKey, selectedArtifactId) =>
    set((state) => ({
      selectedArtifactIds: { ...state.selectedArtifactIds, [sessionKey]: selectedArtifactId },
    })),
  setDraft: (sessionId, value) =>
    set((state) => ({ drafts: { ...state.drafts, [sessionId]: value } })),
  enqueuePrompt: (sessionId, value) =>
    set((state) => ({
      queuedPrompts: {
        ...state.queuedPrompts,
        [sessionId]: [...(state.queuedPrompts[sessionId] ?? []), value],
      },
    })),
  replaceQueuedPrompt: (sessionId, index, value) =>
    set((state) => {
      const queue = [...(state.queuedPrompts[sessionId] ?? [])];
      if (queue[index] !== undefined) queue[index] = value;
      return { queuedPrompts: { ...state.queuedPrompts, [sessionId]: queue } };
    }),
  removeQueuedPrompt: (sessionId, index) =>
    set((state) => ({
      queuedPrompts: {
        ...state.queuedPrompts,
        [sessionId]: (state.queuedPrompts[sessionId] ?? []).filter(
          (_, itemIndex) => itemIndex !== index,
        ),
      },
    })),
  shiftQueuedPrompt: (sessionId) => {
    const first = get().queuedPrompts[sessionId]?.[0];
    if (first === undefined) return undefined;
    set((state) => ({
      queuedPrompts: {
        ...state.queuedPrompts,
        [sessionId]: (state.queuedPrompts[sessionId] ?? []).slice(1),
      },
    }));
    return first;
  },
  setAttachments: (sessionId, files) =>
    set((state) => ({ attachments: { ...state.attachments, [sessionId]: files } })),
  setModelSettings: (sessionId, settings) =>
    set((state) => ({
      modelSettings: {
        ...state.modelSettings,
        [sessionId]: { ...state.modelSettings[sessionId], ...settings },
      },
    })),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  clearSessionEphemera: (sessionId) =>
    set((state) => {
      const drafts = { ...state.drafts };
      const queuedPrompts = { ...state.queuedPrompts };
      const attachments = { ...state.attachments };
      const modelSettings = { ...state.modelSettings };
      const artifacts = { ...state.artifacts };
      const selectedArtifactIds = { ...state.selectedArtifactIds };
      delete drafts[sessionId];
      delete queuedPrompts[sessionId];
      delete attachments[sessionId];
      delete modelSettings[sessionId];
      delete artifacts[sessionId];
      delete selectedArtifactIds[sessionId];
      return { drafts, queuedPrompts, attachments, modelSettings, artifacts, selectedArtifactIds };
    }),
}));

export const __testing = { clampRailWidth };
