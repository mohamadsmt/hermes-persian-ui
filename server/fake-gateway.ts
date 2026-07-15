import type { IncomingMessage } from "node:http"
import type { WebSocket } from "ws"

import type { TestGatewayAdapter } from "./ws-relay.js"

const FIXED_TIME = 1_783_908_000
const DEFAULT_MODEL = "gpt-5.6-sol"
const DEFAULT_PROVIDER = "openai-codex"
const TEST_CLIENT_COOKIE = "hermes-e2e-client"

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
  sessionSequence = 0
  branchSequence = 0
  messageSequence = 0
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
    this.states.clear()
  }
}

export class FakeHermesGateway {
  constructor(
    private readonly socket: WebSocket,
    private readonly state = new FakeHermesGatewayState(),
  ) {}

  start(): void {
    this.emit("gateway.ready", undefined, { skin: null, desktop_contract: 4 })
    this.socket.on("message", (data) => this.handle(data.toString()))
    this.socket.on("close", () => {
      for (const session of this.state.sessionsByRuntime.values()) session.abort?.abort()
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
        return {
          result: {
            sessions: [...this.state.sessionsByRuntime.values()].filter((session) => session.active).map((session) => ({
              id: session.runtimeId,
              session_key: session.storedId,
              title: session.title,
              model: session.model,
              message_count: session.messages.length,
              started_at: session.createdAt,
              last_active: session.createdAt + this.state.messageSequence,
              status: session.running ? "streaming" : "idle",
            })),
          },
        }
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
      case "slash.exec": {
        const command = stringValue(params.command) || "/help"
        const output = command === "/skills diff skill-test"
          ? [
              "# Pending skill write skill-test:",
              "",
              "--- a/SKILL.md",
              "+++ b/SKILL.md",
              "@@",
              "-Review automation output.",
              "+Review automation output without exposing managed paths.",
            ].join("\n")
          : command === "/skills approve skill-test"
            ? "Approved 1 skills write(s)."
            : command === "/skills reject skill-test"
              ? "Rejected pending skills write 'skill-test'."
              : command === "/memory approve memory-test"
                ? "Approved 1 memory write(s)."
                : command === "/memory reject memory-test"
                  ? "Rejected pending memory write 'memory-test'."
                  : `Executed ${command}`
        return { result: { output } }
      }
      case "command.dispatch": {
        const session = this.requireRuntimeSession(params)
        if (stringValue(params.name) !== "undo") throw new FakeRpcError(4018, "unsupported command")
        if (session.running) throw new FakeRpcError(4009, "session busy")
        const userIndex = findLastUserMessageIndex(session.messages)
        if (userIndex < 0) throw new FakeRpcError(4018, "no user messages to undo")
        const message = session.messages[userIndex]?.content ?? ""
        session.messages = session.messages.slice(0, userIndex)
        return { result: { type: "prefill", message, notice: "Undid 1 turn." } }
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
      status: session.running ? "streaming" : "idle",
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

  private requireRuntimeSession(params: Record<string, unknown>): FakeSession {
    const runtimeId = stringValue(params.session_id)
    const session = this.state.sessionsByRuntime.get(runtimeId)
    if (!session) throw new FakeRpcError(4001, "invalid session")
    return session
  }

  private message(
    role: FakeMessage["role"],
    content: string,
    extras: Omit<Partial<FakeMessage>, "content" | "role" | "timestamp"> = {},
  ): FakeMessage {
    return { role, content, timestamp: FIXED_TIME + ++this.state.messageSequence, ...extras }
  }

  private emit(type: string, sessionId?: string, payload?: Record<string, unknown>): void {
    this.send({
      jsonrpc: "2.0",
      method: "event",
      params: { type, ...(sessionId ? { session_id: sessionId } : {}), ...(payload ? { payload } : {}) },
    })
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
