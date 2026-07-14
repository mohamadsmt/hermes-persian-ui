import { describe, expect, it } from "vitest";

import type { Message } from "@/lib/hermes";

import {
  classifyToolOutcome,
  messagesToTranscript,
  parseToolArguments,
  reconcileSessionHistory,
  reduceTranscript,
} from "./transcript-state";

describe("transcript state", () => {
  it("preserves reasoning, tool, reasoning, tool, answer order", () => {
    let items = reduceTranscript([], { type: "reasoning-delta", id: "r1", text: "first" });
    items = reduceTranscript(items, { type: "upsert-tool", tool: { id: "t1", name: "one", status: "running" } });
    items = reduceTranscript(items, { type: "reasoning-delta", id: "r2", text: "second" });
    items = reduceTranscript(items, { type: "upsert-tool", tool: { id: "t2", name: "two", status: "complete" } });
    items = reduceTranscript(items, { type: "message-delta", id: "a1", delta: "answer" });

    expect(items.map((item) => item.kind)).toEqual(["reasoning", "tool", "reasoning", "tool", "message"]);
  });

  it("replaces full reasoning and final message without duplicating streamed content", () => {
    let items = reduceTranscript([], { type: "reasoning-delta", id: "r1", text: "part" });
    items = reduceTranscript(items, { type: "reasoning-delta", id: "r1", text: "complete", replace: true });
    items = reduceTranscript(items, { type: "message-delta", id: "a1", delta: "partial" });
    items = reduceTranscript(items, { type: "message-complete", id: "a1", content: "final", status: "complete" });

    expect(items[0]?.kind === "reasoning" && items[0].reasoning.content).toBe("complete");
    expect(items[1]?.kind === "message" && items[1].message.content).toBe("final");
  });

  it("classifies nested failures and cancellations without guessing from arbitrary text", () => {
    expect(classifyToolOutcome({ result: { success: false, error: "agent not found" } })).toBe("failed");
    expect(classifyToolOutcome({ result: '{"success":false,"error":"query is required"}' })).toBe("failed");
    expect(classifyToolOutcome({ result: { ok: false } })).toBe("failed");
    expect(classifyToolOutcome({ status: "cancelled" })).toBe("cancelled");
    expect(classifyToolOutcome({ result: "contains the word error but succeeded" })).toBe("complete");
    expect(classifyToolOutcome({ output: "", exit_code: 127, error: null })).toBe("failed");
    expect(classifyToolOutcome({ result: { output: "", exit_code: "1", error: null } })).toBe("failed");
    expect(classifyToolOutcome({ result: { output: "ok", exit_code: 0, error: null } })).toBe("complete");
  });

  it("parses valid JSON arguments and preserves raw strings", () => {
    expect(parseToolArguments('{"query":"x"}')).toEqual({ query: "x" });
    expect(parseToolArguments("plain text")).toBe("plain text");
  });

  it("hydrates tool calls and results in durable insertion order", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "go" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        reasoning: "inspect",
        toolCalls: [{ id: "call-1", function: { name: "agency_agents_inspect", arguments: "{}" } }],
      },
      {
        id: "result-1",
        role: "tool",
        content: '{"success":false,"error":"agent not found"}',
        rawContent: '{"success":false,"error":"agent not found"}',
        toolCallId: "call-1",
        toolName: "agency_agents_inspect",
      },
      { id: "a2", role: "assistant", content: "done" },
    ];

    const items = messagesToTranscript(messages);
    expect(items.map((item) => item.kind)).toEqual(["message", "reasoning", "tool", "message"]);
    const tool = items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.tool.status).toBe("failed");
    expect(tool?.kind === "tool" && tool.tool.output).toEqual({ success: false, error: "agent not found" });
  });

  it("marks hydrated nonzero terminal exit codes as failed", () => {
    const items = messagesToTranscript([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", function: { name: "terminal", arguments: "{}" } }],
      },
      {
        id: "result-1",
        role: "tool",
        content: '{"output":"nope","exit_code":1,"error":null}',
        toolCallId: "call-1",
        toolName: "terminal",
      },
    ]);

    const tool = items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" && tool.tool.status).toBe("failed");
  });

  it("uses raw history only when its id matches and it is at least as fresh as the snapshot", () => {
    const snapshot = {
      identity: { storedId: "stored-1", runtimeId: "runtime-1" },
      messages: [{ id: "snapshot-1", role: "assistant" as const, content: "new" }],
      messageCount: 1,
    };
    const raw = [{ id: "raw-1", role: "tool" as const, content: "raw" }];

    expect(reconcileSessionHistory(snapshot, { sessionId: "runtime-1", messages: raw }, "requested-1")).toBe(raw);
    expect(reconcileSessionHistory(
      { ...snapshot, messageCount: 2 },
      { sessionId: "stored-1", messages: raw },
      "stored-1",
    )).toBe(snapshot.messages);
    expect(reconcileSessionHistory(snapshot, { sessionId: "other", messages: raw }, "stored-1")).toBe(snapshot.messages);
    expect(reconcileSessionHistory(snapshot, null, "stored-1")).toBe(snapshot.messages);
  });
});
