import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Duplex } from "node:stream"
import { promisify } from "node:util"

import { WebSocket, type RawData } from "ws"

import { HermesBackendManager } from "../server/backend-manager.js"
import { dispatchHermesBff, isHermesBffPath } from "../server/hermes-bff.js"
import {
  applySecurityHeaders,
  rejectRequest,
  validateHttpRequest,
  validateWebSocketRequest,
} from "../server/security.js"
import { HermesWebSocketRelay, type TestGatewayAdapter } from "../server/ws-relay.js"

const CONTRACT_VERSION = 2
const MIN_GATEWAY_CONTRACT_VERSION = 2
const DEFAULT_EXPECTED_VERSION = "0.18.2"
const DEFAULT_EXPECTED_MODEL = "gpt-5.6-sol"
const DEFAULT_EXPECTED_PROVIDER = "openai-codex"
const DEFAULT_RPC_TIMEOUT_MS = 120_000
const DEFAULT_TURN_TIMEOUT_MS = 180_000
const execFileAsync = promisify(execFile)

type JsonRecord = Record<string, unknown>

type GatewayEvent = {
  type: string
  session_id?: string
  payload?: unknown
}

type TemporarySession = {
  runtimeId: string
  storedId: string
  promptSubmitted: boolean
  turnCompleted: boolean
}

type RecoveryFixture = {
  checkpointMessage: string
  file: string
  root: string
  workspace: string
}

type SmokeTarget = {
  label: string
  wsUrl: URL
  origin: string
  bootstrap?: JsonRecord
  status?: JsonRecord
  profiles?: JsonRecord
  stop?: () => Promise<void>
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = "RpcError"
  }
}

class GatewayRpcClient {
  private socket: WebSocket | null = null
  private nextId = 0
  private readonly pending = new Map<
    number,
    {
      reject: (error: Error) => void
      resolve: (value: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>()

  constructor(
    private readonly url: URL,
    private readonly origin: string,
    private readonly authorization?: string,
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const headers: Record<string, string> = { Origin: this.origin }
      if (this.authorization) headers.Authorization = this.authorization
      const socket = new WebSocket(this.url, {
        headers,
        handshakeTimeout: DEFAULT_RPC_TIMEOUT_MS,
        maxPayload: 4 * 1024 * 1024,
        perMessageDeflate: false,
      })
      this.socket = socket

      const timer = setTimeout(() => finish(new Error("Timed out connecting to the Hermes gateway")), DEFAULT_RPC_TIMEOUT_MS)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }

      socket.on("open", () => finish())
      socket.on("message", (data) => this.handleMessage(data))
      socket.on("error", (error) => {
        if (!settled) finish(error)
        else this.rejectAll(error)
      })
      socket.on("close", () => {
        if (!settled) finish(new Error("Hermes gateway closed during connection"))
        this.rejectAll(new Error("Hermes gateway connection closed"))
      })
    })
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "smoke complete")
    this.rejectAll(new Error("Hermes smoke client closed"))
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  request<T = unknown>(method: string, params: JsonRecord = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Hermes gateway is not connected"))
    }
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for Hermes method ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (!error) return
        const request = this.pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(id)
        request.reject(error)
      })
    })
  }

  private handleMessage(data: RawData): void {
    let message: JsonRecord
    try {
      const parsed: unknown = JSON.parse(rawDataText(data))
      if (!isRecord(parsed)) return
      message = parsed
    } catch {
      return
    }

    if (message.method === "event") {
      const params = isRecord(message.params) ? message.params : null
      if (!params || typeof params.type !== "string") return
      const event: GatewayEvent = {
        type: params.type,
        ...(typeof params.session_id === "string" ? { session_id: params.session_id } : {}),
        ...(params.payload === undefined ? {} : { payload: params.payload }),
      }
      for (const listener of this.eventListeners) listener(event)
      return
    }

    if (typeof message.id !== "number") return
    const request = this.pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    this.pending.delete(message.id)
    if (isRecord(message.error)) {
      request.reject(
        new RpcError(
          typeof message.error.message === "string" ? message.error.message : "Hermes JSON-RPC request failed",
          typeof message.error.code === "number" ? message.error.code : undefined,
        ),
      )
      return
    }
    request.resolve(message.result)
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

async function main(): Promise<void> {
  const allowBilling = process.env.HERMES_SMOKE_ALLOW_BILLING === "1"
  const recovery = process.env.HERMES_SMOKE_RECOVERY === "1"
    ? await prepareRecoveryFixture()
    : null
  let target: SmokeTarget
  try {
    target = await prepareTarget()
  } catch (error) {
    await cleanupRecoveryFixture(recovery)
    throw error
  }
  const client = new GatewayRpcClient(
    target.wsUrl,
    target.origin,
    process.env.HERMES_SMOKE_DIRECT === "1" && process.env.HERMES_API_KEY
      ? `Bearer ${process.env.HERMES_API_KEY}`
      : undefined,
  )
  const sessions: TemporarySession[] = []
  let failure: unknown

  try {
    log(`target: ${target.label}`)
    reportHttpDiscovery(target)
    await client.connect()
    log("gateway: connected")

    if (recovery) {
      log("route: skipped for isolated recovery smoke")
    } else {
      const modelPayload = asRecord(
        await client.request("model.options", { include_unconfigured: false }, timeoutFromEnv("HERMES_SMOKE_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS)),
        "model.options",
      )
      const currentModel = requiredString(modelPayload.model, "model.options.model")
      const currentProvider = requiredString(modelPayload.provider, "model.options.provider")
      const modelCount = countModels(modelPayload)
      assertExpected("model", currentModel, process.env.HERMES_SMOKE_EXPECT_MODEL || DEFAULT_EXPECTED_MODEL)
      assertExpected("provider", currentProvider, process.env.HERMES_SMOKE_EXPECT_PROVIDER || DEFAULT_EXPECTED_PROVIDER)
      log(`route: ${currentProvider}/${currentModel}; ${modelCount} configured model option(s)`)
    }

    const titleSeed = `Hermes UI smoke ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`
    const primarySession = await createTemporarySession(client, sessions, {
      title: recovery ? titleSeed : `${titleSeed} A`,
      ...(recovery ? { cwd: recovery.workspace } : {}),
    })
    const { runtimeId } = primarySession

    if (!recovery) {
      await createTemporarySession(client, sessions, { title: `${titleSeed} B` })
      await verifyConcurrentSessions(client, sessions)
    }

    await verifySlashCommands(client, runtimeId)

    if (recovery) await verifyRecovery(client, runtimeId, recovery)

    if (!allowBilling) {
      log("prompt: skipped (set HERMES_SMOKE_ALLOW_BILLING=1 to allow one billable live turn)")
    } else {
      const turn = waitForTurn(
        client,
        runtimeId,
        timeoutFromEnv("HERMES_SMOKE_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS),
      )
      primarySession.promptSubmitted = true
      await client.request(
        "prompt.submit",
        {
          session_id: runtimeId,
          text: "Reply with exactly OK. Do not call tools and do not perform any external action.",
        },
        timeoutFromEnv("HERMES_SMOKE_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS),
      )
      await turn
      primarySession.turnCompleted = true
      log("prompt: observed non-empty delta and message.complete")
    }
  } catch (error) {
    failure = error
  } finally {
    const cleanupError = await cleanupTemporarySessions(client, sessions)
    client.close()
    await target.stop?.()
    const recoveryCleanupError = await cleanupRecoveryFixture(recovery)
    const cleanupErrors = [cleanupError, recoveryCleanupError].filter((error): error is Error => Boolean(error))
    if (cleanupErrors.length) {
      const id = sessions.map((session) => session.storedId).join(", ") || "unknown"
      const cleanupFailure = new AggregateError(cleanupErrors, `Temporary smoke cleanup failed (${id})`)
      failure = failure ? new AggregateError([failure, cleanupFailure], "Smoke and cleanup both failed") : cleanupFailure
    }
  }

  if (failure) throw failure
  log(`PASS (${allowBilling ? "live prompt" : "connectivity only"})`)
}

async function createTemporarySession(
  client: GatewayRpcClient,
  sessions: TemporarySession[],
  options: { cwd?: string; title: string },
): Promise<TemporarySession> {
  const createPayload = asRecord(
    await client.request("session.create", {
      cols: 100,
      source: "web",
      title: options.title,
      close_on_disconnect: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(process.env.HERMES_PROFILE?.trim() ? { profile: process.env.HERMES_PROFILE.trim() } : {}),
    }),
    "session.create",
  )
  const runtimeId = requiredString(createPayload.session_id, "session.create.session_id")
  const storedId = requiredString(
    createPayload.stored_session_id ?? createPayload.session_key,
    "session.create.stored_session_id",
  )
  const session = { runtimeId, storedId, promptSubmitted: false, turnCompleted: false }
  sessions.push(session)

  const info = isRecord(createPayload.info) ? createPayload.info : {}
  const gatewayContract = info.desktop_contract
  if (typeof gatewayContract !== "number" || gatewayContract < MIN_GATEWAY_CONTRACT_VERSION) {
    throw new Error(
      `Hermes session contract mismatch: requires >=${MIN_GATEWAY_CONTRACT_VERSION}, received ${String(gatewayContract ?? "missing")}`,
    )
  }
  log(`session: created temporary runtime ${runtimeId}; gateway contract v${gatewayContract}`)
  return session
}

async function verifyConcurrentSessions(
  client: GatewayRpcClient,
  sessions: TemporarySession[],
): Promise<void> {
  const currentSession = sessions[1]
  if (!currentSession || sessions.length !== 2) {
    throw new Error(`Concurrent smoke requires exactly two temporary sessions, received ${sessions.length}`)
  }
  const activePayload = asRecord(
    await client.request("session.active_list", { current_session_id: currentSession.runtimeId }),
    "session.active_list",
  )
  if (!Array.isArray(activePayload.sessions)) {
    throw new Error("Hermes session.active_list is missing sessions")
  }

  for (const expected of sessions) {
    const active = activePayload.sessions.find((candidate) => (
      isRecord(candidate) && candidate.id === expected.runtimeId
    ))
    if (!isRecord(active)) {
      throw new Error(`Hermes session.active_list is missing runtime ${expected.runtimeId}`)
    }
    const storedId = requiredString(active.session_key, "session.active_list.sessions[].session_key")
    if (storedId !== expected.storedId) {
      throw new Error(
        `Hermes session.active_list identity mismatch for ${expected.runtimeId}: expected ${expected.storedId}, received ${storedId}`,
      )
    }
  }

  for (const expected of sessions) {
    const activated = asRecord(
      await client.request("session.activate", { session_id: expected.runtimeId }),
      "session.activate",
    )
    const runtimeId = requiredString(activated.session_id, "session.activate.session_id")
    const storedId = requiredString(
      activated.stored_session_id ?? activated.session_key,
      "session.activate.stored_session_id",
    )
    if (runtimeId !== expected.runtimeId || storedId !== expected.storedId) {
      throw new Error(
        `Hermes session.activate identity mismatch: expected ${expected.runtimeId}/${expected.storedId}, received ${runtimeId}/${storedId}`,
      )
    }
  }
  log("concurrency: two live sessions listed and independently activated")
}

async function verifySlashCommands(client: GatewayRpcClient, runtimeId: string): Promise<void> {
  const catalog = asRecord(
    await client.request("commands.catalog", { session_id: runtimeId }),
    "commands.catalog",
  )
  if (!Array.isArray(catalog.pairs) || !Array.isArray(catalog.categories)) {
    throw new Error("Hermes commands.catalog is missing pairs/categories")
  }
  if (!isRecord(catalog.canon) || !isRecord(catalog.sub)) {
    throw new Error("Hermes commands.catalog is missing canon/sub")
  }
  const hasVersion = catalog.pairs.some((pair) =>
    Array.isArray(pair) && typeof pair[0] === "string" && pair[0].toLowerCase() === "/version",
  )
  if (!hasVersion) throw new Error("Hermes commands.catalog does not advertise /version")

  const completion = asRecord(
    await client.request("complete.slash", { session_id: runtimeId, text: "/ver" }),
    "complete.slash",
  )
  if (!Array.isArray(completion.items) || typeof completion.replace_from !== "number") {
    throw new Error("Hermes complete.slash is missing items/replace_from")
  }
  const hasVersionCompletion = completion.items.some((item) => {
    if (!isRecord(item)) return false
    const candidate = firstString(item.text, item.display)?.replace(/^\//u, "").toLowerCase()
    return candidate === "version"
  })
  if (!hasVersionCompletion) throw new Error("Hermes complete.slash did not complete /version")

  const execution = asRecord(
    await client.request("slash.exec", { session_id: runtimeId, command: "version" }),
    "slash.exec",
  )
  requiredString(execution.output, "slash.exec.output")
  log(`slash: ${catalog.pairs.length} catalog pair(s); completion and /version execution verified`)
}

async function prepareRecoveryFixture(): Promise<RecoveryFixture> {
  const python = process.env.HERMES_SMOKE_RECOVERY_PYTHON?.trim()
  if (!python) throw new Error("HERMES_SMOKE_RECOVERY=1 requires HERMES_SMOKE_RECOVERY_PYTHON")
  const root = await mkdtemp(join(tmpdir(), "hermes-ui-recovery-"))
  const home = join(root, "home")
  const workspace = join(root, "workspace")
  const file = join(workspace, "state.txt")
  const checkpointMessage = "Hermes UI recovery smoke"
  try {
    await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })])
    await writeFile(
      join(home, "config.yaml"),
      "model:\n  provider: openrouter\n  default: openai/gpt-4o-mini\n",
      "utf8",
    )
    await writeFile(file, "before\n", "utf8")
    process.env.HERMES_HOME = home
    process.env.HERMES_TUI_CHECKPOINTS = "1"
    process.env.OPENROUTER_API_KEY ||= "hermes-ui-recovery-smoke-placeholder"
    const hermesRoot = resolve(dirname(python), "../..")
    await execFileAsync(
      python,
      [
        "-c",
        [
          "import sys",
          "from tools.checkpoint_manager import CheckpointManager",
          `ok = CheckpointManager(enabled=True).ensure_checkpoint(sys.argv[1], ${JSON.stringify(checkpointMessage)})`,
          "raise SystemExit(0 if ok else 3)",
        ].join("\n"),
        workspace,
      ],
      { cwd: hermesRoot, env: process.env, timeout: 30_000 },
    )
    return { checkpointMessage, file, root, workspace }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function verifyRecovery(
  client: GatewayRpcClient,
  runtimeId: string,
  fixture: RecoveryFixture,
): Promise<void> {
  await writeFile(fixture.file, "after\n", "utf8")
  const listed = asRecord(await client.request("rollback.list", { session_id: runtimeId }), "rollback.list")
  if (listed.enabled !== true || !Array.isArray(listed.checkpoints)) {
    throw new Error("Hermes recovery checkpoints are not enabled for the isolated smoke")
  }
  const checkpoint = listed.checkpoints.find((value) => (
    isRecord(value) && value.message === fixture.checkpointMessage
  ))
  if (!isRecord(checkpoint)) throw new Error("Hermes recovery smoke checkpoint was not listed")
  const hash = requiredString(checkpoint.hash, "rollback.list.checkpoint.hash")
  const diff = asRecord(
    await client.request("rollback.diff", { session_id: runtimeId, hash }),
    "rollback.diff",
  )
  if (typeof diff.diff !== "string" || !diff.diff.includes("after")) {
    throw new Error("Hermes recovery smoke did not return the temporary workspace diff")
  }
  const restored = asRecord(
    await client.request("rollback.restore", { session_id: runtimeId, hash }),
    "rollback.restore",
  )
  if (restored.success !== true || restored.history_synced !== true) {
    throw new Error("Hermes recovery smoke did not durably synchronize rollback history")
  }
  if (await readFile(fixture.file, "utf8") !== "before\n") {
    throw new Error("Hermes recovery smoke did not restore the temporary workspace file")
  }
  log("recovery: checkpoint diff, full restore, and durable history sync verified")
}

async function cleanupRecoveryFixture(fixture: RecoveryFixture | null): Promise<Error | null> {
  if (!fixture) return null
  try {
    await rm(fixture.root, { recursive: true, force: true })
    return null
  } catch (error) {
    return toError(error)
  }
}

async function prepareTarget(): Promise<SmokeTarget> {
  if (process.env.HERMES_SMOKE_DIRECT === "1") return directTarget()

  let ownedServer: Awaited<ReturnType<typeof startEphemeralBff>> | undefined
  const configuredUi = process.env.HERMES_SMOKE_UI_URL?.trim()
  const uiBase = configuredUi ? new URL(configuredUi) : (ownedServer = await startEphemeralBff()).url
  assertTrustedUrl(uiBase)
  const stop = ownedServer?.stop
  try {
    const bootstrap = await fetchJson(new URL("/api/hermes/bootstrap", uiBase), true)
    if (!bootstrap) throw new Error("Hermes UI bootstrap returned no JSON body")
    if (bootstrap.ready !== true) throw new Error("Hermes UI bootstrap reports backend not ready")
    if (bootstrap.contract !== CONTRACT_VERSION) {
      throw new Error(`Bootstrap contract mismatch: expected ${CONTRACT_VERSION}, received ${String(bootstrap.contract ?? "missing")}`)
    }
    const wsPath = requiredString(bootstrap.wsPath, "bootstrap.wsPath")
    const wsUrl = new URL(wsPath, uiBase)
    wsUrl.protocol = uiBase.protocol === "https:" ? "wss:" : "ws:"
    const [status, profiles] = await Promise.all([
      fetchJson(new URL("/api/hermes/status", uiBase), false),
      fetchJson(new URL("/api/hermes/profiles", uiBase), false),
    ])
    return {
      label: configuredUi
        ? `running UI ${safeUrl(uiBase)}`
        : `ephemeral ${process.env.HERMES_BACKEND_MODE === "external" ? "external" : "managed"} loopback BFF`,
      wsUrl,
      origin: uiBase.origin,
      bootstrap,
      ...(status ? { status } : {}),
      ...(profiles ? { profiles } : {}),
      ...(stop ? { stop } : {}),
    }
  } catch (error) {
    await stop?.()
    throw error
  }
}

async function directTarget(): Promise<SmokeTarget> {
  const configured = process.env.HERMES_WS_URL?.trim()
  if (!configured) throw new Error("HERMES_SMOKE_DIRECT=1 requires HERMES_WS_URL")
  const wsUrl = new URL(configured)
  assertTrustedUrl(wsUrl)
  if (process.env.HERMES_WS_TOKEN && !wsUrl.searchParams.has("token") && !wsUrl.searchParams.has("ticket")) {
    wsUrl.searchParams.set("token", process.env.HERMES_WS_TOKEN)
  }
  const origin = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`
  const baseUrl = process.env.HERMES_BASE_URL?.trim()
  let status: JsonRecord | null = null
  let profiles: JsonRecord | null = null
  if (baseUrl) {
    const base = new URL(baseUrl)
    assertTrustedUrl(base)
    const headers = directHttpHeaders()
    ;[status, profiles] = await Promise.all([
      fetchJson(new URL("/api/status", base), false, headers),
      fetchJson(new URL("/api/profiles", base), false, headers),
    ])
  }
  return {
    label: `direct gateway ${safeUrl(wsUrl)}`,
    wsUrl,
    origin,
    ...(status ? { status } : {}),
    ...(profiles ? { profiles } : {}),
  }
}

async function startEphemeralBff(): Promise<{ stop: () => Promise<void>; url: URL }> {
  const testMode = process.env.HERMES_TEST_MODE === "1"
  const backend = new HermesBackendManager(process.env, { allowTestMode: testMode })
  const relay = new HermesWebSocketRelay(
    backend,
    testMode ? await loadTestGatewayAdapter() : undefined,
  )
  let port = 0
  let stopped = false
  const server = createServer((request, response) => {
    applySecurityHeaders(response)
    if (!validateHttpRequest(request, port)) {
      rejectRequest(response)
      return
    }
    if (request.url?.split("?", 1)[0] === "/api/hermes/ws") {
      rejectRequest(response, 426, "WebSocket upgrade required")
      return
    }
    if (isHermesBffPath(request)) {
      void dispatchHermesBff(request, response, backend)
      return
    }
    rejectRequest(response, 404, "Not found")
  })
  server.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?", 1)[0] !== "/api/hermes/ws" || !validateWebSocketRequest(request, port)) {
      rejectUpgrade(socket)
      return
    }
    relay.handleUpgrade(request, socket, head)
  })
  const stop = async () => {
    if (stopped) return
    stopped = true
    server.closeIdleConnections()
    await Promise.allSettled([
      new Promise<void>((resolve) => server.close(() => resolve())),
      relay.close(),
      backend.stop(),
    ])
  }

  try {
    await backend.start()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Ephemeral Hermes BFF did not bind a TCP port")
    port = address.port
    return { url: new URL(`http://127.0.0.1:${port}`), stop }
  } catch (error) {
    await stop()
    throw error
  }
}

async function loadTestGatewayAdapter(): Promise<TestGatewayAdapter> {
  // `pnpm smoke:hermes` runs this source through tsx. The fake implementation
  // is intentionally excluded from the compiled production server tree.
  const specifier = `../server/${"fake-gateway"}.ts`
  const imported = (await import(specifier)) as {
    FakeHermesGatewayAdapter: new () => TestGatewayAdapter
  }
  return new imported.FakeHermesGatewayAdapter()
}

function rejectUpgrade(socket: Duplex): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
}

async function waitForTurn(client: GatewayRpcClient, sessionId: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let sawDelta = false
    const finish = (error?: Error) => {
      clearTimeout(timer)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    const unsubscribe = client.onEvent((event) => {
      if (event.session_id !== sessionId) return
      const payload = isRecord(event.payload) ? event.payload : {}
      if (event.type === "message.delta" && typeof payload.text === "string" && payload.text.length > 0) {
        sawDelta = true
        return
      }
      if (["approval.request", "clarify.request", "sudo.request", "secret.request"].includes(event.type)) {
        if (event.type === "approval.request") {
          void client.request("approval.respond", { session_id: sessionId, choice: "deny" }).catch(() => undefined)
        }
        finish(new Error(`Unexpected interactive prompt during smoke: ${event.type}`))
        return
      }
      if (event.type === "error") {
        finish(new Error(typeof payload.message === "string" ? payload.message : "Hermes emitted an error event"))
        return
      }
      if (event.type !== "message.complete") return
      const status = typeof payload.status === "string" ? payload.status : "complete"
      if (["error", "failed", "interrupted"].includes(status)) {
        finish(new Error(`Hermes turn ended with status ${status}`))
      } else if (!sawDelta) {
        finish(new Error("Hermes completed the turn without a non-empty message.delta"))
      } else {
        finish()
      }
    })
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for Hermes turn completion (${timeoutMs}ms)`)), timeoutMs)
  })
}

async function cleanupTemporarySessions(
  client: GatewayRpcClient,
  sessions: TemporarySession[],
): Promise<Error | null> {
  const errors: Error[] = []
  for (const session of [...sessions].reverse()) {
    const error = await cleanupTemporarySession(client, session)
    if (error) errors.push(error)
  }
  if (errors.length) return new AggregateError(errors, "one or more temporary sessions failed cleanup")
  if (sessions.length) log(`cleanup: closed and cleared ${sessions.length} temporary session(s)`)
  return null
}

async function cleanupTemporarySession(
  client: GatewayRpcClient,
  session: TemporarySession,
): Promise<Error | null> {
  const errors: Error[] = []
  if (session.promptSubmitted && !session.turnCompleted) {
    await client.request("session.interrupt", { session_id: session.runtimeId }).catch((error: unknown) => {
      errors.push(toError(error))
    })
  }
  await client.request("session.close", { session_id: session.runtimeId }).catch((error: unknown) => {
    errors.push(toError(error))
  })
  await client.request("session.delete", { session_id: session.storedId }).catch((error: unknown) => {
    // Hermes persists empty drafts lazily, so a connectivity-only session may
    // correctly report "not found" after close. Every other delete error is a
    // cleanup failure and includes the stable id in the final diagnostic.
    if (!(error instanceof RpcError && error.code === 4007 && !session.promptSubmitted)) errors.push(toError(error))
  })
  if (errors.length) return new AggregateError(errors, "one or more cleanup operations failed")
  return null
}

function reportHttpDiscovery(target: SmokeTarget): void {
  const backend = isRecord(target.bootstrap?.backend) ? target.bootstrap.backend : {}
  const version = firstString(target.status?.version, backend.version)
  const releaseDate = firstString(target.status?.release_date, backend.releaseDate)
  if (version) {
    assertExpected("Hermes version", version, process.env.HERMES_SMOKE_EXPECT_VERSION || DEFAULT_EXPECTED_VERSION, true)
    log(`backend: Hermes ${version}${releaseDate ? ` (${releaseDate})` : ""}; contract v${CONTRACT_VERSION}`)
  } else {
    log(`backend: version endpoint unavailable; WebSocket contract v${CONTRACT_VERSION} will be checked on session.create`)
  }
  const profiles = Array.isArray(target.profiles?.profiles) ? target.profiles.profiles : []
  if (profiles.length) {
    const names = profiles
      .map((item) => (isRecord(item) && typeof item.name === "string" ? item.name : null))
      .filter((name): name is string => Boolean(name))
    log(`profiles: ${names.length ? names.join(", ") : `${profiles.length} discovered`}`)
  } else {
    log("profiles: discovery endpoint unavailable or empty")
  }
}

async function fetchJson(url: URL, required: boolean, headers?: Headers): Promise<JsonRecord | null> {
  const requestHeaders = headers ?? new Headers()
  requestHeaders.set("accept", "application/json")
  const response = await fetch(url, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS),
  }).catch((error: unknown) => {
    if (required) throw error
    return null
  })
  if (!response) return null
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok || !isRecord(payload)) {
    if (required) throw new Error(`Hermes endpoint ${url.pathname} returned HTTP ${response.status}`)
    return null
  }
  return payload
}

function directHttpHeaders(): Headers {
  const headers = new Headers()
  if (process.env.HERMES_WS_TOKEN) headers.set("X-Hermes-Session-Token", process.env.HERMES_WS_TOKEN)
  else if (process.env.HERMES_API_KEY) headers.set("Authorization", `Bearer ${process.env.HERMES_API_KEY}`)
  return headers
}

function assertTrustedUrl(url: URL): void {
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`Unsupported smoke target protocol: ${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
  if (!loopback && process.env.HERMES_SMOKE_ALLOW_REMOTE !== "1") {
    throw new Error("Hermes smoke targets must be loopback; set HERMES_SMOKE_ALLOW_REMOTE=1 only for a trusted tunneled endpoint")
  }
}

function assertExpected(label: string, actual: string, expected: string, substring = false): void {
  const matches = substring ? actual.includes(expected) : actual === expected
  if (!matches) throw new Error(`Unexpected ${label}: expected ${expected}, received ${actual}`)
}

function countModels(payload: JsonRecord): number {
  if (!Array.isArray(payload.providers)) return 0
  return payload.providers.reduce((total, value) => {
    if (!isRecord(value) || !Array.isArray(value.models)) return total
    return total + value.models.filter((model) => typeof model === "string").length
  }, 0)
}

function timeoutFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
    throw new Error(`${name} must be an integer between 1000 and 600000 milliseconds`)
  }
  return value
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  return data.toString("utf8")
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Hermes ${label} response is not an object`)
  return value
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Hermes response is missing ${label}`)
  return value
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))
}

function safeUrl(url: URL): string {
  const clean = new URL(url)
  for (const key of ["token", "ticket", "key", "api_key"]) {
    if (clean.searchParams.has(key)) clean.searchParams.set(key, "[REDACTED]")
  }
  return clean.toString()
}

function redact(value: string): string {
  let output = value
  for (const secret of [process.env.HERMES_WS_TOKEN, process.env.HERMES_API_KEY]) {
    if (secret) output = output.split(secret).join("[REDACTED]")
  }
  return output
    .replace(/([?&](?:token|ticket|api_key|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function log(message: string): void {
  console.log(`[smoke:hermes] ${redact(message)}`)
}

void main().catch((error: unknown) => {
  const message = error instanceof AggregateError
    ? `${error.message}: ${error.errors.map((item) => toError(item).message).join("; ")}`
    : toError(error).message
  console.error(`[smoke:hermes] FAIL: ${redact(message)}`)
  process.exitCode = 1
})
