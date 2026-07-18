import { beforeEach, describe, expect, it } from "vitest";

import { __testing, chatSessionScopeKey, useChatUiStore } from "./chat-store";

describe("chat UI store", () => {
  beforeEach(() => {
    useChatUiStore.setState({
      drafts: {},
      queuedPrompts: {},
      attachments: {},
      modelSettings: {},
      artifacts: {},
      selectedArtifactIds: {},
      artifactRailOpen: false,
    });
    localStorage.clear();
  });

  it("keeps model/provider choices scoped to their stored session id", () => {
    const state = useChatUiStore.getState();
    state.setModelSettings("stored-a", { model: "claude-sonnet-4.6", provider: "anthropic" });
    state.setModelSettings("stored-b", { model: "gpt-5.6-sol", provider: "openai-codex" });

    expect(useChatUiStore.getState().modelSettings).toEqual({
      "stored-a": { model: "claude-sonnet-4.6", provider: "anthropic" },
      "stored-b": { model: "gpt-5.6-sol", provider: "openai-codex" },
    });
    expect(localStorage.length).toBe(0);
  });

  it("keeps new-session and same-id ephemera isolated across profiles", () => {
    const defaultNew = chatSessionScopeKey("default");
    const researchNew = chatSessionScopeKey("research");
    const defaultStored = chatSessionScopeKey("default", "stored-a");
    const researchStored = chatSessionScopeKey("research", "stored-a");
    const state = useChatUiStore.getState();

    state.setDraft(defaultNew, "default draft");
    state.setDraft(researchNew, "research draft");
    state.enqueuePrompt(defaultStored, "default queued");
    state.enqueuePrompt(researchStored, "research queued");
    state.setModelSettings(defaultStored, { model: "gpt-5.6-sol" });
    state.setModelSettings(researchStored, { model: "claude-sonnet-4.6" });
    state.setAttachments(defaultStored, [{
      id: "default-file",
      name: "default.txt",
      kind: "file",
      size: 1,
      mimeType: "text/plain",
      status: "ready",
      refText: "@file:default.txt",
    }]);
    state.setAttachments(researchStored, [{
      id: "research-file",
      name: "research.txt",
      kind: "file",
      size: 1,
      mimeType: "text/plain",
      status: "ready",
      refText: "@file:research.txt",
    }]);
    state.addArtifact(defaultStored, {
      id: "artifact-default",
      title: "default.md",
      kind: "markdown",
      content: "default",
    });
    state.addArtifact(researchStored, {
      id: "artifact-research",
      title: "research.md",
      kind: "markdown",
      content: "research",
    });

    expect(useChatUiStore.getState()).toMatchObject({
      drafts: {
        "default:new": "default draft",
        "research:new": "research draft",
      },
      queuedPrompts: {
        "default:stored-a": ["default queued"],
        "research:stored-a": ["research queued"],
      },
      modelSettings: {
        "default:stored-a": { model: "gpt-5.6-sol" },
        "research:stored-a": { model: "claude-sonnet-4.6" },
      },
      attachments: {
        "default:stored-a": [{ id: "default-file", refText: "@file:default.txt" }],
        "research:stored-a": [{ id: "research-file", refText: "@file:research.txt" }],
      },
      artifacts: {
        "default:stored-a": [{ id: "artifact-default", content: "default" }],
        "research:stored-a": [{ id: "artifact-research", content: "research" }],
      },
      selectedArtifactIds: {
        "default:stored-a": "artifact-default",
        "research:stored-a": "artifact-research",
      },
    });

    state.clearSessionEphemera(defaultStored);
    expect(useChatUiStore.getState().queuedPrompts[researchStored]).toEqual(["research queued"]);
    expect(useChatUiStore.getState().modelSettings[researchStored]).toEqual({ model: "claude-sonnet-4.6" });
    expect(useChatUiStore.getState().attachments[researchStored]?.[0]?.refText).toBe("@file:research.txt");
    expect(useChatUiStore.getState().artifacts[researchStored]?.[0]?.content).toBe("research");
    expect(useChatUiStore.getState().selectedArtifactIds[researchStored]).toBe("artifact-research");
  });

  it("queues, edits, shifts, and clears only the selected session", () => {
    const state = useChatUiStore.getState();
    state.enqueuePrompt("stored-a", "one");
    state.enqueuePrompt("stored-a", "two");
    state.enqueuePrompt("stored-b", "other");
    state.replaceQueuedPrompt("stored-a", 1, "edited");

    expect(useChatUiStore.getState().shiftQueuedPrompt("stored-a")).toBe("one");
    expect(useChatUiStore.getState().queuedPrompts["stored-a"]).toEqual(["edited"]);
    useChatUiStore.getState().clearSessionEphemera("stored-a");
    expect(useChatUiStore.getState().queuedPrompts["stored-a"]).toBeUndefined();
    expect(useChatUiStore.getState().queuedPrompts["stored-b"]).toEqual(["other"]);
  });

  it("records a background artifact without stealing the visible artifact selection", () => {
    const state = useChatUiStore.getState();
    state.addArtifact("default:active", {
      id: "active-artifact",
      title: "active.md",
      kind: "markdown",
      content: "active",
    });
    state.addArtifact("default:background", {
      id: "background-artifact",
      title: "background.md",
      kind: "markdown",
      content: "background",
    }, { select: false });

    expect(useChatUiStore.getState()).toMatchObject({
      artifactRailOpen: true,
      selectedArtifactIds: {
        "default:active": "active-artifact",
      },
      artifacts: {
        "default:background": [{ id: "background-artifact" }],
      },
    });
  });

  it("keeps the resizable rail within usable desktop bounds", () => {
    expect(__testing.clampRailWidth(20)).toBe(280);
    expect(__testing.clampRailWidth(420)).toBe(420);
    expect(__testing.clampRailWidth(900)).toBe(560);
  });
});
