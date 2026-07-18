import type {
  ActiveSessionItem,
  HermesEvent,
  LiveSessionStatus,
  Message,
  ModelOption,
  PendingPrompt,
  SessionRuntimeInfo,
  SessionSnapshot,
  SessionSummary,
  ToolActivity,
  UsageStats,
} from "./types"
import type {
  RawActiveSessionItem,
  RawGatewayEvent,
  RawSessionMessage,
  RawSessionRuntimeInfo,
  RawSessionSnapshot,
} from "./schemas"

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        const item = asRecord(part)
        if (typeof item.text === "string") return item.text
        if (typeof item.content === "string") return item.content
        if (item.type === "image_url" || item.type === "image") return "[image]"
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }

  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function stableTextHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function normalizeMessage(raw: RawSessionMessage, index = 0): Message {
  const rawContent = raw.content ?? raw.text ?? ""
  const content = contentToText(rawContent)
  return {
    id: `${raw.role}:${raw.timestamp ?? index}:${stableTextHash(content)}`,
    role: raw.role,
    content,
    rawContent,
    ...(raw.timestamp === undefined ? {} : { timestamp: raw.timestamp }),
    ...(optionalString(raw.reasoning ?? raw.reasoning_content) ? { reasoning: raw.reasoning ?? raw.reasoning_content ?? undefined } : {}),
    ...(optionalString(raw.tool_call_id) ? { toolCallId: raw.tool_call_id ?? undefined } : {}),
    ...(optionalString(raw.tool_name) ? { toolName: raw.tool_name } : {}),
    ...(raw.tool_calls === undefined ? {} : { toolCalls: raw.tool_calls }),
  }
}

export function normalizeUsage(raw: unknown): UsageStats {
  const value = asRecord(raw)
  const number = (key: string) => (typeof value[key] === "number" ? value[key] : undefined)
  return {
    calls: number("calls") ?? 0,
    input: number("input") ?? 0,
    output: number("output") ?? 0,
    total: number("total") ?? 0,
    ...(number("context_max") === undefined ? {} : { contextMax: number("context_max") }),
    ...(number("context_percent") === undefined ? {} : { contextPercent: number("context_percent") }),
    ...(number("context_used") === undefined ? {} : { contextUsed: number("context_used") }),
    ...(number("cost_usd") === undefined ? {} : { costUsd: number("cost_usd") }),
  }
}

export function normalizeRuntimeInfo(raw: RawSessionRuntimeInfo | undefined): SessionRuntimeInfo | undefined {
  if (!raw) return undefined
  return {
    ...(raw.branch === undefined ? {} : { branch: raw.branch }),
    ...(raw.config_warning === undefined ? {} : { configWarning: raw.config_warning }),
    ...(raw.credential_warning === undefined ? {} : { credentialWarning: raw.credential_warning }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    ...(raw.desktop_contract === undefined ? {} : { contract: raw.desktop_contract }),
    ...(raw.fast === undefined ? {} : { fast: raw.fast }),
    ...(raw.install_warning === undefined ? {} : { installWarning: raw.install_warning }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.personality === undefined ? {} : { personality: raw.personality }),
    ...(raw.profile_name === undefined ? {} : { profileName: raw.profile_name }),
    ...(raw.provider === undefined ? {} : { provider: raw.provider }),
    ...(raw.reasoning_effort === undefined ? {} : { reasoningEffort: raw.reasoning_effort }),
    ...(raw.running === undefined ? {} : { running: raw.running }),
    ...(raw.service_tier === undefined ? {} : { serviceTier: raw.service_tier }),
    ...(raw.title === undefined ? {} : { title: raw.title }),
    ...(raw.usage === undefined ? {} : { usage: normalizeUsage(raw.usage) }),
    ...(raw.version === undefined ? {} : { version: raw.version }),
    ...(raw.yolo === undefined ? {} : { yolo: raw.yolo }),
  }
}

export function normalizeActiveSessionItem(raw: RawActiveSessionItem): ActiveSessionItem {
  return {
    identity: {
      runtimeId: raw.id,
      storedId: raw.session_key ?? raw.id,
    },
    current: raw.current ?? false,
    status: raw.status,
    ...(raw.title === undefined ? {} : { title: raw.title }),
    ...(raw.preview === undefined ? {} : { preview: raw.preview }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    messageCount: raw.message_count ?? 0,
    ...(raw.started_at === undefined ? {} : { startedAt: raw.started_at }),
    ...(raw.last_active === undefined ? {} : { lastActive: raw.last_active }),
  }
}

function normalizeLiveSessionStatus(
  status: string | undefined,
  running: boolean | undefined,
): LiveSessionStatus | undefined {
  if (status === "idle" || status === "starting" || status === "waiting" || status === "working") {
    return status
  }
  if (status === undefined) return undefined
  return running || status === "streaming" ? "working" : "idle"
}

export function normalizeSessionSnapshot(raw: RawSessionSnapshot, fallbackStoredId?: string): SessionSnapshot {
  const storedId = raw.stored_session_id ?? raw.session_key ?? raw.resumed ?? fallbackStoredId ?? raw.session_id
  const messages = raw.messages.map(normalizeMessage)
  const status = normalizeLiveSessionStatus(raw.status, raw.running)
  return {
    identity: { storedId, runtimeId: raw.session_id },
    messages,
    messageCount: raw.message_count ?? messages.length,
    ...(raw.started_at === undefined ? {} : { startedAt: raw.started_at }),
    ...(raw.info ? { info: normalizeRuntimeInfo(raw.info) } : {}),
    ...(raw.inflight === undefined ? {} : { inflight: raw.inflight }),
    ...(raw.running === undefined ? {} : { running: raw.running }),
    ...(status === undefined ? {} : { status }),
  }
}

export function normalizeSessionSummary(raw: Record<string, unknown>): SessionSummary {
  const number = (key: string) => (typeof raw[key] === "number" ? raw[key] : 0)
  return {
    id: String(raw.id ?? ""),
    ...(optionalString(raw._lineage_root_id) ? { lineageRootId: String(raw._lineage_root_id) } : {}),
    ...(optionalString(raw.parent_session_id) ? { parentSessionId: String(raw.parent_session_id) } : {}),
    ...(optionalString(raw.title) ? { title: String(raw.title) } : {}),
    ...(optionalString(raw.preview) ? { preview: String(raw.preview) } : {}),
    ...(optionalString(raw.model) ? { model: String(raw.model) } : {}),
    ...(optionalString(raw.source) ? { source: String(raw.source) } : {}),
    ...(optionalString(raw.cwd) ? { cwd: String(raw.cwd) } : {}),
    ...(optionalString(raw.profile) ? { profile: String(raw.profile) } : {}),
    archived: raw.archived === true,
    active: raw.is_active === true,
    startedAt: number("started_at"),
    lastActive: number("last_active"),
    messageCount: number("message_count"),
    inputTokens: number("input_tokens"),
    outputTokens: number("output_tokens"),
    toolCallCount: number("tool_call_count"),
  }
}

export function normalizeModels(raw: {
  model?: string
  provider?: string
  providers: Array<Record<string, unknown>>
}): ModelOption[] {
  const result: ModelOption[] = []
  for (const provider of raw.providers) {
    const slug = String(provider.slug ?? "")
    const providerName = String(provider.name ?? slug)
    const models = Array.isArray(provider.models) ? provider.models : []
    const pricing = asRecord(provider.pricing)
    const capabilities = asRecord(provider.capabilities)
    for (const modelValue of models) {
      if (typeof modelValue !== "string") continue
      const modelCapabilities = asRecord(capabilities[modelValue])
      const modelPricing = asRecord(pricing[modelValue])
      result.push({
        id: modelValue,
        provider: slug,
        providerName,
        current: raw.model === modelValue && (raw.provider === slug || provider.is_current === true),
        authenticated: provider.authenticated !== false,
        ...(optionalString(provider.warning) ? { warning: String(provider.warning) } : {}),
        ...(typeof modelCapabilities.fast === "boolean" ? { supportsFast: modelCapabilities.fast } : {}),
        ...(typeof modelCapabilities.reasoning === "boolean" ? { supportsReasoning: modelCapabilities.reasoning } : {}),
        ...(typeof modelPricing.input === "string" && typeof modelPricing.output === "string"
          ? {
              pricing: {
                input: modelPricing.input,
                output: modelPricing.output,
                ...(typeof modelPricing.cache === "string" || modelPricing.cache === null
                  ? { cache: modelPricing.cache as string | null }
                  : {}),
                ...(typeof modelPricing.free === "boolean" ? { free: modelPricing.free } : {}),
              },
            }
          : {}),
      })
    }
  }
  return result
}

export function makeHermesEvent(raw: RawGatewayEvent, connectionEpoch: number, sequence: number): HermesEvent {
  const payload = asRecord(raw.payload)
  const semanticId =
    optionalString(payload.event_id) ??
    optionalString(payload.sse_id) ??
    optionalString(payload.request_id) ??
    optionalString(payload.tool_id)
  const detail =
    optionalString(payload.status) ??
    optionalString(payload.kind) ??
    optionalString(payload.text) ??
    semanticId ??
    String(sequence)
  const id = `${connectionEpoch}:${raw.session_id ?? "global"}:${raw.type}:${semanticId ?? sequence}:${stableTextHash(detail)}`
  return {
    id,
    type: raw.type,
    ...(raw.session_id ? { sessionId: raw.session_id } : {}),
    ...(raw.payload === undefined ? {} : { payload: raw.payload }),
    connectionEpoch,
    receivedAt: Date.now(),
  }
}

export function pendingPromptFromEvent(event: HermesEvent): PendingPrompt | null {
  const payload = asRecord(event.payload)
  const sessionId = event.sessionId
  if (event.type === "clarify.request") {
    const requestId = optionalString(payload.request_id)
    if (!requestId) return null
    return {
      kind: "clarification",
      requestId,
      question: String(payload.question ?? ""),
      choices: Array.isArray(payload.choices) ? payload.choices.map(String) : [],
      ...(sessionId ? { sessionId } : {}),
    }
  }
  if (event.type === "approval.request") {
    return {
      kind: "approval",
      ...(optionalString(payload.request_id) ? { requestId: String(payload.request_id) } : {}),
      ...(optionalString(payload.command) ? { command: String(payload.command) } : {}),
      ...(optionalString(payload.description) ? { description: String(payload.description) } : {}),
      allowPermanent: payload.allow_permanent === true,
      ...(sessionId ? { sessionId } : {}),
    }
  }
  if (event.type === "sudo.request" || event.type === "secret.request") {
    const requestId = optionalString(payload.request_id)
    if (!requestId) return null
    if (event.type === "sudo.request") {
      return { kind: "sudo", requestId, ...(sessionId ? { sessionId } : {}) }
    }
    return {
      kind: "secret",
      requestId,
      ...(optionalString(payload.name) ? { name: String(payload.name) } : {}),
      ...(optionalString(payload.prompt) ? { prompt: String(payload.prompt) } : {}),
      ...(sessionId ? { sessionId } : {}),
    }
  }
  return null
}

export function toolActivityFromEvent(event: HermesEvent): ToolActivity | null {
  if (!event.type.startsWith("tool.")) return null
  const payload = asRecord(event.payload)
  const id = optionalString(payload.tool_id)
  if (!id) return null
  const status: ToolActivity["status"] = event.type === "tool.complete" ? "complete" : "running"
  return {
    id,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    name: String(payload.name ?? "tool"),
    status,
    ...(optionalString(payload.context) ? { context: String(payload.context) } : {}),
    ...(payload.args === undefined && payload.args_text === undefined
      ? {}
      : { args: payload.args ?? payload.args_text }),
    ...(payload.result === undefined ? {} : { output: payload.result }),
    ...(optionalString(payload.result_text) ? { rawOutput: String(payload.result_text) } : {}),
    ...(optionalString(payload.summary) ? { summary: String(payload.summary) } : {}),
    ...(optionalString(payload.inline_diff) ? { inlineDiff: String(payload.inline_diff) } : {}),
    ...(optionalString(payload.text ?? payload.preview)
      ? { progress: String(payload.text ?? payload.preview) }
      : {}),
    ...(typeof payload.duration_s === "number" ? { durationSeconds: payload.duration_s } : {}),
  }
}

export interface HermesEventState {
  events: HermesEvent[]
  tools: Record<string, ToolActivity>
  prompts: PendingPrompt[]
}

export const emptyHermesEventState: HermesEventState = { events: [], tools: {}, prompts: [] }

/** Pure reducer used by UI stores; a server snapshot should replace, not append to, transcript state. */
export function reduceHermesEventState(state: HermesEventState, event: HermesEvent): HermesEventState {
  const tool = toolActivityFromEvent(event)
  const prompt = pendingPromptFromEvent(event)
  return {
    events: [...state.events, event],
    tools: tool ? { ...state.tools, [tool.id]: { ...state.tools[tool.id], ...tool } } : state.tools,
    prompts: prompt ? [...state.prompts.filter((item) => item.sessionId !== prompt.sessionId || item.kind !== prompt.kind), prompt] : state.prompts,
  }
}
