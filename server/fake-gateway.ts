import type { IncomingMessage } from "node:http"
import type { WebSocket } from "ws"

import type { TestGatewayAdapter } from "./ws-relay.js"

const FIXED_TIME = 1_783_908_000
const DEFAULT_MODEL = "gpt-5.6-sol"
const DEFAULT_PROVIDER = "openai-codex"
const TEST_CLIENT_COOKIE = "hermes-e2e-client"

type FakeCommandPair = readonly [command: string, description: string]

const FAKE_COMMAND_CATEGORIES: ReadonlyArray<{
  name: string
  pairs: readonly FakeCommandPair[]
}> = [
  {
    name: "Session",
    pairs: [
      ["/new", "Start a new session"],
      ["/clear", "Clear the current conversation by starting a new session"],
      ["/undo", "Undo the latest turn and return its prompt to the composer"],
      ["/title", "Show or change the session title"],
      ["/branch", "Branch the current session"],
      ["/queue", "Queue a prompt for this session"],
      ["/steer", "Steer the currently running turn"],
      ["/sessions", "Browse saved sessions"],
      ["/journey", "Open the Hermes knowledge journey"],
      ["/redraw", "Redraw the terminal interface"],
      ["/prompt", "Open the terminal prompt editor"],
      ["/handoff", "Hand off this session in the terminal"],
    ],
  },
  {
    name: "Info",
    pairs: [
      ["/help", "Show all available Hermes commands"],
      ["/version", "Show the Hermes version"],
      ["/copy", "Copy an assistant response"],
      ["/paste", "Paste from the terminal clipboard"],
      ["/image", "Attach an image from a terminal path"],
      ["/update", "Update Hermes from the terminal"],
    ],
  },
  {
    name: "Configuration",
    pairs: [
      ["/model", "Show or change the session model"],
      ["/profile", "Show or switch profile workspace"],
      ["/reasoning", "Show or change reasoning effort"],
      ["/yolo", "Show or change session YOLO mode"],
      ["/skin", "Change the terminal skin"],
    ],
  },
  {
    name: "Tools & Skills",
    pairs: [
      ["/skills", "Manage installed skills"],
      ["/memory", "Manage Hermes memory"],
      ["/pet", "Manage the terminal companion"],
    ],
  },
  {
    name: "User commands",
    pairs: [
      ["/alias-test", "Test quick-command alias resolution"],
      ["/fallback-test", "Test slash.exec fallback to command.dispatch"],
      ["/plugin-test", "Test structured plugin command output"],
      ["/send-test", "Test a command that generates a prompt"],
      ["/warn", "Test command output with a warning"],
    ],
  },
  {
    name: "TUI",
    pairs: [
      ["/logs", "Show recent gateway log lines"],
      ["/mouse", "Configure terminal mouse tracking"],
      ["/quit", "Quit the terminal application"],
    ],
  },
]

// Skills intentionally remain outside categories, matching the live gateway.
// The web client uses this distinction to place dynamic skills in its own group.
const FAKE_DYNAMIC_SKILLS: readonly FakeCommandPair[] = [
  ["/skill-test", "Dynamic test skill discovered by the Hermes gateway"],
]

const FAKE_COMMAND_PAIRS: readonly FakeCommandPair[] = [
  ...FAKE_COMMAND_CATEGORIES.flatMap((category) => category.pairs),
  ...FAKE_DYNAMIC_SKILLS,
]

const FAKE_COMMAND_CANON: Readonly<Record<string, string>> = {
  "/q": "/queue",
  "/reset": "/clear",
  "/fork": "/branch",
  "/resume": "/sessions",
  "/switch": "/sessions",
  "/commands": "/help",
  "/knowledge": "/journey",
  ...Object.fromEntries(FAKE_COMMAND_PAIRS.map(([command]) => [command.toLowerCase(), command])),
}

const FAKE_COMMAND_SUB: Readonly<Record<string, readonly string[]>> = {
  skills: ["list", "diff", "approve", "reject", "reload"],
  memory: ["list", "diff", "approve", "reject"],
  reasoning: ["auto", "off", "low", "medium", "high", "max"],
  yolo: ["on", "off", "status"],
}

const BIDI_MARKDOWN = [
  "امروز endpoint جدید /v1/responses را تست کردم و status برابر 200 بود.",
  "لطفاً فایل src/components/Chat.tsx را با React بررسی کن.",
  "برای اجرا از npm run build استفاده کن و نتیجه را در README.md بنویس.",
  "Use مدل claude-sonnet-4.6 برای این task و پاسخ را فارسی بنویس.",
  "قیمت برابر $1,250 است (با 20% تخفیف).",
  "خطای TypeError: Cannot read properties of undefined در تابع getSession رخ داده است.",
  "- فایل `src/components/Chat.tsx` را بررسی کن.\n- سپس `README.md` را به‌روزرسانی کن.",
  "این پاراگراف فارسی است و جهت آن باید راست‌به‌چپ باشد.\n\nThis English paragraph must remain left-to-right, even after Persian prose.",
  "[مستندات Hermes](https://hermes.nousresearch.com/docs)",
  "پیش از اجرا، endpoint را بررسی کن.\n\n```ts\nconst endpoint = \"/v1/responses\";\nconsole.log(endpoint);\n```\n\nپس از اجرا، نتیجه را به فارسی توضیح بده.",
].join("\n\n---\n\n")

interface FakeMessage {
  role: "assistant" | "system" | "tool" | "user"
  content: string
  timestamp: number
  reasoning?: string
  tool_call_id?: string
  tool_name?: string
  tool_calls?: unknown
}

interface FakeSession {
  storedId: string
  runtimeId: string
  title: string
  messages: FakeMessage[]
  model: string
  provider: string
  reasoningEffort: string
  running: boolean
  active: boolean
  createdAt: number
  attachmentCount: number
  abort?: AbortController
  pendingApproval?: { resolve(choice: string): void }
  inflightUser?: string
  inflightAssistant?: string
}

interface RpcRequest {
  id?: number | string | null
  jsonrpc?: string
  method?: string
  params?: Record<string, unknown>
}

function findLastUserMessageIndex(messages: FakeMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

export class FakeHermesGatewayState {
  readonly sessionsByRuntime = new Map<string, FakeSession>()
  readonly sessionsByStored = new Map<string, FakeSession>()
  readonly sockets = new Set<WebSocket>()
  sessionSequence = 0
  branchSequence = 0
  messageSequence = 0
  failNextCreate = false
  failNextActivateRuntimeId?: string
}

/** Source-only deterministic adapter injected by dev and smoke entrypoints. */
export class FakeHermesGatewayAdapter implements TestGatewayAdapter {
  private readonly states = new Map<string, FakeHermesGatewayState>()

  handle(browser: WebSocket, request: IncomingMessage): void {
    const clientId = readCookie(request.headers.cookie, TEST_CLIENT_COOKIE)
    const state = clientId
      ? this.states.get(clientId) ?? new FakeHermesGatewayState()
      : new FakeHermesGatewayState()
    if (clientId) this.states.set(clientId, state)
    new FakeHermesGateway(browser, state).start()
  }

  close(): void {
    for (const state of this.states.values()) {
      for (const session of state.sessionsByRuntime.values()) session.abort?.abort()
      for (const socket of state.sockets) socket.close(1001, "fake gateway shutdown")
      state.sockets.clear()
    }
    this.states.clear()
  }
}

export class FakeHermesGateway {
  constructor(
    private readonly socket: WebSocket,
    private readonly state = new FakeHermesGatewayState(),
  ) {}

  start(): void {
    this.state.sockets.add(this.socket)
    this.sendEvent(this.socket, "gateway.ready", undefined, { skin: null, desktop_contract: 4 })
    this.socket.on("message", (data) => this.handle(data.toString()))
    this.socket.on("close", () => {
      this.state.sockets.delete(this.socket)
    })
  }

  private handle(raw: string): void {
    let request: RpcRequest
    try {
      request = JSON.parse(raw) as RpcRequest
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      return
    }
    if (!request.method || request.id === undefined) {
      this.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32600, message: "invalid request" } })
      return
    }

    Promise.resolve(this.dispatch(request.method, request.params ?? {})).then(
      ({ result, after }) => {
        this.send({ jsonrpc: "2.0", id: request.id, result })
        after?.()
      },
      (error: unknown) => {
        const rpcError = error instanceof FakeRpcError ? error : new FakeRpcError(-32603, error instanceof Error ? error.message : String(error))
        this.send({ jsonrpc: "2.0", id: request.id, error: { code: rpcError.code, message: rpcError.message } })
      },
    )
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<{ result: unknown; after?: () => void }> {
    switch (method) {
      case "session.create": {
        if (this.state.failNextCreate) {
          this.state.failNextCreate = false
          throw new FakeRpcError(4090, "maximum concurrent sessions reached")
        }
        const session = this.createSession(params)
        return { result: this.snapshot(session, true) }
      }
      case "session.list": {
        const limit = numberValue(params.limit) ?? 100
        return { result: { sessions: [...this.state.sessionsByStored.values()].slice(0, limit).map((session) => this.summary(session)) } }
      }
      case "session.resume": {
        const storedId = stringValue(params.session_id)
        const session = this.state.sessionsByStored.get(storedId)
        if (!session) throw new FakeRpcError(4007, "session not found")
        session.active = true
        this.state.sessionsByRuntime.set(session.runtimeId, session)
        return { result: { ...this.snapshot(session), resumed: storedId, session_key: storedId } }
      }
      case "session.history": {
        const session = this.requireRuntimeSession(params)
        return { result: { count: session.messages.length, messages: session.messages } }
      }
      case "session.active_list": {
        const currentRuntimeId = stringValue(params.current_session_id)
        return {
          result: {
            sessions: [...this.state.sessionsByRuntime.values()].filter((session) => session.active).map((session) => ({
              id: session.runtimeId,
              session_key: session.storedId,
              current: session.runtimeId === currentRuntimeId,
              title: session.title,
              preview: session.messages.at(-1)?.content ?? session.inflightUser ?? "",
              model: session.model,
              message_count: session.messages.length,
              started_at: session.createdAt,
              last_active: session.createdAt + this.state.messageSequence,
              status: this.liveStatus(session),
            })),
          },
        }
      }
      case "session.activate": {
        const session = this.requireRuntimeSession(params)
        if (this.state.failNextActivateRuntimeId === session.runtimeId) {
          this.state.failNextActivateRuntimeId = undefined
          throw new FakeRpcError(4001, "runtime activation failed")
        }
        session.active = true
        return { result: this.snapshot(session) }
      }
      case "session.title": {
        const session = this.requireRuntimeSession(params)
        const title = stringValue(params.title)
        if (title) session.title = title
        this.emit("session.title", session.runtimeId, { session_id: session.storedId, title: session.title })
        return { result: { pending: false, title: session.title, session_key: session.storedId } }
      }
      case "session.close": {
        const session = this.requireRuntimeSession(params)
        session.active = false
        session.abort?.abort()
        this.state.sessionsByRuntime.delete(session.runtimeId)
        return { result: { closed: true } }
      }
      case "session.delete": {
        const id = stringValue(params.session_id)
        const session = this.state.sessionsByStored.get(id)
        if (!session) throw new FakeRpcError(4007, "session not found")
        if (session.active && this.state.sessionsByRuntime.has(session.runtimeId)) {
          throw new FakeRpcError(4009, "active session must be closed before deletion")
        }
        session.abort?.abort()
        this.state.sessionsByStored.delete(id)
        this.state.sessionsByRuntime.delete(session.runtimeId)
        return { result: { deleted: id } }
      }
      case "session.branch": {
        const parent = this.requireRuntimeSession(params)
        const session = this.createSession({
          title: stringValue(params.name) || `${parent.title} (branch ${++this.state.branchSequence})`,
          model: parent.model,
          provider: parent.provider,
          reasoning_effort: parent.reasoningEffort,
          messages: parent.messages,
        })
        return {
          result: {
            session_id: session.runtimeId,
            stored_session_id: session.storedId,
            title: session.title,
            parent: parent.storedId,
          },
        }
      }
      case "session.compress": {
        const session = this.requireRuntimeSession(params)
        const kept = session.messages.slice(-4)
        session.messages = kept
        this.emit("session.info", session.runtimeId, this.info(session))
        return { result: { status: "compressed", removed: 0, messages: kept, info: this.info(session) } }
      }
      case "session.usage": {
        const session = this.requireRuntimeSession(params)
        const calls = session.messages.filter((message) => message.role === "assistant").length
        return { result: { calls, input: calls * 12, output: calls * 18, total: calls * 30, context_max: 128_000 } }
      }
      case "session.context_breakdown": {
        this.requireRuntimeSession(params)
        return {
          result: {
            total: 2_048,
            context_max: 128_000,
            context_percent: 1.6,
            system_prompt: 512,
            history: 896,
            tools: 512,
            attachments: 64,
            other: 64,
          },
        }
      }
      case "session.interrupt": {
        const session = this.requireRuntimeSession(params)
        const wasRunning = session.running
        session.abort?.abort()
        session.abort = undefined
        session.running = false
        session.pendingApproval?.resolve("deny")
        session.pendingApproval = undefined
        session.inflightUser = undefined
        session.inflightAssistant = undefined
        if (wasRunning) {
          this.emit("message.complete", session.runtimeId, { text: "", status: "interrupted" })
          this.emit("session.info", session.runtimeId, this.info(session))
        }
        return { result: { status: "interrupted" } }
      }
      case "session.steer": {
        const session = this.requireRuntimeSession(params)
        return { result: { status: session.running ? "queued" : "rejected", text: stringValue(params.text) } }
      }
      case "prompt.submit": {
        const session = this.requireRuntimeSession(params)
        const text = stringValue(params.text)
        if (!text) throw new FakeRpcError(4002, "text is required")
        if (session.running) throw new FakeRpcError(4009, "session busy")
        if (params.truncate_before_user_ordinal !== undefined) {
          const ordinal = numberValue(params.truncate_before_user_ordinal)
          const userIndexes = session.messages.flatMap((message, index) => message.role === "user" ? [index] : [])
          if (ordinal === undefined || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= userIndexes.length) {
            throw new FakeRpcError(4018, "target user message is no longer in session history")
          }
          session.messages = session.messages.slice(0, userIndexes[ordinal])
        }
        session.running = true
        session.messages.push(this.message("user", text))
        session.inflightUser = text
        session.inflightAssistant = ""
        return { result: { status: "streaming" }, after: () => void this.runPrompt(session, text) }
      }
      case "model.options": {
        const requested = stringValue(params.session_id)
        const session = requested ? this.state.sessionsByRuntime.get(requested) : undefined
        return { result: modelOptions(session?.model ?? DEFAULT_MODEL, session?.provider ?? DEFAULT_PROVIDER) }
      }
      case "config.set": {
        const session = this.requireRuntimeSession(params)
        const key = stringValue(params.key)
        if (key === "model") {
          const value = stringValue(params.value)
          const parts = value.split(/\s+/)
          session.model = parts[0] || session.model
          const providerIndex = parts.indexOf("--provider")
          const provider = providerIndex >= 0 ? parts[providerIndex + 1] : undefined
          if (provider) session.provider = provider
          this.emit("session.info", session.runtimeId, this.info(session))
          return { result: { key, value: session.model, warning: "", confirm_required: false } }
        }
        if (key === "reasoning") {
          session.reasoningEffort = stringValue(params.value) || session.reasoningEffort
          this.emit("session.info", session.runtimeId, this.info(session))
          return { result: { key, value: session.reasoningEffort } }
        }
        return { result: { key, value: params.value } }
      }
      case "image.attach_bytes":
      case "pdf.attach":
      case "file.attach": {
        const session = this.requireRuntimeSession(params)
        session.attachmentCount += 1
        const name = stringValue(params.filename) || stringValue(params.name) || "attachment"
        return {
          result: {
            attached: true,
            name,
            path: `/test/attachments/${name}`,
            ref_text: `@file:${name}`,
            count: session.attachmentCount,
            pages_attached: method === "pdf.attach" ? 1 : undefined,
          },
        }
      }
      case "commands.catalog": {
        return {
          result: {
            pairs: FAKE_COMMAND_PAIRS.map(([command, description]) => [command, description]),
            categories: FAKE_COMMAND_CATEGORIES.map((category) => ({
              name: category.name,
              pairs: category.pairs.map(([command, description]) => [command, description]),
            })),
            canon: { ...FAKE_COMMAND_CANON },
            sub: Object.fromEntries(
              Object.entries(FAKE_COMMAND_SUB).map(([name, values]) => [name, [...values]]),
            ),
            skill_count: FAKE_DYNAMIC_SKILLS.length,
            warning: "",
          },
        }
      }
      case "complete.slash": {
        return { result: fakeSlashCompletions(stringValue(params.text)) }
      }
      case "slash.exec": {
        const session = this.requireRuntimeSession(params)
        const command = normalizeSlashCommand(stringValue(params.command) || "help")
        const [name = "", ...argParts] = command.split(/\s+/)
        const arg = argParts.join(" ")

        if ([
          "alias-loop-a",
          "alias-loop-b",
          "alias-test",
          "fallback-test",
          "plugin-test",
          "send-test",
          "skill-test",
        ].includes(name)) {
          throw new FakeRpcError(4018, `use command.dispatch for /${name}`)
        }

        if (name === "undo") return { result: this.undo(session) }

        const output = command === "skills diff skill-test"
          ? [
              "# Pending skill write skill-test:",
              "",
              "--- a/SKILL.md",
              "+++ b/SKILL.md",
              "@@",
              "-Review automation output.",
              "+Review automation output without exposing managed paths.",
            ].join("\n")
          : command === "skills approve skill-test"
            ? "Approved 1 skills write(s)."
            : command === "skills reject skill-test"
              ? "Rejected pending skills write 'skill-test'."
              : command === "memory approve memory-test"
                ? "Approved 1 memory write(s)."
                : command === "memory reject memory-test"
                  ? "Rejected pending memory write 'memory-test'."
                  : name === "help"
                    ? "Hermes commands: /help, /version, /skill-test, /undo"
                    : name === "version"
                      ? "Hermes Agent v0.18.2-test"
                      : `Executed /${command}`
        return {
          result: {
            output,
            ...(name === "warn" ? { warning: "Test warning from the Hermes gateway." } : {}),
            ...(arg === "warning" ? { warning: "Command completed with a test warning." } : {}),
          },
        }
      }
      case "command.dispatch": {
        const session = this.requireRuntimeSession(params)
        const name = normalizeSlashCommand(stringValue(params.name)).toLowerCase()
        const arg = stringValue(params.arg)
        if (name === "undo") return { result: this.undo(session) }
        if (name === "fallback-test") {
          return { result: { type: "exec", output: "Fallback through command.dispatch succeeded." } }
        }
        if (name === "plugin-test") {
          return { result: { type: "plugin", output: `Plugin fixture output${arg ? `: ${arg}` : "."}` } }
        }
        if (name === "send-test") {
          return {
            result: {
              type: "send",
              message: arg || "Generated prompt from the send-test command.",
              notice: "Generated a prompt from /send-test.",
            },
          }
        }
        if (name === "skill-test") {
          return {
            result: {
              type: "skill",
              name: "Test Skill",
              message: [
                "Use the dynamically discovered Test Skill.",
                arg ? `User request: ${arg}` : "User request: run the deterministic skill fixture.",
              ].join("\n"),
            },
          }
        }
        if (name === "alias-test") return { result: { type: "alias", target: "/version" } }
        if (name === "alias-loop-a") return { result: { type: "alias", target: "/alias-loop-b" } }
        if (name === "alias-loop-b") return { result: { type: "alias", target: "/alias-loop-a" } }
        throw new FakeRpcError(4018, "unsupported command")
      }
      case "rollback.list": {
        this.requireRuntimeSession(params)
        return {
          result: {
            enabled: true,
            checkpoints: [{ hash: "deadbeefcafefeed", timestamp: "2026-07-15T10:00:00Z", message: "Before last turn" }],
          },
        }
      }
      case "rollback.diff": {
        this.requireRuntimeSession(params)
        return { result: { stat: "1 file changed", diff: "--- a/example.txt\n+++ b/example.txt\n@@\n-before\n+after" } }
      }
      case "rollback.restore": {
        const session = this.requireRuntimeSession(params)
        if (session.running) throw new FakeRpcError(4009, "session busy")
        const userIndex = findLastUserMessageIndex(session.messages)
        if (userIndex >= 0) session.messages = session.messages.slice(0, userIndex)
        return { result: { success: true, history_removed: userIndex >= 0 ? 2 : 0, history_synced: true } }
      }
      case "process.list": {
        this.requireRuntimeSession(params)
        return { result: { processes: [] } }
      }
      case "delegation.status": {
        return { result: { active: [], paused: false, max_spawn_depth: 3, max_concurrent_children: 4 } }
      }
      case "verification.status": {
        return {
          result: {
            verification: {
              status: "passed",
              command: "pnpm test",
              canonical_command: "pnpm test",
              scope: "full",
              exit_code: 0,
              timestamp: "2026-07-15T10:00:00Z",
              root: "/test/workspace",
              output_summary: "80 tests passed",
            },
          },
        }
      }
      case "projects.tree": {
        const previewSessions = [...this.state.sessionsByStored.values()]
          .slice(0, 3)
          .map((session) => this.summary(session))
        return {
          result: {
            active_id: "project-test",
            scoped_session_ids: [...this.state.sessionsByStored.keys()],
            projects: [{
              id: "project-test",
              name: "Hermes UI",
              primary_path: "/test/workspace",
              paths: ["/test/workspace"],
              repositories: [{ name: "Hermes UI", root: "/test/workspace", lanes: [] }],
              previewSessions,
            }],
          },
        }
      }
      case "projects.project_sessions": {
        return { result: { sessions: [...this.state.sessionsByStored.values()].map((session) => this.summary(session)) } }
      }
      case "approval.respond": {
        const session = this.requireRuntimeSession(params)
        const pending = session.pendingApproval
        if (!pending) return { result: { resolved: false } }
        session.pendingApproval = undefined
        pending.resolve(stringValue(params.choice) || "deny")
        return { result: { resolved: true } }
      }
      case "clarify.respond":
      case "sudo.respond":
      case "secret.respond": {
        return { result: { status: "ok" } }
      }
      case "test.fail_next": {
        const operation = stringValue(params.operation)
        if (operation === "create") this.state.failNextCreate = true
        else if (operation === "activate") {
          const runtimeId = stringValue(params.session_id)
          if (!runtimeId) throw new FakeRpcError(4002, "session_id is required")
          this.state.failNextActivateRuntimeId = runtimeId
        } else {
          throw new FakeRpcError(4002, "unsupported test operation")
        }
        return { result: { configured: operation } }
      }
      case "test.disconnect_all": {
        return {
          result: { disconnected: this.state.sockets.size },
          after: () => {
            for (const socket of this.state.sockets) socket.close(1012, "deterministic reconnect test")
          },
        }
      }
      default:
        throw new FakeRpcError(-32601, `method not found: ${method}`)
    }
  }

  private createSession(params: Record<string, unknown>): FakeSession {
    const sequence = ++this.state.sessionSequence
    const storedId = `session-${String(sequence).padStart(3, "0")}`
    const runtimeId = `runtime-${String(sequence).padStart(3, "0")}`
    const seed = Array.isArray(params.messages)
      ? params.messages.map((item) => {
          const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
          const role = ["assistant", "system", "tool", "user"].includes(String(value.role))
            ? (String(value.role) as FakeMessage["role"])
            : "user"
          return this.message(role, String(value.content ?? ""), {
            ...(typeof value.reasoning === "string" ? { reasoning: value.reasoning } : {}),
            ...(typeof value.tool_call_id === "string" ? { tool_call_id: value.tool_call_id } : {}),
            ...(typeof value.tool_name === "string" ? { tool_name: value.tool_name } : {}),
            ...(value.tool_calls === undefined ? {} : { tool_calls: value.tool_calls }),
          })
        })
      : []
    const session: FakeSession = {
      storedId,
      runtimeId,
      title: stringValue(params.title) || `گفت‌وگوی ${sequence}`,
      messages: seed,
      model: stringValue(params.model) || DEFAULT_MODEL,
      provider: stringValue(params.provider) || DEFAULT_PROVIDER,
      reasoningEffort: stringValue(params.reasoning_effort) || "ultra",
      running: false,
      active: true,
      createdAt: FIXED_TIME + sequence,
      attachmentCount: 0,
    }
    this.state.sessionsByStored.set(storedId, session)
    this.state.sessionsByRuntime.set(runtimeId, session)
    queueMicrotask(() => this.emit("session.info", runtimeId, this.info(session)))
    return session
  }

  private async runPrompt(session: FakeSession, prompt: string): Promise<void> {
    const abort = new AbortController()
    session.abort = abort
    this.emit("message.start", session.runtimeId, {})
    this.emit("status.update", session.runtimeId, { kind: "thinking", text: "در حال فکر…" })
    try {
      if (prompt.includes("__TEST__:timeline-overflow")) {
        const failedToolId = "tool-timeline-failed-001"
        const completeToolId = "tool-timeline-complete-002"
        const longPath = `/Users/test/${"nested-directory-".repeat(120)}result.json`
        const failedResult = {
          success: false,
          error: "agent not found",
          path: longPath,
        }
        const completeResult = {
          success: true,
          output: "raw string output",
        }

        this.emit("thinking.delta", session.runtimeId, {
          text: "INTERNAL_THINKING_MUST_NOT_RENDER",
        })
        this.emit("reasoning.delta", session.runtimeId, { text: "بررسی ناقص اول" })
        this.emit("reasoning.available", session.runtimeId, { text: "بررسی نهایی اول" })
        session.messages.push(this.message("assistant", "", {
          reasoning: "بررسی نهایی اول",
          tool_calls: [{
            id: failedToolId,
            type: "function",
            function: { name: "agency_agents_inspect", arguments: "{}" },
          }],
        }))
        this.emit("tool.start", session.runtimeId, {
          tool_id: failedToolId,
          name: "agency_agents_inspect",
          args_text: "{}",
        })
        await delay(30, abort.signal)
        this.emit("tool.complete", session.runtimeId, {
          tool_id: failedToolId,
          name: "agency_agents_inspect",
          result: failedResult,
        })
        session.messages.push(this.message("tool", JSON.stringify(failedResult), {
          tool_call_id: failedToolId,
          tool_name: "agency_agents_inspect",
        }))

        this.emit("reasoning.delta", session.runtimeId, { text: "بررسی دوم" })
        session.messages.push(this.message("assistant", "", {
          reasoning: "بررسی دوم",
          tool_calls: [{
            id: completeToolId,
            type: "function",
            function: {
              name: "agency_agents_search",
              arguments: '{"query":"Hermes timeline"}',
            },
          }],
        }))
        this.emit("tool.start", session.runtimeId, {
          tool_id: completeToolId,
          name: "agency_agents_search",
          args_text: '{"query":"Hermes timeline"}',
        })
        await delay(30, abort.signal)
        this.emit("tool.progress", session.runtimeId, {
          tool_id: completeToolId,
          name: "agency_agents_search",
          preview: "42%",
        })
        this.emit("tool.complete", session.runtimeId, {
          tool_id: completeToolId,
          name: "agency_agents_search",
          result: completeResult,
        })
        session.messages.push(this.message("tool", JSON.stringify(completeResult), {
          tool_call_id: completeToolId,
          tool_name: "agency_agents_search",
        }))
        const finalAnswer = [
          "پاسخ نهایی timeline",
          ...Array.from({ length: 18 }, (_, index) => `- بند نتیجه ${index + 1}`),
        ].join("\n")
        await this.streamAnswer(session, finalAnswer, abort.signal)
      } else if (prompt.includes("__TEST__:tool-running-artifact")) {
        const toolId = "tool-running-artifact-fixed-001"
        this.emit("tool.start", session.runtimeId, {
          tool_id: toolId,
          name: "terminal",
          context: "pnpm typecheck",
          artifact: {
            id: "artifact-fixed-001",
            title: "report.ts",
            kind: "code",
            language: "typescript",
            content: "export const status = {\n  phase: \"running\",\n  progress: 42,\n};",
          },
        })
        await delay(40, abort.signal)
        this.emit("tool.progress", session.runtimeId, {
          tool_id: toolId,
          name: "terminal",
          text: "42%",
        })
        // Keep this deterministic visual state alive long enough for the
        // screenshot assertion. The test stops the run after capturing it.
        await delay(15_000, abort.signal)
        this.emit("tool.complete", session.runtimeId, {
          tool_id: toolId,
          name: "terminal",
          result: "Typecheck completed",
          summary: "بررسی نوع‌ها کامل شد",
          duration_s: 15,
        })
        await this.streamAnswer(session, "بررسی نوع‌ها کامل شد.", abort.signal)
      } else if (prompt.includes("__TEST__:tool")) {
        const toolId = "tool-fixed-001"
        this.emit("tool.start", session.runtimeId, { tool_id: toolId, name: "terminal", context: "pnpm test" })
        await delay(40, abort.signal)
        this.emit("tool.progress", session.runtimeId, { tool_id: toolId, name: "terminal", text: "۵۰٪" })
        await delay(40, abort.signal)
        this.emit("tool.complete", session.runtimeId, {
          tool_id: toolId,
          name: "terminal",
          args: { command: "pnpm test" },
          result: "All tests passed",
          summary: "آزمون‌ها با موفقیت اجرا شدند",
          duration_s: 0.08,
        })
        await this.streamAnswer(session, "ابزار با موفقیت اجرا شد.", abort.signal)
      } else if (prompt.includes("__TEST__:approval")) {
        const choice = await new Promise<string>((resolve) => {
          session.pendingApproval = { resolve }
          this.emit("approval.request", session.runtimeId, {
            command: "pnpm test",
            description: "اجرای فرمان آزمایشی",
            allow_permanent: true,
          })
          abort.signal.addEventListener("abort", () => resolve("deny"), { once: true })
        })
        if (abort.signal.aborted) return
        await this.streamAnswer(
          session,
          choice === "deny" ? "درخواست اجرا رد شد." : "درخواست اجرا تأیید شد.",
          abort.signal,
        )
      } else if (prompt.includes("__TEST__:slow")) {
        for (const token of ["این ", "یک ", "پاسخ ", "آهسته ", "و ", "قابل توقف ", "است."]) {
          await delay(350, abort.signal)
          this.emit("message.delta", session.runtimeId, { text: token })
        }
        await this.complete(session, "این یک پاسخ آهسته و قابل توقف است.")
      } else if (prompt.includes("__TEST__:bidi")) {
        await this.streamAnswer(session, BIDI_MARKDOWN, abort.signal, 600)
      } else if (prompt.includes("__TEST__:attachment")) {
        const count = session.attachmentCount
        await this.streamAnswer(session, `${count} پیوست دریافت شد.`, abort.signal)
      } else {
        await this.streamAnswer(session, "سلام! Hermes آمادهٔ کمک است.", abort.signal)
      }
    } catch (error) {
      if (!abort.signal.aborted) this.emit("error", session.runtimeId, { message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (session.abort === abort) session.abort = undefined
      if (!abort.signal.aborted) {
        session.running = false
        session.inflightUser = undefined
        session.inflightAssistant = undefined
        this.emit("session.info", session.runtimeId, this.info(session))
      }
    }
  }

  private async streamAnswer(session: FakeSession, text: string, signal: AbortSignal, chunkSize = 7): Promise<void> {
    for (let index = 0; index < text.length; index += chunkSize) {
      await delay(12, signal)
      this.emit("message.delta", session.runtimeId, { text: text.slice(index, index + chunkSize) })
    }
    await this.complete(session, text)
  }

  private async complete(session: FakeSession, text: string): Promise<void> {
    session.messages.push(this.message("assistant", text))
    session.running = false
    session.inflightUser = undefined
    session.inflightAssistant = undefined
    this.emit("message.complete", session.runtimeId, {
      text,
      status: "complete",
      usage: { calls: 1, input: 12, output: 18, total: 30, context_max: 128_000 },
    })
  }

  private snapshot(session: FakeSession, created = false) {
    return {
      session_id: session.runtimeId,
      stored_session_id: session.storedId,
      session_key: session.storedId,
      message_count: session.messages.length,
      messages: session.messages,
      info: this.info(session),
      running: session.running,
      status: this.liveStatus(session),
      ...(session.inflightUser === undefined && session.inflightAssistant === undefined
        ? {}
        : {
            inflight: {
              user: session.inflightUser ?? "",
              assistant: session.inflightAssistant ?? "",
              streaming: session.running,
            },
          }),
      ...(created ? {} : { resumed: session.storedId }),
    }
  }

  private summary(session: FakeSession) {
    return {
      id: session.storedId,
      title: session.title,
      preview: session.messages.at(-1)?.content ?? "",
      started_at: session.createdAt,
      last_active: session.createdAt + session.messages.length,
      message_count: session.messages.length,
      source: "web",
      model: session.model,
      is_active: session.active,
      archived: false,
      input_tokens: 0,
      output_tokens: 0,
      tool_call_count: 0,
    }
  }

  private info(session: FakeSession) {
    return {
      model: session.model,
      provider: session.provider,
      reasoning_effort: session.reasoningEffort,
      service_tier: "",
      fast: false,
      yolo: false,
      tools: { core: ["terminal"] },
      skills: {},
      cwd: "/test/workspace",
      branch: "main",
      personality: "",
      running: session.running,
      title: session.title,
      desktop_contract: 4,
      version: "0.18.2-test",
      profile_name: "default",
    }
  }

  private undo(session: FakeSession) {
    if (session.running) throw new FakeRpcError(4009, "session busy")
    const userIndex = findLastUserMessageIndex(session.messages)
    if (userIndex < 0) throw new FakeRpcError(4018, "no user messages to undo")
    const message = session.messages[userIndex]?.content ?? ""
    session.messages = session.messages.slice(0, userIndex)
    return { type: "prefill" as const, message, notice: "Undid 1 turn." }
  }

  private requireRuntimeSession(params: Record<string, unknown>): FakeSession {
    const runtimeId = stringValue(params.session_id)
    const session = this.state.sessionsByRuntime.get(runtimeId)
    if (!session) throw new FakeRpcError(4001, "invalid session")
    return session
  }

  private liveStatus(session: FakeSession): "idle" | "starting" | "waiting" | "working" {
    if (session.pendingApproval) return "waiting"
    if (session.running) return session.inflightAssistant === undefined ? "starting" : "working"
    return "idle"
  }

  private message(
    role: FakeMessage["role"],
    content: string,
    extras: Omit<Partial<FakeMessage>, "content" | "role" | "timestamp"> = {},
  ): FakeMessage {
    return { role, content, timestamp: FIXED_TIME + ++this.state.messageSequence, ...extras }
  }

  private emit(type: string, sessionId?: string, payload?: Record<string, unknown>): void {
    const session = sessionId ? this.state.sessionsByRuntime.get(sessionId) : undefined
    if (session && type === "message.start") session.inflightAssistant = ""
    if (session && type === "message.delta") {
      session.inflightAssistant = `${session.inflightAssistant ?? ""}${stringValue(payload?.text)}`
    }
    for (const socket of this.state.sockets) this.sendEvent(socket, type, sessionId, payload)
  }

  private sendEvent(socket: WebSocket, type: string, sessionId?: string, payload?: Record<string, unknown>): void {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type, ...(sessionId ? { session_id: sessionId } : {}), ...(payload ? { payload } : {}) },
    }))
  }

  private send(frame: unknown): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(frame))
  }
}

class FakeRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

function modelOptions(model: string, provider: string) {
  return {
    model,
    provider,
    providers: [
      {
        slug: "openai-codex",
        name: "OpenAI Codex",
        is_current: provider === "openai-codex",
        authenticated: true,
        models: ["gpt-5.6-sol"],
        capabilities: { "gpt-5.6-sol": { fast: true, reasoning: true } },
      },
      {
        slug: "anthropic",
        name: "Anthropic",
        is_current: provider === "anthropic",
        authenticated: true,
        models: ["claude-sonnet-4.6"],
        capabilities: { "claude-sonnet-4.6": { fast: false, reasoning: true } },
      },
    ],
  }
}

function normalizeSlashCommand(command: string): string {
  return command.trim().replace(/^\/+/, "")
}

function fakeSlashCompletions(text: string) {
  if (!text.startsWith("/")) return { items: [] }

  const firstSpace = text.indexOf(" ")
  if (firstSpace < 0) {
    const descriptions = new Map<string, string>(FAKE_COMMAND_PAIRS)
    for (const [alias, canonical] of Object.entries(FAKE_COMMAND_CANON)) {
      if (!descriptions.has(alias)) descriptions.set(alias, `Alias for ${canonical}`)
    }
    const query = text.toLowerCase()
    const items = [...descriptions]
      .filter(([command]) => command.toLowerCase().startsWith(query))
      .slice(0, 30)
      .map(([command, description]) => ({
        // Live prompt_toolkit completions normally omit the slash because the
        // replacement starts just after it. Display keeps the complete label.
        text: command.slice(1),
        display: command,
        meta: description,
      }))
    return { items, replace_from: 1 }
  }

  const command = text.slice(1, firstSpace).toLowerCase()
  const replaceFrom = text.lastIndexOf(" ") + 1
  const prefix = text.slice(replaceFrom).toLowerCase()
  const argumentCompletions: Record<string, Array<[text: string, meta: string]>> = {
    memory: (FAKE_COMMAND_SUB.memory ?? []).map((value) => [value, `Memory action: ${value}`]),
    model: [
      ["gpt-5.6-sol --provider openai-codex", "OpenAI Codex · current"],
      ["claude-sonnet-4.6 --provider anthropic", "Anthropic"],
    ],
    profile: [
      ["default", "Default Hermes profile"],
      ["research", "Research Hermes profile"],
    ],
    reasoning: (FAKE_COMMAND_SUB.reasoning ?? []).map((value) => [value, `Reasoning effort: ${value}`]),
    skills: (FAKE_COMMAND_SUB.skills ?? []).map((value) => [value, `Skills action: ${value}`]),
    yolo: (FAKE_COMMAND_SUB.yolo ?? []).map((value) => [value, `YOLO mode: ${value}`]),
  }
  const items = (argumentCompletions[command] ?? [])
    .filter(([value]) => value.toLowerCase().startsWith(prefix))
    .slice(0, 30)
    .map(([value, meta]) => ({ text: value, display: value, meta }))
  return { items, replace_from: replaceFrom }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=")
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue
    const value = pair.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

export { BIDI_MARKDOWN as TEST_BIDI_MARKDOWN }
