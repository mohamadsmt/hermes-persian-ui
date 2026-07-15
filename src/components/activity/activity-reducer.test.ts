import {describe, expect, it} from "vitest";

import type {HermesEvent} from "@/lib/hermes/types";

import {
  ACTIVITY_LIMITS,
  activityReducer,
  createActivityState,
  selectActivityScope,
} from "./activity-reducer";

function event(
  type: string,
  payload: unknown,
  options: {id?: string; sessionId?: string; receivedAt?: number} = {},
): HermesEvent {
  return {
    connectionEpoch: 1,
    id: options.id ?? `${type}:1`,
    payload,
    receivedAt: options.receivedAt ?? 10,
    sessionId: options.sessionId,
    type,
  };
}

describe("activityReducer", () => {
  it("keeps unowned events in runtime scope instead of attributing them to the active session", () => {
    const state = activityReducer(
      createActivityState("default"),
      {
        type: "event",
        event: event("background.complete", {id: "job-1", summary: "Done"}),
      },
    );

    expect(state.runtime.backgroundCompletions).toHaveLength(1);
    expect(state.sessions).toEqual({});
  });

  it("routes explicitly owned events and preserves tool progress, diff, and duration", () => {
    let state = createActivityState("default");
    state = activityReducer(state, {
      type: "event",
      event: event(
        "tool.start",
        {tool_call_id: "tool-1", name: "apply_patch"},
        {sessionId: "session-1"},
      ),
    });
    state = activityReducer(state, {
      type: "event",
      event: event(
        "tool.complete",
        {
          tool_call_id: "tool-1",
          name: "apply_patch",
          progress_text: "Patched",
          inline_diff: "+ safe change",
          duration_seconds: 1.25,
        },
        {sessionId: "session-1", receivedAt: 20},
      ),
    });

    expect(selectActivityScope(state, "session-1").tools).toEqual([
      expect.objectContaining({
        durationSeconds: 1.25,
        id: "tool-1",
        inlineDiff: "+ safe change",
        progressText: "Patched",
        status: "complete",
      }),
    ]);
  });

  it("merges a tool_id lifecycle used by the gateway into one activity row", () => {
    let state = createActivityState("default");
    for (const [type, payload] of [
      ["tool.start", {tool_id: "tool-1", name: "terminal"}],
      ["tool.progress", {tool_id: "tool-1", preview: "50%"}],
      ["tool.complete", {tool_id: "tool-1", result: "passed", duration_s: 0.08}],
    ] as const) {
      state = activityReducer(state, {
        type: "event",
        event: event(type, payload, {id: `${type}:event`, sessionId: "session-1"}),
      });
    }

    expect(selectActivityScope(state, "session-1").tools).toEqual([
      expect.objectContaining({
        durationSeconds: 0.08,
        id: "tool-1",
        progressText: "50%",
        status: "complete",
        summary: "passed",
      }),
    ]);
  });

  it("bounds reasoning and subagent streams", () => {
    let state = createActivityState("default");
    state = activityReducer(state, {
      type: "event",
      event: event(
        "thinking.delta",
        {delta: "a".repeat(ACTIVITY_LIMITS.reasoningCharacters + 30)},
        {sessionId: "session-1"},
      ),
    });

    for (let index = 0; index < ACTIVITY_LIMITS.subagentEntries + 5; index += 1) {
      state = activityReducer(state, {
        type: "event",
        event: event(
          "subagent.progress",
          {subagent_id: "agent-1", delta: `entry-${index}`},
          {id: `subagent:${index}`, sessionId: "session-1", receivedAt: index + 1},
        ),
      });
    }

    const scope = selectActivityScope(state, "session-1");
    expect(scope.reasoning).toHaveLength(ACTIVITY_LIMITS.reasoningCharacters);
    expect(scope.subagents[0].entries).toHaveLength(ACTIVITY_LIMITS.subagentEntries);
    expect(scope.subagents[0].entries[0]).toBe("entry-5");
  });

  it("resets all live activity when the profile changes", () => {
    const populated = activityReducer(createActivityState("one"), {
      type: "event",
      event: event("tool.start", {id: "tool"}, {sessionId: "session-1"}),
    });
    const changed = activityReducer(populated, {type: "set-profile", profile: "two"});

    expect(changed.profile).toBe("two");
    expect(changed.sessions).toEqual({});
    expect(changed.runtime.backgroundCompletions).toEqual([]);
  });

  it("bounds the number of retained session scopes", () => {
    let state = createActivityState("default");
    for (let index = 0; index < ACTIVITY_LIMITS.sessions + 5; index += 1) {
      state = activityReducer(state, {
        type: "event",
        event: event(
          "tool.start",
          {id: `tool-${index}`},
          {id: `event-${index}`, sessionId: `session-${index}`},
        ),
      });
    }

    expect(Object.keys(state.sessions)).toHaveLength(ACTIVITY_LIMITS.sessions);
    expect(state.sessions["session-0"]).toBeUndefined();
    expect(state.sessions[`session-${ACTIVITY_LIMITS.sessions + 4}`]).toBeDefined();
  });
});
