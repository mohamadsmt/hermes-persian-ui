export const HERMES_DESKTOP_CONTRACT = 2 as const
/** Minimum upstream TUI gateway contract; newer monotonic contracts are additive. */
export const HERMES_MIN_GATEWAY_CONTRACT = 2 as const

export type BackendMode = "managed" | "external" | "test"
export type BackendState = "starting" | "ready" | "restarting" | "error" | "stopped"
export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error"

export interface CapabilitySet {
  gateway: boolean
  sessions: boolean
  models: boolean
  attachments: boolean
  approvals: boolean
  clarification: boolean
  sudo: boolean
  secrets: boolean
  branch: boolean
  compress: boolean
  voice: boolean
  httpFallback: boolean
}

export interface BootstrapInfo {
  mode: BackendMode
  state: BackendState
  ready: boolean
  contract: typeof HERMES_DESKTOP_CONTRACT
  wsPath: string
  profile: string | null
  capabilities: CapabilitySet
  backend?: {
    version?: string
    releaseDate?: string
  }
  error?: string
}

/** Durable navigation uses storedId; live RPC calls use runtimeId. */
export interface SessionIdentity {
  storedId: string
  runtimeId: string
  lineageRootId?: string
}

export type MessageRole = "assistant" | "system" | "tool" | "user"

export interface Message {
  id: string
  role: MessageRole
  content: string
  rawContent?: unknown
  timestamp?: number
  reasoning?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: unknown
}

/** Canonical result of a profile-scoped persisted transcript read. */
export interface SessionMessageHistory {
  /** Hermes may resolve a stored id to its latest resume/continuation id. */
  sessionId: string
  /** Messages remain in the exact order returned by the Hermes session DB. */
  messages: Message[]
}

export interface SessionRuntimeInfo {
  branch?: string
  configWarning?: string
  credentialWarning?: string
  cwd?: string
  contract?: number
  fast?: boolean
  installWarning?: string
  model?: string
  personality?: string
  profileName?: string
  provider?: string
  reasoningEffort?: string
  running?: boolean
  serviceTier?: string
  title?: string
  usage?: UsageStats
  version?: string
  yolo?: boolean
}

export interface SessionSnapshot {
  identity: SessionIdentity
  messages: Message[]
  messageCount: number
  info?: SessionRuntimeInfo
  inflight?: {
    user: string
    assistant: string
    streaming: boolean
  } | null
  running?: boolean
  status?: string
}

export interface SessionSummary {
  id: string
  lineageRootId?: string
  parentSessionId?: string
  title?: string
  preview?: string
  model?: string
  source?: string
  cwd?: string
  profile?: string
  archived: boolean
  active: boolean
  startedAt: number
  lastActive: number
  messageCount: number
  inputTokens: number
  outputTokens: number
  toolCallCount: number
}

export interface UsageStats {
  calls: number
  contextMax?: number
  contextPercent?: number
  contextUsed?: number
  costUsd?: number
  input: number
  output: number
  total: number
}

export interface ModelOption {
  id: string
  provider: string
  providerName: string
  current: boolean
  authenticated: boolean
  warning?: string
  supportsFast?: boolean
  supportsReasoning?: boolean
  pricing?: {
    input: string
    output: string
    cache?: string | null
    free?: boolean
  }
}

export interface Attachment {
  id: string
  kind: "file" | "image" | "pdf"
  name: string
  mimeType: string
  size: number
  path?: string
  refText?: string
  previewUrl?: string
  status: "pending" | "attached" | "failed"
  error?: string
}

export interface AttachmentInput {
  kind: Attachment["kind"]
  name: string
  mimeType: string
  size: number
  /** A base64 data URL. It is sent directly to Hermes and never persisted by this client. */
  dataUrl: string
  path?: string
}

export interface ToolActivity {
  id: string
  sessionId?: string
  name: string
  status: "running" | "complete" | "failed"
  context?: string
  args?: unknown
  output?: unknown
  rawOutput?: string
  summary?: string
  inlineDiff?: string
  progress?: string
  durationSeconds?: number
}

interface PromptBase {
  sessionId?: string
  expiresAt?: number
}

export type PendingPrompt =
  | (PromptBase & {
      kind: "approval"
      requestId?: string
      command?: string
      description?: string
      allowPermanent: boolean
    })
  | (PromptBase & {
      kind: "clarification"
      requestId: string
      question: string
      choices: string[]
    })
  | (PromptBase & {
      kind: "sudo"
      requestId: string
    })
  | (PromptBase & {
      kind: "secret"
      requestId: string
      name?: string
      prompt?: string
    })

export type HermesEventName =
  | "gateway.ready"
  | "session.info"
  | "session.title"
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "thinking.delta"
  | "reasoning.delta"
  | "reasoning.available"
  | "status.update"
  | "tool.start"
  | "tool.progress"
  | "tool.complete"
  | "tool.generating"
  | "clarify.request"
  | "approval.request"
  | "sudo.request"
  | "secret.request"
  | "background.complete"
  | "error"
  | (string & {})

export interface HermesEvent<T = unknown> {
  id: string
  type: HermesEventName
  sessionId?: string
  payload?: T
  connectionEpoch: number
  receivedAt: number
}

export interface SessionCreateInput {
  cwd?: string
  title?: string
  profile?: string
  model?: string
  provider?: string
  reasoningEffort?: string
  fast?: boolean
  parentSessionId?: string
  messages?: Array<{ role: MessageRole; content: unknown }>
}

export interface SessionListOptions {
  /**
   * The owning Hermes profile. Session discovery is deliberately fail-closed:
   * callers must choose a profile instead of treating untagged rows as shared.
   */
  profile: string
  limit?: number
  query?: string
}

export interface SessionResumeOptions {
  profile?: string
  lazy?: boolean
}

export interface SendOptions {
  /** Queue and interrupt is Hermes' safe default for a send during an active turn. */
  busyMode?: "interrupt" | "steer" | "reject"
  truncateBeforeUserOrdinal?: number
}

export interface CommandResult {
  output: string
  warning?: string
}

export interface HermesTransport {
  readonly connectionState: ConnectionState
  readonly capabilities: CapabilitySet

  connect(): Promise<BootstrapInfo>
  disconnect(): void
  onEvent(listener: (event: HermesEvent) => void): () => void
  onConnectionState(listener: (state: ConnectionState) => void): () => void

  sessionCreate(input?: SessionCreateInput): Promise<SessionSnapshot>
  sessionList(options: SessionListOptions): Promise<SessionSummary[]>
  sessionResume(storedId: string, options?: SessionResumeOptions): Promise<SessionSnapshot>
  sessionMessages(storedId: string, profile: string): Promise<SessionMessageHistory>
  sessionHistory(session: SessionIdentity | string): Promise<Message[]>
  sessionRename(session: SessionIdentity | string, title: string, profile: string): Promise<void>
  sessionDelete(storedId: string, profile: string): Promise<void>
  sessionClose(session: SessionIdentity | string): Promise<void>
  sessionBranch(session: SessionIdentity | string, name?: string): Promise<SessionSnapshot>
  sessionCompress(session: SessionIdentity | string, focusTopic?: string): Promise<Message[]>
  sessionUsage(session: SessionIdentity | string): Promise<UsageStats>

  send(session: SessionIdentity | string, text: string, options?: SendOptions): Promise<void>
  stop(session: SessionIdentity | string): Promise<void>
  steer(session: SessionIdentity | string, text: string): Promise<boolean>
  models(session?: SessionIdentity | string): Promise<ModelOption[]>
  setModel(session: SessionIdentity | string, model: string, provider?: string): Promise<void>
  attach(session: SessionIdentity | string, input: AttachmentInput): Promise<Attachment>
  command(session: SessionIdentity | string, command: string): Promise<CommandResult>

  respondToClarification(prompt: Extract<PendingPrompt, { kind: "clarification" }>, answer: string): Promise<boolean>
  respondToApproval(prompt: Extract<PendingPrompt, { kind: "approval" }>, choice: "once" | "always" | "deny"): Promise<boolean>
  respondToSudo(prompt: Extract<PendingPrompt, { kind: "sudo" }>, password: string): Promise<boolean>
  respondToSecret(prompt: Extract<PendingPrompt, { kind: "secret" }>, value: string): Promise<boolean>

  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>
}
