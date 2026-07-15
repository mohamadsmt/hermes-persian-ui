import type { Message, SessionMessageHistory, SessionSnapshot } from "@/lib/hermes";

import type {
  ChatMessage,
  InteractivePrompt,
  ReasoningBlock,
  ToolRun,
  TranscriptItem,
} from "./ui-types";

export type TranscriptAction =
  | { type: "reset"; items?: TranscriptItem[] }
  | { type: "append-message"; message: ChatMessage }
  | { type: "message-delta"; id: string; delta: string; createdAt?: string }
  | {
      type: "message-complete";
      id: string;
      content?: string;
      createdAt?: string;
      status: NonNullable<ChatMessage["status"]>;
    }
  | { type: "message-status"; id: string; status: NonNullable<ChatMessage["status"]> }
  | {
      type: "reasoning-delta";
      id: string;
      text: string;
      createdAt?: string;
      replace?: boolean;
    }
  | { type: "reasoning-status"; id: string; status: NonNullable<ReasoningBlock["status"]> }
  | { type: "upsert-tool"; tool: ToolRun }
  | { type: "upsert-prompt"; prompt: InteractivePrompt }
  | { type: "expire-prompt"; id: string }
  | { type: "remove-prompt"; id: string };

function messageItem(message: ChatMessage): TranscriptItem {
  return { kind: "message", key: `message:${message.id}`, message };
}

function reasoningItem(reasoning: ReasoningBlock): TranscriptItem {
  return { kind: "reasoning", key: `reasoning:${reasoning.id}`, reasoning };
}

function toolItem(tool: ToolRun): TranscriptItem {
  return { kind: "tool", key: `tool:${tool.id}`, tool };
}

function promptItem(prompt: InteractivePrompt): TranscriptItem {
  return { kind: "prompt", key: `prompt:${prompt.id}`, prompt };
}

export function reduceTranscript(items: TranscriptItem[], action: TranscriptAction): TranscriptItem[] {
  switch (action.type) {
    case "reset":
      return action.items ?? [];
    case "append-message": {
      const key = `message:${action.message.id}`;
      const index = items.findIndex((item) => item.key === key);
      if (index === -1) return [...items, messageItem(action.message)];
      return items.map((item, itemIndex) =>
        itemIndex === index ? messageItem({ ...(item.kind === "message" ? item.message : {}), ...action.message }) : item,
      );
    }
    case "message-delta": {
      if (!action.delta) return items;
      const key = `message:${action.id}`;
      const index = items.findIndex((item) => item.key === key && item.kind === "message");
      if (index === -1) {
        return [
          ...items,
          messageItem({
            id: action.id,
            role: "assistant",
            content: action.delta,
            rawSource: action.delta,
            ...(action.createdAt ? { createdAt: action.createdAt } : {}),
            status: "streaming",
          }),
        ];
      }
      return items.map((item, itemIndex) =>
        itemIndex === index && item.kind === "message"
          ? messageItem({
              ...item.message,
              content: `${item.message.content}${action.delta}`,
              rawSource: `${item.message.rawSource}${action.delta}`,
              status: "streaming",
            })
          : item,
      );
    }
    case "message-complete": {
      const key = `message:${action.id}`;
      const index = items.findIndex((item) => item.key === key && item.kind === "message");
      if (index === -1) {
        if (!action.content) return items;
        return [
          ...items,
          messageItem({
            id: action.id,
            role: "assistant",
            content: action.content,
            rawSource: action.content,
            ...(action.createdAt ? { createdAt: action.createdAt } : {}),
            status: action.status,
          }),
        ];
      }
      return items.map((item, itemIndex) =>
        itemIndex === index && item.kind === "message"
          ? messageItem({
              ...item.message,
              content: action.content || item.message.content,
              rawSource: action.content || item.message.rawSource,
              status: action.status,
            })
          : item,
      );
    }
    case "message-status":
      return items.map((item) =>
        item.kind === "message" && item.message.id === action.id
          ? messageItem({ ...item.message, status: action.status })
          : item,
      );
    case "reasoning-delta": {
      if (!action.text) return items;
      const key = `reasoning:${action.id}`;
      const index = items.findIndex((item) => item.key === key && item.kind === "reasoning");
      if (index === -1) {
        return [
          ...items,
          reasoningItem({
            id: action.id,
            content: action.text,
            ...(action.createdAt ? { createdAt: action.createdAt } : {}),
            status: "streaming",
          }),
        ];
      }
      return items.map((item, itemIndex) =>
        itemIndex === index && item.kind === "reasoning"
          ? reasoningItem({
              ...item.reasoning,
              content: action.replace ? action.text : `${item.reasoning.content}${action.text}`,
              status: "streaming",
            })
          : item,
      );
    }
    case "reasoning-status":
      return items.map((item) =>
        item.kind === "reasoning" && item.reasoning.id === action.id
          ? reasoningItem({ ...item.reasoning, status: action.status })
          : item,
      );
    case "upsert-tool": {
      const key = `tool:${action.tool.id}`;
      const index = items.findIndex((item) => item.key === key && item.kind === "tool");
      if (index === -1) return [...items, toolItem(action.tool)];
      return items.map((item, itemIndex) =>
        itemIndex === index && item.kind === "tool"
          ? toolItem({ ...item.tool, ...action.tool })
          : item,
      );
    }
    case "upsert-prompt": {
      const key = `prompt:${action.prompt.id}`;
      const index = items.findIndex((item) => item.key === key && item.kind === "prompt");
      if (index === -1) return [...items, promptItem(action.prompt)];
      return items.map((item, itemIndex) =>
        itemIndex === index && item.kind === "prompt"
          ? promptItem({ ...item.prompt, ...action.prompt })
          : item,
      );
    }
    case "expire-prompt":
      return items.map((item) =>
        item.kind === "prompt" && item.prompt.id === action.id
          ? promptItem({ ...item.prompt, expiresAt: new Date(0).toISOString() })
          : item,
      );
    case "remove-prompt":
      return items.filter((item) => item.kind !== "prompt" || item.prompt.id !== action.id);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const source = value.trim();
  if (!source) return value;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return value;
  }
}

export function classifyToolOutcome(value: unknown): ToolRun["status"] {
  const root = asRecord(parseToolArguments(value));
  const nested = asRecord(parseToolArguments(root.result));
  const explicit = String(root.status ?? nested.status ?? "").toLowerCase();
  const exitCodes = [
    root.exit_code,
    root.exitCode,
    root.return_code,
    root.returncode,
    nested.exit_code,
    nested.exitCode,
    nested.return_code,
    nested.returncode,
  ];
  const hasNonZeroExitCode = exitCodes.some((value) => {
    if (typeof value === "number") return Number.isFinite(value) && value !== 0;
    if (typeof value !== "string" || !value.trim()) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric !== 0;
  });
  if (explicit === "cancelled" || explicit === "canceled") return "cancelled";
  if (
    explicit === "failed" ||
    explicit === "error" ||
    root.success === false ||
    root.ok === false ||
    nested.success === false ||
    nested.ok === false ||
    Boolean(root.error) ||
    Boolean(nested.error) ||
    hasNonZeroExitCode
  ) {
    return "failed";
  }
  return "complete";
}

/**
 * Select one coherent committed transcript after the raw history read and the
 * authoritative resume snapshot have both completed. History is read first,
 * so a shorter result is stale and must never replace the newer snapshot.
 */
export function reconcileSessionHistory(
  snapshot: SessionSnapshot,
  history: SessionMessageHistory | null,
  requestedStoredId: string,
): Message[] {
  if (!history) return snapshot.messages;
  const compatibleIds = new Set([
    requestedStoredId,
    snapshot.identity.storedId,
    snapshot.identity.runtimeId,
  ]);
  if (!compatibleIds.has(history.sessionId)) return snapshot.messages;
  const requiredCommittedCount = Math.max(snapshot.messageCount, snapshot.messages.length);
  if (history.messages.length < requiredCommittedCount) return snapshot.messages;
  return history.messages;
}

function timestampToIso(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const millis = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  return new Date(millis).toISOString();
}

function chatMessage(message: Message, content = message.content, userOrdinal?: number): ChatMessage {
  return {
    id: message.id,
    role: message.role === "tool" ? "system" : message.role,
    content,
    rawSource: content,
    ...(timestampToIso(message.timestamp) ? { createdAt: timestampToIso(message.timestamp) } : {}),
    status: "complete",
    ...(userOrdinal === undefined ? {} : { userOrdinal }),
  };
}

function toolCalls(value: unknown): Array<{ id: string; name: string; input?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const call = asRecord(entry);
    const fn = asRecord(call.function);
    const name = optionalString(fn.name ?? call.name ?? call.tool_name);
    if (!name) return [];
    const id = optionalString(call.id ?? call.tool_call_id) ?? `history-tool-${index}-${name}`;
    const rawInput = fn.arguments ?? call.arguments ?? call.args ?? call.args_text;
    return [{ id, name, ...(rawInput === undefined ? {} : { input: parseToolArguments(rawInput) }) }];
  });
}

/** Convert durable Hermes rows to the same ordered parts used by live gateway events. */
export function messagesToTranscript(messages: Message[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  let userOrdinal = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.reasoning) {
        items = reduceTranscript(items, {
          type: "reasoning-delta",
          id: `${message.id}:reasoning`,
          text: message.reasoning,
          ...(timestampToIso(message.timestamp) ? { createdAt: timestampToIso(message.timestamp) } : {}),
        });
        items = reduceTranscript(items, {
          type: "reasoning-status",
          id: `${message.id}:reasoning`,
          status: "complete",
        });
      }
      if (message.content) items = reduceTranscript(items, { type: "append-message", message: chatMessage(message) });
      for (const call of toolCalls(message.toolCalls)) {
        items = reduceTranscript(items, {
          type: "upsert-tool",
          tool: { id: call.id, name: call.name, status: "queued", ...(call.input === undefined ? {} : { input: call.input }) },
        });
      }
      continue;
    }
    if (message.role === "tool") {
      const id = message.toolCallId ?? message.id;
      const parsedOutput = parseToolArguments(message.rawContent ?? message.content);
      const current = items.find((item) => item.kind === "tool" && item.tool.id === id);
      items = reduceTranscript(items, {
        type: "upsert-tool",
        tool: {
          id,
          name: message.toolName ?? (current?.kind === "tool" ? current.tool.name : "tool"),
          status: classifyToolOutcome(parsedOutput),
          output: parsedOutput,
        },
      });
      continue;
    }
    const ordinal = message.role === "user" ? userOrdinal++ : undefined;
    items = reduceTranscript(items, { type: "append-message", message: chatMessage(message, message.content, ordinal) });
  }
  return items;
}
