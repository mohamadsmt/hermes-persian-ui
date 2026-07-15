import type {HermesEvent} from "@/lib/hermes/types";

export const ACTIVITY_LIMITS = {
  backgroundCompletions: 50,
  processes: 50,
  reasoningCharacters: 24_000,
  sessions: 64,
  subagentEntries: 40,
  subagents: 64,
  tools: 100,
} as const;

export type ActivityStatus =
  | "cancelled"
  | "complete"
  | "failed"
  | "queued"
  | "running"
  | "unknown";

export interface ActivityToolRun {
  id: string;
  name: string;
  status: ActivityStatus;
  progressText?: string;
  inlineDiff?: string;
  summary?: string;
  durationSeconds?: number;
  updatedAt: number;
}

export interface ActivitySubagent {
  id: string;
  parentId?: string;
  label: string;
  status: ActivityStatus;
  summary?: string;
  entries: string[];
  updatedAt: number;
}

export interface ActivityProcess {
  id: string;
  label: string;
  status: ActivityStatus;
  command?: string;
  startedAt?: number;
  updatedAt: number;
}

export interface BackgroundCompletion {
  id: string;
  label: string;
  status: ActivityStatus;
  summary?: string;
  completedAt: number;
}

export interface DelegationActivity {
  status: ActivityStatus;
  summary?: string;
  activeCount?: number;
  updatedAt: number;
}

export interface VerificationEvidence {
  status: ActivityStatus;
  summary?: string;
  command?: string;
  details?: string;
  updatedAt: number;
}

export interface ActivityScopeState {
  reasoning: string;
  tools: ActivityToolRun[];
  subagents: ActivitySubagent[];
  processes: ActivityProcess[];
  backgroundCompletions: BackgroundCompletion[];
  delegation?: DelegationActivity;
  verification?: VerificationEvidence;
}

export interface ActivityState {
  /** A profile change is a hard boundary so runtime events cannot bleed across profiles. */
  profile: string | null;
  sessions: Record<string, ActivityScopeState>;
  runtime: ActivityScopeState;
}

export interface ActivitySnapshot {
  tools?: ActivityToolRun[];
  subagents?: ActivitySubagent[];
  processes?: ActivityProcess[];
  backgroundCompletions?: BackgroundCompletion[];
  delegation?: DelegationActivity;
  verification?: VerificationEvidence;
}

export type ActivityAction =
  | {type: "event"; event: HermesEvent}
  | {type: "hydrate"; sessionId?: string; snapshot: ActivitySnapshot}
  | {type: "reset-session"; sessionId: string}
  | {type: "set-profile"; profile: string | null}
  | {type: "reset"};

function emptyScope(): ActivityScopeState {
  return {
    reasoning: "",
    tools: [],
    subagents: [],
    processes: [],
    backgroundCompletions: [],
  };
}

export function createActivityState(profile: string | null = null): ActivityState {
  return {profile, runtime: emptyScope(), sessions: {}};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

export function normalizeActivityStatus(value: unknown): ActivityStatus {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase().replaceAll("_", "-");
  if (["completed", "complete", "success", "succeeded", "done"].includes(normalized)) {
    return "complete";
  }
  if (["error", "errored", "failure", "failed"].includes(normalized)) return "failed";
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(normalized)) {
    return "cancelled";
  }
  if (["active", "running", "started", "streaming", "working"].includes(normalized)) {
    return "running";
  }
  if (["pending", "queued", "waiting"].includes(normalized)) return "queued";
  return "unknown";
}

function boundedAppend(value: string, addition: string, max: number): string {
  if (!addition) return value;
  const combined = `${value}${addition}`;
  return combined.length > max ? combined.slice(-max) : combined;
}

function upsertBounded<T extends {id: string}>(items: T[], item: T, limit: number): T[] {
  const next = [item, ...items.filter((current) => current.id !== item.id)];
  return next.slice(0, limit);
}

function eventSessionId(event: HermesEvent, payload: Record<string, unknown>): string | undefined {
  return (
    event.sessionId ??
    firstString(payload, "session_id", "sessionId", "parent_session_id", "parentSessionId")
  );
}

function eventId(event: HermesEvent, payload: Record<string, unknown>, prefix: string): string {
  return (
    firstString(
      payload,
      "tool_id",
      "toolId",
      "tool_call_id",
      "toolCallId",
      "subagent_id",
      "subagentId",
      "agent_id",
      "agentId",
      "process_id",
      "processId",
      "id",
    ) ?? `${prefix}:${event.id}`
  );
}

function eventText(payload: Record<string, unknown>): string | undefined {
  return firstString(
    payload,
    "delta",
    "text",
    "content",
    "message",
    "summary",
    "output",
    "progress",
    "progress_text",
    "progressText",
    "preview",
  );
}

function reduceScope(scope: ActivityScopeState, event: HermesEvent): ActivityScopeState {
  const payload = record(event.payload);
  const now = event.receivedAt || Date.now();

  if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
    const delta = eventText(payload) ?? (typeof event.payload === "string" ? event.payload : "");
    return {
      ...scope,
      reasoning: boundedAppend(scope.reasoning, delta, ACTIVITY_LIMITS.reasoningCharacters),
    };
  }

  if (event.type === "tool.start" || event.type === "tool.progress" || event.type === "tool.complete") {
    const id = eventId(event, payload, "tool");
    const previous = scope.tools.find((tool) => tool.id === id);
    const explicitStatus = normalizeActivityStatus(payload.status);
    const status =
      event.type === "tool.start"
        ? "running"
        : event.type === "tool.complete"
          ? explicitStatus === "failed" || explicitStatus === "cancelled"
            ? explicitStatus
            : "complete"
          : explicitStatus === "unknown"
            ? "running"
            : explicitStatus;
    const tool: ActivityToolRun = {
      id,
      name: firstString(payload, "name", "tool", "tool_name", "toolName") ?? previous?.name ?? "Tool",
      status,
      progressText:
        firstString(payload, "progress", "progress_text", "progressText", "preview", "message") ??
        previous?.progressText,
      inlineDiff:
        firstString(payload, "inline_diff", "inlineDiff", "diff") ?? previous?.inlineDiff,
      summary: firstString(payload, "summary", "output", "result") ?? previous?.summary,
      durationSeconds:
        firstNumber(payload, "duration_seconds", "durationSeconds", "duration_s", "duration") ??
        previous?.durationSeconds,
      updatedAt: now,
    };
    return {
      ...scope,
      tools: upsertBounded(scope.tools, tool, ACTIVITY_LIMITS.tools),
    };
  }

  if (event.type.startsWith("subagent.")) {
    const id = eventId(event, payload, "subagent");
    const previous = scope.subagents.find((agent) => agent.id === id);
    const statusFromEvent = event.type.split(".").at(-1);
    const status = normalizeActivityStatus(payload.status ?? statusFromEvent);
    const entry = eventText(payload);
    const entries = entry
      ? [...(previous?.entries ?? []), entry].slice(-ACTIVITY_LIMITS.subagentEntries)
      : (previous?.entries ?? []);
    const agent: ActivitySubagent = {
      id,
      parentId:
        firstString(payload, "parent_id", "parentId", "parent_agent_id", "parentAgentId") ??
        previous?.parentId,
      label:
        firstString(payload, "label", "name", "task", "description") ?? previous?.label ?? id,
      status: status === "unknown" ? previous?.status ?? "running" : status,
      summary: firstString(payload, "summary", "result") ?? previous?.summary,
      entries,
      updatedAt: now,
    };
    return {
      ...scope,
      subagents: upsertBounded(scope.subagents, agent, ACTIVITY_LIMITS.subagents),
    };
  }

  if (event.type === "background.complete") {
    const completion: BackgroundCompletion = {
      id: eventId(event, payload, "background"),
      label: firstString(payload, "label", "name", "task", "command") ?? "Background task",
      status:
        normalizeActivityStatus(payload.status) === "unknown"
          ? "complete"
          : normalizeActivityStatus(payload.status),
      summary: firstString(payload, "summary", "output", "message"),
      completedAt: now,
    };
    return {
      ...scope,
      backgroundCompletions: upsertBounded(
        scope.backgroundCompletions,
        completion,
        ACTIVITY_LIMITS.backgroundCompletions,
      ),
    };
  }

  if (event.type === "verification.status") {
    return {
      ...scope,
      verification: {
        status: normalizeActivityStatus(payload.status),
        summary: firstString(payload, "summary", "message", "result"),
        command: firstString(payload, "command"),
        details: firstString(payload, "details", "output", "evidence"),
        updatedAt: now,
      },
    };
  }

  if (event.type === "delegation.status") {
    return {
      ...scope,
      delegation: {
        status: normalizeActivityStatus(payload.status),
        summary: firstString(payload, "summary", "message"),
        activeCount: firstNumber(payload, "active_count", "activeCount", "count"),
        updatedAt: now,
      },
    };
  }

  if (event.type.startsWith("process.")) {
    const id = eventId(event, payload, "process");
    const previous = scope.processes.find((process) => process.id === id);
    const process: ActivityProcess = {
      id,
      label: firstString(payload, "label", "name", "command") ?? previous?.label ?? id,
      command: firstString(payload, "command") ?? previous?.command,
      status:
        normalizeActivityStatus(payload.status ?? event.type.split(".").at(-1)) === "unknown"
          ? previous?.status ?? "running"
          : normalizeActivityStatus(payload.status ?? event.type.split(".").at(-1)),
      startedAt: firstNumber(payload, "started_at", "startedAt") ?? previous?.startedAt,
      updatedAt: now,
    };
    return {
      ...scope,
      processes: upsertBounded(scope.processes, process, ACTIVITY_LIMITS.processes),
    };
  }

  return scope;
}

function hydrateScope(scope: ActivityScopeState, snapshot: ActivitySnapshot): ActivityScopeState {
  return {
    ...scope,
    tools: snapshot.tools?.slice(0, ACTIVITY_LIMITS.tools) ?? scope.tools,
    subagents: snapshot.subagents?.slice(0, ACTIVITY_LIMITS.subagents) ?? scope.subagents,
    processes: snapshot.processes?.slice(0, ACTIVITY_LIMITS.processes) ?? scope.processes,
    backgroundCompletions:
      snapshot.backgroundCompletions?.slice(0, ACTIVITY_LIMITS.backgroundCompletions) ??
      scope.backgroundCompletions,
    delegation: snapshot.delegation ?? scope.delegation,
    verification: snapshot.verification ?? scope.verification,
  };
}

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  if (action.type === "reset") return createActivityState(state.profile);

  if (action.type === "set-profile") {
    return action.profile === state.profile ? state : createActivityState(action.profile);
  }

  if (action.type === "reset-session") {
    if (!(action.sessionId in state.sessions)) return state;
    const sessions = {...state.sessions};
    delete sessions[action.sessionId];
    return {...state, sessions};
  }

  if (action.type === "hydrate") {
    if (!action.sessionId) {
      return {...state, runtime: hydrateScope(state.runtime, action.snapshot)};
    }
    const current = state.sessions[action.sessionId] ?? emptyScope();
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [action.sessionId]: hydrateScope(current, action.snapshot),
      },
    };
  }

  const payload = record(action.event.payload);
  const sessionId = eventSessionId(action.event, payload);
  if (!sessionId) {
    const runtime = reduceScope(state.runtime, action.event);
    return runtime === state.runtime ? state : {...state, runtime};
  }

  const current = state.sessions[sessionId] ?? emptyScope();
  const next = reduceScope(current, action.event);
  if (next === current) return state;
  const sessions = {...state.sessions, [sessionId]: next};
  const sessionIds = Object.keys(sessions);
  while (sessionIds.length > ACTIVITY_LIMITS.sessions) {
    const oldest = sessionIds.shift();
    if (oldest && oldest !== sessionId) delete sessions[oldest];
  }
  return {...state, sessions};
}

export function selectActivityScope(
  state: ActivityState,
  sessionId?: string | null,
): ActivityScopeState {
  return sessionId ? state.sessions[sessionId] ?? emptyScope() : emptyScope();
}
