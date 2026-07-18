import { beforeEach, describe, expect, it } from "vitest";

import type { Message, PendingPrompt, SessionSnapshot } from "@/lib/hermes";

import {
  sessionAttention,
  sessionRuntimeScopeKey,
  useSessionRuntimeStore,
} from "./session-runtime-store";

function message(id: string, role: Message["role"], content: string): Message {
  return { id, role, content };
}

function snapshot(
  storedId: string,
  runtimeId: string,
  messages: Message[] = [],
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    identity: { storedId, runtimeId },
    messages,
    messageCount: messages.length,
    running: false,
    status: "idle",
    ...overrides,
  };
}

const approval: PendingPrompt = {
  kind: "approval",
  requestId: "approval-1",
  command: "pnpm test",
  allowPermanent: false,
};

describe("session runtime store", () => {
  beforeEach(() => {
    useSessionRuntimeStore.getState().reset();
    localStorage.clear();
  });

  it("routes interleaved transcript and stream updates to independent runtimes", () => {
    const store = useSessionRuntimeStore.getState();
    const scopeA = store.registerSession({
      profile: "default",
      storedId: "stored-a",
      runtimeId: "runtime-a",
      title: "A",
    });
    const scopeB = store.registerSession({
      profile: "default",
      storedId: "stored-b",
      runtimeId: "runtime-b",
      title: "B",
    });
    store.selectSession(scopeA);
    store.updateLiveState("runtime-a", { status: "working" });
    store.updateLiveState("runtime-b", { status: "working" });

    store.updateTranscript("runtime-a", {
      type: "message-delta",
      id: "assistant-a",
      delta: "alpha",
    });
    store.updateTranscript("runtime-b", {
      type: "message-delta",
      id: "assistant-b",
      delta: "bravo",
    });
    store.setStreamMetadata("runtime-a", {
      assistantRunId: "run-a",
      assistantMessageId: "assistant-a",
      pendingTextDeltas: [" a2"],
    });
    store.setStreamMetadata("runtime-b", {
      assistantRunId: "run-b",
      assistantMessageId: "assistant-b",
      pendingTextDeltas: [" b2"],
    });

    const state = useSessionRuntimeStore.getState();
    expect(state.sessions[scopeA]?.transcriptItems).toMatchObject([
      { kind: "message", message: { id: "assistant-a", content: "alpha" } },
    ]);
    expect(state.sessions[scopeB]?.transcriptItems).toMatchObject([
      { kind: "message", message: { id: "assistant-b", content: "bravo" } },
    ]);
    expect(state.sessions[scopeA]?.stream).toMatchObject({
      assistantRunId: "run-a",
      assistantMessageId: "assistant-a",
      pendingTextDeltas: [" a2"],
    });
    expect(state.sessions[scopeB]?.stream).toMatchObject({
      assistantRunId: "run-b",
      assistantMessageId: "assistant-b",
      pendingTextDeltas: [" b2"],
    });
    expect(state.sessions[scopeA]?.unread).toBe(false);
    expect(state.sessions[scopeB]?.unread).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("isolates identical stored ids across profiles", () => {
    const store = useSessionRuntimeStore.getState();
    const defaultScope = store.registerSession({
      profile: "default",
      storedId: "shared",
      runtimeId: "runtime-default",
    });
    const researchScope = store.registerSession({
      profile: "research",
      storedId: "shared",
      runtimeId: "runtime-research",
    });
    store.updateTranscript("runtime-default", {
      type: "append-message",
      message: {
        id: "default-user",
        role: "user",
        content: "default",
        rawSource: "default",
      },
    });
    store.updateTranscript("runtime-research", {
      type: "append-message",
      message: {
        id: "research-user",
        role: "user",
        content: "research",
        rawSource: "research",
      },
    });

    const state = useSessionRuntimeStore.getState();
    expect(defaultScope).toBe(sessionRuntimeScopeKey("default", "shared"));
    expect(researchScope).toBe(sessionRuntimeScopeKey("research", "shared"));
    expect(state.findByStored("default", "shared")?.profile).toBe("default");
    expect(state.findByStored("research", "shared")?.profile).toBe("research");
    expect(state.findByRuntime("runtime-default")?.transcriptItems).toMatchObject([
      { kind: "message", message: { content: "default" } },
    ]);
    expect(state.findByRuntime("runtime-research")?.transcriptItems).toMatchObject([
      { kind: "message", message: { content: "research" } },
    ]);
  });

  it("marks only completed background work unread and prioritizes waiting", () => {
    const store = useSessionRuntimeStore.getState();
    const scopeA = store.registerSession({
      profile: "default",
      storedId: "stored-a",
      runtimeId: "runtime-a",
    });
    const scopeB = store.registerSession({
      profile: "default",
      storedId: "stored-b",
      runtimeId: "runtime-b",
    });
    store.selectSession(scopeA);
    store.updateLiveState("runtime-a", { status: "working" });
    store.updateLiveState("runtime-b", { status: "working" });
    store.updateLiveState("runtime-a", { status: "idle" });
    store.updateLiveState("runtime-b", { status: "idle" });

    expect(useSessionRuntimeStore.getState().sessions[scopeA]?.unread).toBe(false);
    expect(useSessionRuntimeStore.getState().sessions[scopeB]?.unread).toBe(true);
    expect(sessionAttention(useSessionRuntimeStore.getState().sessions[scopeB]!)).toBe("unread");

    store.setDomainPrompt("runtime-b", "approval-1", approval);
    expect(useSessionRuntimeStore.getState().sessions[scopeB]).toMatchObject({
      needsInput: true,
      liveStatus: "waiting",
      unread: true,
    });
    expect(sessionAttention(useSessionRuntimeStore.getState().sessions[scopeB]!)).toBe("waiting");
    store.updateLiveState("runtime-b", { status: "idle" });
    expect(useSessionRuntimeStore.getState().sessions[scopeB]).toMatchObject({
      needsInput: true,
      liveStatus: "waiting",
    });

    store.selectSession(scopeB);
    expect(useSessionRuntimeStore.getState().sessions[scopeB]?.unread).toBe(false);
    expect(sessionAttention(useSessionRuntimeStore.getState().sessions[scopeB]!)).toBe("waiting");
  });

  it("changes unread only when a transcript event explicitly opts in", () => {
    const store = useSessionRuntimeStore.getState();
    const scopeA = store.registerSession({ profile: "default", storedId: "a", runtimeId: "ra" });
    const scopeB = store.registerSession({ profile: "default", storedId: "b", runtimeId: "rb" });
    store.selectSession(scopeA);

    store.updateTranscript("rb", { type: "message-delta", id: "b1", delta: "one" });
    expect(useSessionRuntimeStore.getState().sessions[scopeB]?.unread).toBe(false);

    store.updateTranscript(
      "rb",
      { type: "message-delta", id: "b1", delta: " two" },
      { markUnread: true },
    );
    expect(useSessionRuntimeStore.getState().sessions[scopeB]?.unread).toBe(true);

    store.updateTranscript(
      "ra",
      { type: "message-delta", id: "a1", delta: "selected" },
      { markUnread: true },
    );
    expect(useSessionRuntimeStore.getState().sessions[scopeA]?.unread).toBe(false);

    store.updateLiveState("rb", { status: "waiting", needsInput: true });
    store.updateTranscript("rb", { type: "message-delta", id: "b1", delta: " still waiting" });
    expect(useSessionRuntimeStore.getState().sessions[scopeB]).toMatchObject({
      liveStatus: "waiting",
      needsInput: true,
    });
  });

  it("rotates runtime bindings without leaving stale reverse indexes", () => {
    const store = useSessionRuntimeStore.getState();
    const scopeA = store.registerSession({
      profile: "default",
      storedId: "stored-a",
      runtimeId: "runtime-old",
    });
    const scopeB = store.registerSession({
      profile: "default",
      storedId: "stored-b",
      runtimeId: "runtime-b",
    });

    expect(store.bindRuntime(scopeA, "runtime-new")).toBe(true);
    expect(useSessionRuntimeStore.getState().findByRuntime("runtime-old")).toBeUndefined();
    expect(useSessionRuntimeStore.getState().findByRuntime("runtime-new")?.scopeKey).toBe(scopeA);

    expect(store.bindRuntime(scopeB, "runtime-new")).toBe(true);
    expect(useSessionRuntimeStore.getState().sessions[scopeA]?.identity.runtimeId).toBeUndefined();
    expect(useSessionRuntimeStore.getState().findByRuntime("runtime-new")?.scopeKey).toBe(scopeB);

    expect(store.dropRuntimeBinding("runtime-new")).toBe(true);
    expect(useSessionRuntimeStore.getState().findByRuntime("runtime-new")).toBeUndefined();
    expect(useSessionRuntimeStore.getState().sessions[scopeB]).toMatchObject({
      running: false,
      liveStatus: "idle",
      needsInput: false,
    });
  });

  it("hydrates inflight snapshots and rejects stale async hydration", () => {
    const store = useSessionRuntimeStore.getState();
    const scope = store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-a", [message("u1", "user", "hello")], {
        running: true,
        status: "working",
        info: { title: "Live A" },
        inflight: { user: "next", assistant: "partial", streaming: true },
      }),
      { version: 2 },
    );
    const hydrated = useSessionRuntimeStore.getState().sessions[scope]!;
    expect(hydrated).toMatchObject({
      title: "Live A",
      running: true,
      liveStatus: "working",
      snapshotVersion: 2,
      stream: {
        assistantMessageId: "runtime-a:inflight:text:0",
        assistantPartSequence: 1,
      },
    });
    expect(hydrated.transcriptItems).toMatchObject([
      { kind: "message", message: { id: "u1", content: "hello" } },
      { kind: "message", message: { content: "next" } },
      { kind: "message", message: { content: "partial", status: "streaming" } },
    ]);

    const revisionBeforeRequest = store.getRevision(scope)!;
    store.updateTranscript("runtime-a", {
      type: "message-delta",
      id: "live-delta",
      delta: "newer",
    });
    store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-stale", [message("old", "assistant", "old")]),
      { expectedRevision: revisionBeforeRequest, version: 3 },
    );
    expect(useSessionRuntimeStore.getState().sessions[scope]?.identity.runtimeId).toBe("runtime-a");
    expect(useSessionRuntimeStore.getState().sessions[scope]?.transcriptItems).toContainEqual(
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({ id: "live-delta", content: "newer" }),
      }),
    );

    store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-older", [message("older", "assistant", "older")]),
      { version: 1 },
    );
    expect(useSessionRuntimeStore.getState().sessions[scope]?.identity.runtimeId).toBe("runtime-a");
  });

  it("preserves pending prompts while activating a rotated runtime after reconnect", () => {
    const store = useSessionRuntimeStore.getState();
    const scope = store.registerSession({
      profile: "default",
      storedId: "stored-a",
      runtimeId: "runtime-before-reconnect",
    });
    store.setDomainPrompt(scope, "approval-1", approval);
    store.updateTranscript(scope, {
      type: "upsert-prompt",
      prompt: {
        id: "approval-1",
        requestId: "approval-1",
        kind: "approval",
        title: "Approval required",
      },
    });
    store.setStreamMetadata(scope, {
      assistantRunId: "run-before-reconnect",
      assistantMessageId: "message-before-reconnect",
    });
    const revision = store.getRevision(scope);

    store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-after-reconnect", [message("u1", "user", "hello")]),
      { expectedRevision: revision },
    );

    const reconnected = useSessionRuntimeStore.getState().sessions[scope]!;
    expect(useSessionRuntimeStore.getState().findByRuntime("runtime-before-reconnect")).toBeUndefined();
    expect(useSessionRuntimeStore.getState().findByRuntime("runtime-after-reconnect")?.scopeKey).toBe(scope);
    expect(reconnected.domainPrompts["approval-1"]).toEqual(approval);
    expect(reconnected.transcriptItems).toContainEqual(expect.objectContaining({
      kind: "prompt",
      prompt: expect.objectContaining({ id: "approval-1" }),
    }));
    expect(reconnected.stream).toMatchObject({
      assistantRunId: "run-before-reconnect",
      assistantMessageId: "message-before-reconnect",
    });
    expect(reconnected).toMatchObject({
      needsInput: true,
      liveStatus: "waiting",
      running: true,
    });

    store.updateTranscript(scope, { type: "remove-prompt", id: "approval-1" });
    expect(useSessionRuntimeStore.getState().sessions[scope]).toMatchObject({
      domainPrompts: {},
      needsInput: false,
      liveStatus: "working",
    });
  });

  it("merges snapshot metadata across status polls without overwriting newer deltas", () => {
    const store = useSessionRuntimeStore.getState();
    const scope = store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-a", [message("u1", "user", "initial")]),
    );
    const transcriptRevisionBeforePoll = useSessionRuntimeStore.getState()
      .sessions[scope]!.transcriptRevision;

    // A status poll changes the broad revision, but not transcript freshness.
    store.updateLiveState(scope, { status: "starting" });
    store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-b", [message("u2", "user", "from snapshot")], {
        status: "working",
        running: true,
        info: { title: "Activated" },
      }),
      { expectedTranscriptRevision: transcriptRevisionBeforePoll },
    );
    expect(useSessionRuntimeStore.getState().sessions[scope]).toMatchObject({
      identity: { runtimeId: "runtime-b" },
      title: "Activated",
      liveStatus: "working",
      transcriptItems: [{ kind: "message", message: { id: "u2", content: "from snapshot" } }],
    });

    const transcriptRevisionBeforeDelta = useSessionRuntimeStore.getState()
      .sessions[scope]!.transcriptRevision;
    store.updateTranscript("runtime-b", {
      type: "message-delta",
      id: "live-assistant",
      delta: "new live delta",
    });
    store.setStreamMetadata("runtime-b", {
      assistantRunId: "live-run",
      assistantMessageId: "live-assistant",
    });
    store.hydrateSnapshot(
      "default",
      snapshot("stored-a", "runtime-c", [message("stale", "assistant", "stale snapshot")], {
        status: "idle",
      }),
      { expectedTranscriptRevision: transcriptRevisionBeforeDelta },
    );

    const merged = useSessionRuntimeStore.getState().sessions[scope]!;
    expect(merged.identity.runtimeId).toBe("runtime-c");
    expect(merged.liveStatus).toBe("idle");
    expect(merged.stream).toMatchObject({
      assistantRunId: "live-run",
      assistantMessageId: "live-assistant",
    });
    expect(merged.transcriptItems).toContainEqual(expect.objectContaining({
      kind: "message",
      message: expect.objectContaining({ id: "live-assistant", content: "new live delta" }),
    }));
    expect(merged.transcriptItems).not.toContainEqual(expect.objectContaining({
      kind: "message",
      message: expect.objectContaining({ id: "stale" }),
    }));
  });

  it("drops one session cleanly and can reset all runtime bindings without persistence", () => {
    const store = useSessionRuntimeStore.getState();
    const scopeA = store.registerSession({ profile: "default", storedId: "a", runtimeId: "ra" });
    const scopeB = store.registerSession({ profile: "default", storedId: "b", runtimeId: "rb" });
    store.selectSession(scopeB);

    expect(store.dropSession(scopeB)).toBe(true);
    expect(useSessionRuntimeStore.getState()).toMatchObject({
      selectedScopeKey: null,
      runtimeToScope: { ra: scopeA },
    });
    expect(useSessionRuntimeStore.getState().sessions[scopeB]).toBeUndefined();

    store.resetRuntimeBindings();
    expect(useSessionRuntimeStore.getState().runtimeToScope).toEqual({});
    expect(useSessionRuntimeStore.getState().sessions[scopeA]?.identity.runtimeId).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });
});
