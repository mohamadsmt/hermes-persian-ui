import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomBytes } from "node:crypto"
import type { Readable } from "node:stream"

import type { BackendMode, BackendState, BootstrapInfo, CapabilitySet } from "../src/lib/hermes/types.js"
import { HERMES_DESKTOP_CONTRACT } from "../src/lib/hermes/types.js"
import { redact } from "./security.js"

const READY_PATTERN = /^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/m
const START_TIMEOUT_MS = 90_000
const MAX_RESTARTS = 3

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>

export interface UpstreamTarget {
  wsUrl?: string
  httpBaseUrl?: string
  token?: string
  apiKey?: string
}

export interface BackendSnapshot extends BootstrapInfo {
  restartCount: number
}

export interface HermesBackendManagerOptions {
  /** Only source-level development/test entrypoints may opt into the fake backend. */
  allowTestMode?: boolean
}

export class HermesBackendManager {
  private readonly mode: BackendMode
  private state: BackendState = "starting"
  private child: ManagedChild | null = null
  private token: string | undefined
  private port: number | undefined
  private error: string | undefined
  private version: string | undefined
  private releaseDate: string | undefined
  private voiceAvailable = false
  private restartCount = 0
  private stopped = false
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private stabilityTimer: ReturnType<typeof setTimeout> | undefined
  private startPromise: Promise<void> | null = null
  private readonly recentLogs: string[] = []

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: HermesBackendManagerOptions = {},
  ) {
    if (env.HERMES_TEST_MODE === "1" && !options.allowTestMode) {
      throw new Error("HERMES_TEST_MODE=1 is available only to an explicitly authorized development/test entrypoint")
    }
    this.mode = env.HERMES_TEST_MODE === "1"
      ? "test"
      : env.HERMES_BACKEND_MODE === "external"
        ? "external"
        : "managed"
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.stopped = false
    this.startPromise = this.startInternal()
      .catch((error: unknown) => {
        this.state = "error"
        this.error = safeError(error)
        throw error
      })
      .finally(() => {
        this.startPromise = null
      })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.stabilityTimer)
    this.state = "stopped"
    this.voiceAvailable = false
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.killed) return

    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }, 5_000)
      child.once("exit", () => {
        clearTimeout(force)
        resolve()
      })
      child.kill("SIGTERM")
    })
  }

  snapshot(): BackendSnapshot {
    return {
      mode: this.mode,
      state: this.state,
      ready: this.state === "ready",
      contract: HERMES_DESKTOP_CONTRACT,
      wsPath: "/api/hermes/ws",
      profile: this.env.HERMES_PROFILE?.trim() || null,
      capabilities: this.capabilities(),
      ...(this.version || this.releaseDate
        ? { backend: { ...(this.version ? { version: this.version } : {}), ...(this.releaseDate ? { releaseDate: this.releaseDate } : {}) } }
        : {}),
      ...(this.error ? { error: this.error } : {}),
      restartCount: this.restartCount,
    }
  }

  upstream(): UpstreamTarget {
    if (this.mode === "managed") {
      if (!this.port || this.state !== "ready") return {}
      return {
        wsUrl: `ws://127.0.0.1:${this.port}/api/ws`,
        httpBaseUrl: `http://127.0.0.1:${this.port}`,
        token: this.token,
      }
    }
    if (this.mode === "external") {
      try {
        return this.externalTarget()
      } catch {
        return {}
      }
    }
    return {}
  }

  logs(): readonly string[] {
    return this.recentLogs
  }

  private async startInternal(): Promise<void> {
    this.error = undefined
    this.voiceAvailable = false
    if (this.mode === "test") {
      this.state = "ready"
      this.version = "0.18.2-test"
      return
    }
    if (this.mode === "external") {
      const target = this.externalTarget()
      if (!target.wsUrl && !target.httpBaseUrl) {
        this.state = "error"
        this.error = "External mode requires HERMES_WS_URL or HERMES_BASE_URL"
        throw new Error(this.error)
      }
      this.state = "ready"
      await this.probeStatus()
      return
    }

    this.state = this.restartCount > 0 ? "restarting" : "starting"
    this.token = randomBytes(32).toString("base64url")
    const [command, ...prefixArgs] = parseHermesCommand(this.env.HERMES_COMMAND)
    const args = [
      ...prefixArgs,
      ...(this.env.HERMES_PROFILE?.trim() ? ["--profile", this.env.HERMES_PROFILE.trim()] : []),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]
    const child = spawn(command, args, {
      env: {
        ...this.env,
        HERMES_DASHBOARD_SESSION_TOKEN: this.token,
        HERMES_SERVE_HEADLESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"] as const,
      windowsHide: true,
    })
    this.child = child

    child.stderr.on("data", (chunk: Buffer) => this.rememberLog(chunk.toString()))
    const port = await this.waitForReady(child).catch((error: unknown) => {
      if (this.child === child) this.child = null
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM")
      throw error
    })
    if (this.child !== child || this.stopped) return
    this.port = port
    this.state = "ready"
    this.attachExitSupervisor(child)
    this.armStableReset(child)
    await this.probeStatus()
  }

  private waitForReady(child: ManagedChild): Promise<number> {
    return new Promise((resolve, reject) => {
      let buffer = ""
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout.off("data", onData)
        child.off("error", onError)
        child.off("exit", onExit)
      }
      const finish = (error?: Error, port?: number) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve(port as number)
      }
      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        this.rememberLog(text)
        buffer = `${buffer}${text}`.slice(-8_192)
        const match = READY_PATTERN.exec(buffer)
        if (match?.[1]) finish(undefined, Number(match[1]))
      }
      const onError = (error: Error) => finish(error)
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        finish(new Error(`Hermes backend exited before readiness (${signal ?? code ?? "unknown"})`))
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for Hermes backend (${START_TIMEOUT_MS}ms)`)), START_TIMEOUT_MS)
      child.stdout.on("data", onData)
      child.once("error", onError)
      child.once("exit", onExit)
    })
  }

  private attachExitSupervisor(child: ManagedChild): void {
    child.once("exit", (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.port = undefined
      this.voiceAvailable = false
      if (this.stopped) return
      this.error = `Hermes backend exited (${signal ?? code ?? "unknown"})`
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    clearTimeout(this.stabilityTimer)
    if (this.stopped) return
    if (this.restartCount >= MAX_RESTARTS) {
      this.state = "error"
      return
    }
    this.restartCount += 1
    this.state = "restarting"
    const delay = Math.min(4_000, 500 * 2 ** (this.restartCount - 1))
    clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      void this.start().catch((error: unknown) => {
        this.error = safeError(error)
        this.scheduleRestart()
      })
    }, delay)
  }

  private armStableReset(child: ManagedChild): void {
    clearTimeout(this.stabilityTimer)
    if (this.restartCount === 0) return
    this.stabilityTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null && this.state === "ready") this.restartCount = 0
    }, 30_000)
    this.stabilityTimer.unref()
  }

  private async probeStatus(): Promise<void> {
    const target = this.upstream()
    if (!target.httpBaseUrl) return
    const headers = new Headers({ accept: "application/json" })
    if (target.token) headers.set("X-Hermes-Session-Token", target.token)
    if (target.apiKey) headers.set("Authorization", `Bearer ${target.apiKey}`)
    const [statusResponse, voiceResults] = await Promise.all([
      fetch(`${target.httpBaseUrl}/api/status`, {
        headers,
        signal: AbortSignal.timeout(3_000),
      }).catch(() => null),
      Promise.all(
        ["/api/audio/transcribe", "/api/audio/speak"].map((path) =>
          fetch(`${target.httpBaseUrl}${path}`, {
            method: "POST",
            headers: new Headers([...headers, ["content-type", "application/json"]]),
            body: "{}",
            signal: AbortSignal.timeout(3_000),
          }).catch(() => null),
        ),
      ),
    ])
    this.voiceAvailable = voiceResults.every((response) => response?.status === 400 || response?.status === 422)
    if (!statusResponse?.ok) return
    const status = (await statusResponse.json().catch(() => null)) as Record<string, unknown> | null
    if (typeof status?.version === "string") this.version = status.version
    if (typeof status?.release_date === "string") this.releaseDate = status.release_date
  }

  private capabilities(): CapabilitySet {
    if (this.mode === "test") return allCapabilities(true)
    if (this.mode === "managed") return allCapabilities(this.voiceAvailable)
    const target = this.upstream()
    const gateway = Boolean(target.wsUrl)
    const httpFallback = Boolean(target.httpBaseUrl)
    return {
      gateway,
      sessions: gateway,
      models: gateway || httpFallback,
      attachments: gateway,
      approvals: gateway,
      clarification: gateway,
      sudo: gateway,
      secrets: gateway,
      branch: gateway,
      compress: gateway,
      voice: this.voiceAvailable,
      httpFallback,
    }
  }

  private rememberLog(value: string): void {
    for (const line of value.split(/\r?\n/)) {
      const cleaned = redact(line.trim()).slice(0, 1_000)
      if (!cleaned) continue
      this.recentLogs.push(cleaned)
      if (this.recentLogs.length > 100) this.recentLogs.shift()
    }
  }

  private externalTarget(): UpstreamTarget {
    return {
      ...(this.env.HERMES_WS_URL ? { wsUrl: validatedUrl(this.env.HERMES_WS_URL, ["ws:", "wss:"]) } : {}),
      ...(this.env.HERMES_BASE_URL
        ? { httpBaseUrl: validatedUrl(this.env.HERMES_BASE_URL, ["http:", "https:"]).replace(/\/+$/, "") }
        : {}),
      ...(this.env.HERMES_WS_TOKEN ? { token: this.env.HERMES_WS_TOKEN } : {}),
      ...(this.env.HERMES_API_KEY ? { apiKey: this.env.HERMES_API_KEY } : {}),
    }
  }
}

function allCapabilities(voice: boolean): CapabilitySet {
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
    voice,
    httpFallback: true,
  }
}

function parseHermesCommand(value: string | undefined): [string, ...string[]] {
  const command = value?.trim()
  if (!command) return ["hermes"]
  if (command.startsWith("[")) {
    const parsed: unknown = JSON.parse(command)
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item)) {
      throw new Error("HERMES_COMMAND JSON form must be a non-empty array of strings")
    }
    return parsed as [string, ...string[]]
  }
  return [command]
}

function validatedUrl(value: string, protocols: readonly string[]): string {
  const parsed = new URL(value)
  if (!protocols.includes(parsed.protocol)) throw new Error(`Unsupported Hermes URL protocol: ${parsed.protocol}`)
  return parsed.toString()
}

function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}
