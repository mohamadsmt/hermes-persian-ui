import {
  bootstrapInfoSchema,
  rawModelOptionsSchema,
  rawProfileSessionListSchema,
  rawSessionHistorySchema,
  rawSessionListSchema,
  rawSessionMessageSchema,
  rawSessionMessagesResponseSchema,
  rawSessionSnapshotSchema,
  rawUsageSchema,
} from "./schemas"
import { isMethodNotFound, JsonRpcGatewayClient, type RpcClientOptions } from "./rpc-client"
import {
  contentToText,
  makeHermesEvent,
  normalizeMessage,
  normalizeModels,
  normalizeSessionSnapshot,
  normalizeSessionSummary,
  normalizeUsage,
} from "./normalize"
import {
  negotiateHttpFallback,
  streamHttpFallback,
  type HttpFallbackSelection,
  type HttpStreamEvent,
} from "./http-fallback"
import type {
  Attachment,
  AttachmentInput,
  BootstrapInfo,
  CapabilitySet,
  CommandResult,
  ConnectionState,
  HermesEvent,
  HermesTransport,
  Message,
  ModelOption,
  PendingPrompt,
  SendOptions,
  SessionCreateInput,
  SessionIdentity,
  SessionListOptions,
  SessionMessageHistory,
  SessionResumeOptions,
  SessionSnapshot,
  SessionSummary,
  UsageStats,
} from "./types"
import { HERMES_MIN_GATEWAY_CONTRACT } from "./types"

const MAX_RECONNECT_ATTEMPTS = 4
const MAX_SEEN_EVENTS = 4_096

interface HttpLocalSession {
  identity: SessionIdentity
  messages: Message[]
  model?: string
  provider?: string
  previousResponseId?: string
  title?: string
}

const HTTP_INTERACTIVE_EVENT_NAMES = new Set([
  "approval.request",
  "clarify.request",
  "clarification.request",
  "secret.request",
  "sudo.request",
])

export interface CreateHermesTransportOptions extends RpcClientOptions {
  bootstrapPath?: string
  fetch?: typeof globalThis.fetch
  reconnect?: boolean
  sessionsPath?: string
}

export class HermesBackendUnavailableError extends Error {
  readonly bootstrap: BootstrapInfo

  constructor(bootstrap: BootstrapInfo) {
    super(bootstrap.error || `Hermes backend is ${bootstrap.state}`)
    this.name = "HermesBackendUnavailableError"
    this.bootstrap = bootstrap
  }
}

export class BrowserHermesTransport implements HermesTransport {
  private readonly client: JsonRpcGatewayClient
  private readonly bootstrapPath: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly reconnectEnabled: boolean
  private readonly sessionsPath: string
  private readonly eventListeners = new Set<(event: HermesEvent) => void>()
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private state: ConnectionState = "idle"
  private currentCapabilities: CapabilitySet = defaultCapabilities()
  private bootstrap: BootstrapInfo | null = null
  private wsUrl: string | null = null
  private explicitDisconnect = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private connectionEpoch = 0
  private eventSequence = 0
  private attachmentSequence = 0
  private readonly seenEvents = new Set<string>()
  private httpSelection: HttpFallbackSelection | null = null
  private readonly httpSessions = new Map<string, HttpLocalSession>()
  private readonly httpAborts = new Map<string, AbortController>()
  private httpModels: ModelOption[] = []

  constructor(options: CreateHermesTransportOptions = {}) {
    this.client = new JsonRpcGatewayClient(options)
    this.bootstrapPath = options.bootstrapPath ?? "/api/hermes/bootstrap"
    this.sessionsPath = options.sessionsPath ?? "/api/hermes/sessions"
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.reconnectEnabled = options.reconnect ?? true

    this.client.onEvent((raw) => {
      const event = makeHermesEvent(raw, this.connectionEpoch, ++this.eventSequence)
      if (this.seenEvents.has(event.id)) return
      this.seenEvents.add(event.id)
      if (this.seenEvents.size > MAX_SEEN_EVENTS) {
        const oldest = this.seenEvents.values().next().value
        if (oldest) this.seenEvents.delete(oldest)
      }
      for (const listener of this.eventListeners) listener(event)
    })
    this.client.onState((state) => {
      if (state === "closed" && !this.explicitDisconnect && this.reconnectEnabled && this.wsUrl) {
        this.scheduleReconnect()
        return
      }
      if (state === "connecting" && this.reconnectAttempts > 0) {
        this.setState("reconnecting")
        return
      }
      this.setState(state)
    })
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  get capabilities(): CapabilitySet {
    return { ...this.currentCapabilities }
  }

  async connect(): Promise<BootstrapInfo> {
    this.explicitDisconnect = false
    clearTimeout(this.reconnectTimer)
    this.httpSelection = null
    this.setState("connecting")
    const response = await this.fetchImpl(this.bootstrapPath, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const body: unknown = await response.json().catch(() => null)
    const parsed = bootstrapInfoSchema.safeParse(body)
    if (!parsed.success) throw new Error("Hermes bootstrap response is incompatible")
    this.bootstrap = parsed.data
    this.currentCapabilities = { ...parsed.data.capabilities }
    if (!response.ok || !parsed.data.ready) throw new HermesBackendUnavailableError(parsed.data)

    let gatewayError: unknown
    if (parsed.data.capabilities.gateway) {
      this.wsUrl = sameOriginWebSocketUrl(parsed.data.wsPath)
      this.connectionEpoch += 1
      try {
        await this.client.connect(this.wsUrl)
        this.reconnectAttempts = 0
        return parsed.data
      } catch (error) {
        gatewayError = error
        this.wsUrl = null
        if (!parsed.data.capabilities.httpFallback) throw error
      }
    }

    if (!parsed.data.capabilities.httpFallback) {
      throw gatewayError instanceof Error ? gatewayError : new Error("Hermes gateway is unavailable")
    }
    const selection = await negotiateHttpFallback(this.fetchImpl)
    if (!selection) {
      throw gatewayError instanceof Error
        ? new Error(`Hermes gateway and HTTP fallback are unavailable: ${gatewayError.message}`)
        : new Error("Hermes HTTP fallback is unavailable")
    }
    this.httpSelection = selection
    this.connectionEpoch += 1
    this.configureHttpCapabilities(parsed.data.capabilities, selection)
    this.setState("open")
    const connected = { ...parsed.data, capabilities: { ...this.currentCapabilities } }
    this.bootstrap = connected
    return connected
  }

  disconnect(): void {
    this.explicitDisconnect = true
    clearTimeout(this.reconnectTimer)
    for (const controller of this.httpAborts.values()) controller.abort()
    this.httpAborts.clear()
    if (this.wsUrl) this.client.close()
    else this.setState("closed")
  }

  onEvent(listener: (event: HermesEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => this.stateListeners.delete(listener)
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.httpSelection) throw unsupportedHttpFallback(method)
    try {
      return await this.client.request<T>(method, params, signal)
    } catch (error) {
      if (isMethodNotFound(error)) this.disableCapabilityForMethod(method)
      throw error
    }
  }

  async sessionCreate(input: SessionCreateInput = {}): Promise<SessionSnapshot> {
    if (this.httpSelection) return this.createHttpSession(input)
    const raw = await this.request("session.create", {
      cols: 100,
      source: "web",
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      ...(input.fast === undefined ? {} : { fast: input.fast }),
      ...(input.parentSessionId ? { parent_session_id: input.parentSessionId } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
    })
    const snapshot = normalizeSessionSnapshot(rawSessionSnapshotSchema.parse(raw))
    assertGatewayContract(snapshot)
    return snapshot
  }

  async sessionList(options: SessionListOptions): Promise<SessionSummary[]> {
    if (this.httpSelection) return []
    const profile = requireProfileName(options.profile)
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 100), 200))

    // The deterministic gateway deliberately has no dashboard state.db. Keep
    // its session fixture on RPC, but tag every row with the explicitly chosen
    // profile. HERMES_TEST_MODE is rejected by the production server.
    if (this.bootstrap?.mode === "test") {
      const raw = rawSessionListSchema.parse(await this.request("session.list", { limit }))
      const sessions = Array.isArray(raw) ? raw : raw.sessions
      return filterSessions(
        sessions.map((session) => normalizeSessionSummary({ ...session, profile })),
        options.query,
      )
    }

    const separator = this.sessionsPath.includes("?") ? "&" : "?"
    const sessionsUrl = `${this.sessionsPath}${separator}${new URLSearchParams({ profile, limit: String(limit) })}`
    const response = await this.fetchImpl(sessionsUrl, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(readBffError(body, `Could not list Hermes sessions for profile ${profile}`))
    const parsed = rawProfileSessionListSchema.safeParse(body)
    if (!parsed.success) throw new Error("Hermes profile session response is incompatible")
    const profileError = parsed.data.errors?.find((item) => item.profile === profile)
    if (profileError) throw new Error(`Could not list Hermes sessions for profile ${profile}: ${profileError.error}`)
    if (parsed.data.sessions.some((session) => session.profile !== profile)) {
      throw new Error("Hermes returned sessions from a different profile")
    }
    const normalized = parsed.data.sessions.map((session) => normalizeSessionSummary(session))
    return filterSessions(normalized, options.query)
  }

  async sessionResume(storedId: string, options: SessionResumeOptions = {}): Promise<SessionSnapshot> {
    if (this.httpSelection) {
      const session = this.httpSessions.get(storedId)
      if (!session) throw new Error("HTTP fallback conversations are local to this page and cannot be resumed")
      return this.httpSnapshot(session)
    }
    const raw = await this.request("session.resume", {
      session_id: storedId,
      cols: 100,
      source: "web",
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.lazy === undefined ? {} : { lazy: options.lazy }),
    })
    const snapshot = normalizeSessionSnapshot(rawSessionSnapshotSchema.parse(raw), storedId)
    assertGatewayContract(snapshot)
    return snapshot
  }

  async sessionMessages(storedSessionId: string, rawProfile: string): Promise<SessionMessageHistory> {
    const profile = requireProfileName(rawProfile)
    if (this.httpSelection) {
      const session = this.requireHttpSession(storedSessionId)
      return { sessionId: session.identity.storedId, messages: [...session.messages] }
    }

    const basePath = `${this.sessionsPath.replace(/\/+$/, "")}/${encodeURIComponent(storedSessionId)}/messages`
    const separator = basePath.includes("?") ? "&" : "?"
    const response = await this.fetchImpl(`${basePath}${separator}${new URLSearchParams({ profile })}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(readBffError(body, `Could not read Hermes session messages for profile ${profile}`))
    }
    const parsed = rawSessionMessagesResponseSchema.safeParse(body)
    if (!parsed.success) throw new Error("Hermes profile session messages response is incompatible")
    return {
      sessionId: parsed.data.session_id,
      messages: parsed.data.messages.map((message, index) => normalizeMessage(message, index)),
    }
  }

  async sessionHistory(session: SessionIdentity | string) {
    if (this.httpSelection) return [...this.requireHttpSession(session).messages]
    const raw = rawSessionHistorySchema.parse(
      await this.request("session.history", { session_id: runtimeId(session) }),
    )
    return raw.messages.map(normalizeMessage)
  }

  async sessionRename(session: SessionIdentity | string, title: string, rawProfile: string): Promise<void> {
    if (this.httpSelection) {
      this.requireHttpSession(session).title = title
      return
    }
    const profile = requireProfileName(rawProfile)
    if (typeof session !== "string") {
      await this.request("session.title", { session_id: session.runtimeId, title })
      return
    }
    if (this.bootstrap?.mode === "test") {
      const resumed = await this.sessionResume(session, { profile, lazy: true })
      try {
        await this.request("session.title", { session_id: resumed.identity.runtimeId, title })
      } finally {
        await this.sessionClose(resumed.identity).catch(() => undefined)
      }
      return
    }
    await this.mutateProfileSession(storedId(session), profile, "PATCH", { title })
  }

  async sessionDelete(storedId: string, rawProfile: string): Promise<void> {
    if (this.httpSelection) {
      this.abortHttpSession(storedId)
      this.httpSessions.delete(storedId)
      return
    }
    const profile = requireProfileName(rawProfile)
    if (this.bootstrap?.mode === "test") {
      await this.request("session.delete", { session_id: storedId })
      return
    }
    await this.mutateProfileSession(storedId, profile, "DELETE")
  }

  async sessionClose(session: SessionIdentity | string): Promise<void> {
    if (this.httpSelection) {
      const id = runtimeId(session)
      this.abortHttpSession(id)
      this.httpSessions.delete(id)
      return
    }
    await this.request("session.close", { session_id: runtimeId(session) })
  }

  async sessionBranch(session: SessionIdentity | string, name?: string): Promise<SessionSnapshot> {
    if (this.httpSelection) throw unsupportedHttpFallback("session.branch")
    const result = (await this.request("session.branch", {
      session_id: runtimeId(session),
      ...(name ? { name } : {}),
    })) as Record<string, unknown>
    const newRuntimeId = String(result.session_id ?? "")
    if (!newRuntimeId) throw new Error("Hermes did not return a branch session id")

    let storedId = optionalString(result.stored_session_id) ?? newRuntimeId
    try {
      const active = (await this.request("session.active_list", { current_session_id: newRuntimeId })) as {
        sessions?: Array<Record<string, unknown>>
      }
      const row = active.sessions?.find((item) => item.id === newRuntimeId)
      storedId = optionalString(row?.session_key) ?? storedId
    } catch {
      // Older gateways omit active_list; runtime id remains a safe live fallback.
    }
    return {
      identity: { runtimeId: newRuntimeId, storedId },
      messages: await this.sessionHistory(newRuntimeId),
      messageCount: 0,
      info: { ...(name ? { title: name } : {}) },
    }
  }

  async sessionCompress(session: SessionIdentity | string, focusTopic?: string) {
    if (this.httpSelection) throw unsupportedHttpFallback("session.compress")
    const result = (await this.request("session.compress", {
      session_id: runtimeId(session),
      ...(focusTopic ? { focus_topic: focusTopic } : {}),
    })) as { messages?: unknown[] }
    return (result.messages ?? []).map((message, index) => normalizeMessage(rawSessionMessageSchema.parse(message), index))
  }

  async sessionUsage(session: SessionIdentity | string): Promise<UsageStats> {
    if (this.httpSelection) throw unsupportedHttpFallback("session.usage")
    return normalizeUsage(rawUsageSchema.parse(await this.request("session.usage", { session_id: runtimeId(session) })))
  }

  async send(session: SessionIdentity | string, text: string, options: SendOptions = {}): Promise<void> {
    if (!text.trim()) throw new Error("Message cannot be empty")
    if (this.httpSelection) {
      await this.sendHttpPrompt(session, text)
      return
    }
    if (options.busyMode === "steer" && (await this.steer(session, text))) return
    await this.request("prompt.submit", {
      session_id: runtimeId(session),
      text,
      ...(options.truncateBeforeUserOrdinal === undefined
        ? {}
        : { truncate_before_user_ordinal: options.truncateBeforeUserOrdinal }),
    })
  }

  async stop(session: SessionIdentity | string): Promise<void> {
    if (this.httpSelection) {
      this.httpAborts.get(runtimeId(session))?.abort()
      return
    }
    await this.request("session.interrupt", { session_id: runtimeId(session) })
  }

  async steer(session: SessionIdentity | string, text: string): Promise<boolean> {
    if (this.httpSelection) return false
    const result = (await this.request("session.steer", {
      session_id: runtimeId(session),
      text,
    })) as { status?: string }
    return result.status === "queued"
  }

  async models(session?: SessionIdentity | string): Promise<ModelOption[]> {
    if (this.httpSelection) return [...this.httpModels]
    const result = rawModelOptionsSchema.parse(
      await this.request("model.options", {
        include_unconfigured: false,
        ...(session ? { session_id: runtimeId(session) } : {}),
      }),
    )
    return normalizeModels(result.providers ? result : { ...result, providers: [] })
  }

  async setModel(session: SessionIdentity | string, model: string, provider?: string): Promise<void> {
    if (this.httpSelection) {
      const local = this.requireHttpSession(session)
      local.model = model
      local.provider = provider ?? "hermes-api"
      return
    }
    const value = provider ? `${model} --provider ${provider} --session` : `${model} --session`
    await this.request("config.set", { session_id: runtimeId(session), key: "model", value })
  }

  async attach(session: SessionIdentity | string, input: AttachmentInput): Promise<Attachment> {
    if (this.httpSelection) throw unsupportedHttpFallback("attachment")
    const sessionId = runtimeId(session)
    let result: Record<string, unknown>
    if (input.kind === "image") {
      result = await this.request("image.attach_bytes", {
        session_id: sessionId,
        content_base64: input.dataUrl,
        filename: input.name,
      })
    } else if (input.kind === "pdf") {
      result = await this.request("pdf.attach", {
        session_id: sessionId,
        content_base64: input.dataUrl,
        filename: input.name,
      })
    } else {
      result = await this.request("file.attach", {
        session_id: sessionId,
        path: input.path ?? input.name,
        data_url: input.dataUrl,
        name: input.name,
      })
    }
    return {
      id: `attachment-${++this.attachmentSequence}`,
      kind: input.kind,
      name: optionalString(result.name) ?? input.name,
      mimeType: input.mimeType,
      size: input.size,
      ...(optionalString(result.path) ? { path: String(result.path) } : {}),
      ...(optionalString(result.ref_text) ? { refText: String(result.ref_text) } : {}),
      status: "attached",
    }
  }

  async command(session: SessionIdentity | string, command: string): Promise<CommandResult> {
    if (this.httpSelection) throw unsupportedHttpFallback("slash.exec")
    const result = (await this.request("slash.exec", {
      session_id: runtimeId(session),
      command,
    })) as { output?: unknown; warning?: unknown }
    return {
      output: String(result.output ?? ""),
      ...(optionalString(result.warning) ? { warning: String(result.warning) } : {}),
    }
  }

  async respondToClarification(
    prompt: Extract<PendingPrompt, { kind: "clarification" }>,
    answer: string,
  ): Promise<boolean> {
    if (this.httpSelection) throw unsupportedHttpFallback("clarify.respond")
    const result = (await this.request("clarify.respond", {
      request_id: prompt.requestId,
      answer,
      ...(prompt.sessionId ? { session_id: prompt.sessionId } : {}),
    })) as { status?: string }
    return result.status === "ok"
  }

  async respondToApproval(
    prompt: Extract<PendingPrompt, { kind: "approval" }>,
    choice: "once" | "always" | "deny",
  ): Promise<boolean> {
    if (this.httpSelection) throw unsupportedHttpFallback("approval.respond")
    const result = (await this.request("approval.respond", {
      choice,
      ...(prompt.sessionId ? { session_id: prompt.sessionId } : {}),
    })) as { resolved?: boolean }
    return result.resolved === true
  }

  async respondToSudo(prompt: Extract<PendingPrompt, { kind: "sudo" }>, password: string): Promise<boolean> {
    if (this.httpSelection) throw unsupportedHttpFallback("sudo.respond")
    const result = (await this.request("sudo.respond", {
      request_id: prompt.requestId,
      password,
      ...(prompt.sessionId ? { session_id: prompt.sessionId } : {}),
    })) as { status?: string }
    return result.status === "ok" || result.status === "expired"
  }

  async respondToSecret(prompt: Extract<PendingPrompt, { kind: "secret" }>, value: string): Promise<boolean> {
    if (this.httpSelection) throw unsupportedHttpFallback("secret.respond")
    const result = (await this.request("secret.respond", {
      request_id: prompt.requestId,
      value,
      ...(prompt.sessionId ? { session_id: prompt.sessionId } : {}),
    })) as { status?: string }
    return result.status === "ok" || result.status === "expired"
  }

  private configureHttpCapabilities(
    _source: CapabilitySet,
    selection: HttpFallbackSelection,
  ): void {
    const advertisedModel = optionalString(selection.capabilities?.model)
    this.httpModels = advertisedModel
      ? [
          {
            id: advertisedModel,
            provider: "hermes-api",
            providerName: "Hermes API",
            current: true,
            authenticated: true,
          },
        ]
      : []
    this.currentCapabilities = {
      gateway: false,
      sessions: false,
      models: this.httpModels.length > 0,
      attachments: false,
      approvals: false,
      clarification: false,
      sudo: false,
      secrets: false,
      branch: false,
      compress: false,
      voice: false,
      httpFallback: true,
    }
  }

  private createHttpSession(input: SessionCreateInput): SessionSnapshot {
    const id = `http-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const messages: Message[] = (input.messages ?? []).map((message, index) => ({
      id: `${id}:seed:${index}`,
      role: message.role,
      content: contentToText(message.content),
      rawContent: message.content,
      timestamp: Date.now(),
    }))
    const currentModel = this.httpModels.find((model) => model.current) ?? this.httpModels[0]
    const session: HttpLocalSession = {
      identity: { storedId: id, runtimeId: id },
      messages,
      ...(input.model || currentModel?.id ? { model: input.model ?? currentModel?.id } : {}),
      ...(input.provider || currentModel?.provider
        ? { provider: input.provider ?? currentModel?.provider }
        : {}),
      ...(input.title ? { title: input.title } : {}),
    }
    this.httpSessions.set(id, session)
    return this.httpSnapshot(session)
  }

  private httpSnapshot(session: HttpLocalSession): SessionSnapshot {
    const running = this.httpAborts.has(session.identity.runtimeId)
    return {
      identity: { ...session.identity },
      messages: session.messages.map((message) => ({ ...message })),
      messageCount: session.messages.length,
      info: {
        ...(session.title ? { title: session.title } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.provider ? { provider: session.provider } : {}),
        running,
      },
      running,
    }
  }

  private requireHttpSession(session: SessionIdentity | string): HttpLocalSession {
    const id = runtimeId(session)
    const local = this.httpSessions.get(id)
    if (!local) throw new Error("HTTP fallback conversation is no longer available in this page")
    return local
  }

  private abortHttpSession(id: string): void {
    const controller = this.httpAborts.get(id)
    if (!controller) return
    controller.abort()
    this.httpAborts.delete(id)
  }

  private async sendHttpPrompt(session: SessionIdentity | string, text: string): Promise<void> {
    const selection = this.httpSelection
    if (!selection) throw new Error("Hermes HTTP fallback is not connected")
    const local = this.requireHttpSession(session)
    const sessionId = local.identity.runtimeId
    if (this.httpAborts.has(sessionId)) throw new Error("A Hermes HTTP fallback response is already running")

    const now = Date.now()
    local.messages.push({
      id: `${sessionId}:user:${now}`,
      role: "user",
      content: text,
      rawContent: text,
      timestamp: now,
    })

    const controller = new AbortController()
    this.httpAborts.set(sessionId, controller)
    this.emitHttpEvent("message.start", sessionId, { message_id: `${sessionId}:assistant:${now}` })

    let streamedText = ""
    let completedText = ""
    let responseId: string | undefined
    let runId: string | undefined
    let forcedError: Error | undefined
    const seenStreamEvents = new Set<string>()
    const compatibleMessages = local.messages
      .filter((message): message is Message & { role: "assistant" | "system" | "user" } =>
        message.role === "assistant" || message.role === "system" || message.role === "user")
      .map((message) => ({ role: message.role, content: message.content }))

    const onEvent = (event: HttpStreamEvent) => {
      const semanticKey = event.id ? `${event.id}:${event.type}` : undefined
      if (semanticKey && seenStreamEvents.has(semanticKey)) return
      if (semanticKey) seenStreamEvents.add(semanticKey)

      if (event.type === "text.delta") {
        streamedText += event.text
        this.emitHttpEvent("message.delta", sessionId, { text: event.text, sse_id: event.id }, event.id)
        return
      }
      if (event.type === "response.complete") {
        completedText = event.text
        responseId = event.responseId
        return
      }
      if (event.type === "error") {
        forcedError = new Error(event.message)
        controller.abort()
        return
      }
      if (event.type === "raw" && event.event && HTTP_INTERACTIVE_EVENT_NAMES.has(event.event)) {
        forcedError = new Error("Interactive Hermes prompts are unavailable in HTTP fallback mode")
        controller.abort()
      }
    }

    try {
      await streamHttpFallback(
        selection,
        {
          text,
          ...(local.model ? { model: local.model } : {}),
          ...(local.previousResponseId ? { previousResponseId: local.previousResponseId } : {}),
          messages: compatibleMessages,
          sessionId,
        },
        onEvent,
        {
          signal: controller.signal,
          fetch: this.fetchImpl,
          onRunId: (value) => {
            runId = value
          },
        },
      )
      if (forcedError) throw forcedError

      const fullText = completedText || streamedText
      const completedAt = Date.now()
      local.messages.push({
        id: `${sessionId}:assistant:${completedAt}`,
        role: "assistant",
        content: fullText,
        rawContent: fullText,
        timestamp: completedAt,
      })
      if (responseId) local.previousResponseId = responseId
      this.emitHttpEvent("message.complete", sessionId, {
        text: fullText,
        status: "complete",
        ...(responseId ? { response_id: responseId } : {}),
        ...(runId ? { run_id: runId } : {}),
      })
    } catch (error) {
      if (forcedError) {
        this.emitHttpEvent("error", sessionId, { message: forcedError.message, ...(runId ? { run_id: runId } : {}) })
        throw forcedError
      }
      if (controller.signal.aborted) {
        if (streamedText) {
          const interruptedAt = Date.now()
          local.messages.push({
            id: `${sessionId}:assistant:${interruptedAt}`,
            role: "assistant",
            content: streamedText,
            rawContent: streamedText,
            timestamp: interruptedAt,
          })
        }
        this.emitHttpEvent("message.complete", sessionId, {
          text: streamedText,
          status: "interrupted",
          ...(runId ? { run_id: runId } : {}),
        })
        return
      }
      const failure = error instanceof Error ? error : new Error(String(error))
      this.emitHttpEvent("error", sessionId, { message: failure.message, ...(runId ? { run_id: runId } : {}) })
      throw failure
    } finally {
      if (this.httpAborts.get(sessionId) === controller) this.httpAborts.delete(sessionId)
    }
  }

  private emitHttpEvent(
    type: HermesEvent["type"],
    sessionId: string,
    payload?: unknown,
    semanticId?: string,
  ): void {
    const id = semanticId
      ? `${this.connectionEpoch}:${sessionId}:${type}:${semanticId}`
      : `${this.connectionEpoch}:${sessionId}:${type}:${++this.eventSequence}`
    if (this.seenEvents.has(id)) return
    this.seenEvents.add(id)
    if (this.seenEvents.size > MAX_SEEN_EVENTS) {
      const oldest = this.seenEvents.values().next().value
      if (oldest) this.seenEvents.delete(oldest)
    }
    const event: HermesEvent = {
      id,
      type,
      sessionId,
      ...(payload === undefined ? {} : { payload }),
      connectionEpoch: this.connectionEpoch,
      receivedAt: Date.now(),
    }
    for (const listener of this.eventListeners) listener(event)
  }

  private async mutateProfileSession(
    storedSessionId: string,
    profile: string,
    method: "DELETE" | "PATCH",
    payload?: { title: string },
  ): Promise<void> {
    const separator = this.sessionsPath.includes("?") ? "&" : "?"
    const path = `${this.sessionsPath.replace(/\/+$/, "")}/${encodeURIComponent(storedSessionId)}`
    const response = await this.fetchImpl(`${path}${separator}${new URLSearchParams({ profile })}`, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(readBffError(body, `Could not ${method === "DELETE" ? "delete" : "rename"} Hermes session`))
    }
    if (!body || typeof body !== "object" || (body as Record<string, unknown>).ok !== true) {
      throw new Error("Hermes profile session mutation response is incompatible")
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState("error")
      return
    }
    this.reconnectAttempts += 1
    this.setState("reconnecting")
    const delay = Math.min(4_000, 250 * 2 ** (this.reconnectAttempts - 1))
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      if (this.explicitDisconnect || !this.wsUrl) return
      this.connectionEpoch += 1
      void this.client.connect(this.wsUrl).then(
        () => {
          this.reconnectAttempts = 0
          this.setState("open")
        },
        () => this.scheduleReconnect(),
      )
    }, delay)
  }

  private disableCapabilityForMethod(method: string): void {
    const capability = capabilityForMethod(method)
    if (!capability || !this.currentCapabilities[capability]) return
    this.currentCapabilities = { ...this.currentCapabilities, [capability]: false }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }
}

export function createHermesTransport(options?: CreateHermesTransportOptions): HermesTransport {
  return new BrowserHermesTransport(options)
}

function runtimeId(session: SessionIdentity | string): string {
  return typeof session === "string" ? session : session.runtimeId
}

function storedId(session: SessionIdentity | string): string {
  return typeof session === "string" ? session : session.storedId
}

function sameOriginWebSocketUrl(path: string): string {
  if (typeof window === "undefined") throw new Error("Hermes transport can only connect in a browser")
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.username = ""
  url.password = ""
  return url.toString()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function requireProfileName(value: string): string {
  const profile = value.trim()
  if (!PROFILE_NAME_PATTERN.test(profile) || profile === "all") {
    throw new Error("A concrete Hermes profile is required to list sessions")
  }
  return profile
}

function filterSessions(sessions: SessionSummary[], rawQuery: string | undefined): SessionSummary[] {
  const query = rawQuery?.trim().toLocaleLowerCase()
  if (!query) return sessions
  return sessions.filter((session) =>
    `${session.title ?? ""}\n${session.preview ?? ""}`.toLocaleLowerCase().includes(query),
  )
}

function readBffError(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string") {
    return (body as Record<string, string>).error
  }
  return fallback
}

function unsupportedHttpFallback(method: string): Error {
  return new Error(`Hermes ${method} is unavailable in HTTP fallback mode`)
}

function assertGatewayContract(snapshot: SessionSnapshot): void {
  const contract = snapshot.info?.contract
  if (typeof contract !== "number" || contract < HERMES_MIN_GATEWAY_CONTRACT) {
    throw new Error(
      `Hermes gateway protocol is incompatible: requires desktop contract >=${HERMES_MIN_GATEWAY_CONTRACT}, received ${String(contract ?? "missing")}`,
    )
  }
}

function defaultCapabilities(): CapabilitySet {
  return {
    gateway: true,
    sessions: true,
    models: true,
    attachments: true,
    approvals: true,
    clarification: true,
    sudo: true,
    secrets: true,
    branch: true,
    compress: true,
    voice: false,
    httpFallback: false,
  }
}

function capabilityForMethod(method: string): keyof CapabilitySet | null {
  if (method === "model.options" || method === "config.set") return "models"
  if (method.startsWith("image.") || method.startsWith("file.") || method.startsWith("pdf.")) return "attachments"
  if (method.startsWith("approval.")) return "approvals"
  if (method.startsWith("clarify.")) return "clarification"
  if (method.startsWith("sudo.")) return "sudo"
  if (method.startsWith("secret.")) return "secrets"
  if (method === "session.branch") return "branch"
  if (method === "session.compress") return "compress"
  if (method.startsWith("session.") || method.startsWith("prompt.")) return "sessions"
  return null
}
