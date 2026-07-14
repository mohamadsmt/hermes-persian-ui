import type { IncomingMessage, ServerResponse } from "node:http"
import { once } from "node:events"

import type { BackendSnapshot, UpstreamTarget } from "./backend-manager.js"
import { redact } from "./security.js"

type JsonRecord = Record<string, unknown>

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024
const FILE_BODY_LIMIT = 50 * 1024 * 1024
/** A 25 MiB raw recording expands to ~33.4 MiB as a base64 data URL in JSON. */
export const TRANSCRIBE_BODY_LIMIT = 35 * 1024 * 1024
const SPEAK_BODY_LIMIT = 256 * 1024
const SESSION_MUTATION_BODY_LIMIT = 4 * 1024
const FILE_OPERATIONS = new Set(["read", "download", "upload", "upload-stream", "mkdir"])
const HTTP_FALLBACK_BASE_PATHS = new Set([
  "v1/capabilities",
  "v1/runs",
  "v1/responses",
  "v1/chat/completions",
])
const PASSTHROUGH_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const

export interface HermesBffBackend {
  snapshot(): BackendSnapshot
  upstream(): UpstreamTarget
}

type Route = {
  body?: Buffer
  bodyLimit?: number
  methods: readonly string[]
  query?: URLSearchParams
  upstreamPath: string
}

export function isHermesBffPath(request: IncomingMessage): boolean {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname.startsWith("/api/hermes/")
  } catch {
    return false
  }
}

/**
 * Handle the server-side Hermes API before Next receives the request. Next dev
 * and production route workers do not share process globals with a custom
 * server, while this dispatcher always uses the exact manager that owns the
 * managed child and its in-memory credential.
 */
export async function dispatchHermesBff(
  request: IncomingMessage,
  response: ServerResponse,
  backend: HermesBffBackend,
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
  if (!requestUrl.pathname.startsWith("/api/hermes/")) return false

  try {
    if (requestUrl.pathname === "/api/hermes/bootstrap") {
      if (!allowMethod(request, response, ["GET"])) return true
      const { restartCount: _restartCount, ...bootstrap } = backend.snapshot()
      writeJson(response, bootstrap.ready ? 200 : 503, bootstrap)
      return true
    }

    if (requestUrl.pathname === "/api/hermes/status") {
      if (!allowMethod(request, response, ["GET"])) return true
      if (backend.snapshot().mode === "test") writeJson(response, 200, testStatusPayload())
      else await proxyRequest(request, response, backend.upstream(), requestUrl, { methods: ["GET"], upstreamPath: "/api/status" })
      return true
    }

    if (requestUrl.pathname === "/api/hermes/profiles") {
      if (!allowMethod(request, response, ["GET"])) return true
      if (backend.snapshot().mode === "test") writeJson(response, 200, testProfilesPayload())
      else await proxyRequest(request, response, backend.upstream(), requestUrl, { methods: ["GET"], upstreamPath: "/api/profiles" })
      return true
    }

    if (requestUrl.pathname === "/api/hermes/sessions") {
      if (!allowMethod(request, response, ["GET"])) return true
      const query = profileSessionQuery(requestUrl)
      if (!query) {
        writeJsonError(response, 400, "A concrete Hermes profile is required")
      } else if (backend.snapshot().mode === "test") {
        const profile = query.get("profile") as string
        const limit = Number(query.get("limit"))
        writeJson(response, 200, {
          sessions: [],
          total: 0,
          profile_totals: { [profile]: 0 },
          limit,
          offset: 0,
          errors: [],
        })
      } else {
        await proxyRequest(request, response, backend.upstream(), requestUrl, {
          methods: ["GET"],
          query,
          upstreamPath: "/api/profiles/sessions",
        })
      }
      return true
    }

    const messagesSessionId = sessionMessagesPathSegment(requestUrl.pathname)
    if (messagesSessionId !== null) {
      if (!allowMethod(request, response, ["GET"])) return true
      const profile = concreteProfile(requestUrl)
      if (!profile) {
        writeJsonError(response, 400, "A concrete Hermes profile is required")
      } else if (backend.snapshot().mode === "test") {
        writeJson(response, 200, { session_id: messagesSessionId, messages: [] })
      } else {
        await proxyRequest(request, response, backend.upstream(), requestUrl, {
          methods: ["GET"],
          // Deliberately discard every browser query except the validated
          // profile so aggregate or pagination switches cannot escape the BFF.
          query: new URLSearchParams({ profile }),
          upstreamPath: `/api/sessions/${encodeURIComponent(messagesSessionId)}/messages`,
        })
      }
      return true
    }

    const storedSessionId = singlePathSegment(requestUrl.pathname, "/api/hermes/sessions/")
    if (storedSessionId !== null) {
      const profile = concreteProfile(requestUrl)
      if (!profile) {
        writeJsonError(response, 400, "A concrete Hermes profile is required")
        return true
      }
      const method = (request.method ?? "GET").toUpperCase()
      if (method === "DELETE") {
        if (backend.snapshot().mode === "test") writeJson(response, 200, { ok: true })
        else {
          await proxyRequest(request, response, backend.upstream(), requestUrl, {
            methods: ["DELETE"],
            query: new URLSearchParams({ profile }),
            upstreamPath: `/api/sessions/${encodeURIComponent(storedSessionId)}`,
          })
        }
        return true
      }
      if (method === "PATCH") {
        const body = await readLimitedBody(request, SESSION_MUTATION_BODY_LIMIT)
        const title = parseRenameTitle(body)
        if (title === null) {
          writeJsonError(response, 400, "A non-empty session title of at most 100 characters is required")
          return true
        }
        if (backend.snapshot().mode === "test") writeJson(response, 200, { ok: true, title })
        else {
          await proxyRequest(request, response, backend.upstream(), requestUrl, {
            body: Buffer.from(JSON.stringify({ title, profile })),
            methods: ["PATCH"],
            query: new URLSearchParams(),
            upstreamPath: `/api/sessions/${encodeURIComponent(storedSessionId)}`,
          })
        }
        return true
      }
      allowMethod(request, response, ["DELETE", "PATCH"])
      return true
    }

    if (requestUrl.pathname === "/api/hermes/models") {
      if (!allowMethod(request, response, ["GET"])) return true
      if (backend.snapshot().mode === "test") writeJson(response, 200, testModelsPayload())
      else await proxyRequest(request, response, backend.upstream(), requestUrl, {
        methods: ["GET"],
        upstreamPath: "/api/model/options",
      })
      return true
    }

    if (requestUrl.pathname === "/api/hermes/audio/speak") {
      if (!allowMethod(request, response, ["POST"])) return true
      if (backend.snapshot().mode === "test") {
        await discardLimitedBody(request, SPEAK_BODY_LIMIT)
        writeJson(response, 200, {
          ok: true,
          data_url: "data:audio/wav;base64,UklGRg==",
          mime_type: "audio/wav",
          provider: "test",
        })
      } else {
        await proxyRequest(request, response, backend.upstream(), requestUrl, {
          bodyLimit: SPEAK_BODY_LIMIT,
          methods: ["POST"],
          upstreamPath: "/api/audio/speak",
        })
      }
      return true
    }

    if (requestUrl.pathname === "/api/hermes/audio/transcribe") {
      if (!allowMethod(request, response, ["POST"])) return true
      if (backend.snapshot().mode === "test") {
        await discardLimitedBody(request, TRANSCRIBE_BODY_LIMIT)
        writeJson(response, 200, { ok: true, transcript: "صدای آزمایشی", provider: "test" })
      } else {
        await proxyRequest(request, response, backend.upstream(), requestUrl, {
          bodyLimit: TRANSCRIBE_BODY_LIMIT,
          methods: ["POST"],
          upstreamPath: "/api/audio/transcribe",
        })
      }
      return true
    }

    if (requestUrl.pathname === "/api/hermes/media") {
      await proxyRequest(request, response, backend.upstream(), requestUrl, {
        methods: ["GET"],
        upstreamPath: "/api/media",
      })
      return true
    }

    if (requestUrl.pathname === "/api/hermes/files") {
      await proxyRequest(request, response, backend.upstream(), requestUrl, {
        methods: ["GET", "DELETE"],
        upstreamPath: "/api/files",
      })
      return true
    }

    const fileOperation = singlePathSegment(requestUrl.pathname, "/api/hermes/files/")
    if (fileOperation !== null) {
      if (!FILE_OPERATIONS.has(fileOperation)) {
        writeJsonError(response, 404, "Unknown file operation")
      } else {
        await proxyRequest(request, response, backend.upstream(), requestUrl, {
          bodyLimit: FILE_BODY_LIMIT,
          methods: ["GET", "POST", "DELETE"],
          upstreamPath: `/api/files/${fileOperation}`,
        })
      }
      return true
    }

    const fallbackPath = pathRemainder(requestUrl.pathname, "/api/hermes/http/")
    if (fallbackPath !== null) {
      const fallbackRoute = resolveHttpFallbackRoute(fallbackPath)
      if (!fallbackRoute) {
        writeJsonError(response, 404, "Unknown Hermes fallback endpoint")
      } else if (!allowMethod(request, response, fallbackRoute.methods)) {
        // allowMethod already wrote the response.
      } else if (backend.snapshot().mode === "test") {
        await writeTestFallback(request, response, fallbackPath)
      } else {
        await proxyRequest(request, response, backend.upstream(), requestUrl, {
          bodyLimit: DEFAULT_BODY_LIMIT,
          methods: fallbackRoute.methods,
          upstreamPath: `/${fallbackPath}`,
        })
      }
      return true
    }

    writeJsonError(response, 404, "Unknown Hermes endpoint")
    return true
  } catch (error) {
    if (response.headersSent || response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined)
      return true
    }
    if (error instanceof BodyLimitError) {
      response.setHeader("connection", "close")
      writeJsonError(response, 413, error.message)
      request.resume()
      return true
    }
    writeJsonError(response, 502, `Could not reach Hermes backend: ${redact(error instanceof Error ? error.message : String(error))}`)
    return true
  }
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: UpstreamTarget,
  requestUrl: URL,
  route: Route,
): Promise<void> {
  if (!allowMethod(request, response, route.methods)) return
  if (!target.httpBaseUrl) {
    writeJsonError(response, 503, "Hermes HTTP backend is unavailable")
    return
  }

  const upstreamUrl = new URL(route.upstreamPath, `${target.httpBaseUrl.replace(/\/+$/, "")}/`)
  for (const [key, value] of route.query ?? requestUrl.searchParams) upstreamUrl.searchParams.append(key, value)

  const headers = new Headers()
  copyRequestHeader(request, headers, "accept")
  copyRequestHeader(request, headers, "content-type")
  copyRequestHeader(request, headers, "range")
  if (target.token) headers.set("X-Hermes-Session-Token", target.token)
  if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`)

  const method = (request.method ?? "GET").toUpperCase()
  const body = ["GET", "HEAD", "OPTIONS"].includes(method)
    ? undefined
    : route.body ?? await readLimitedBody(request, route.bodyLimit ?? DEFAULT_BODY_LIMIT)
  if (route.body) headers.set("content-type", "application/json")
  const abort = new AbortController()
  const onAborted = () => abort.abort()
  const onClosed = () => {
    if (!response.writableEnded) abort.abort()
  }
  request.once("aborted", onAborted)
  response.once("close", onClosed)
  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      ...(body && body.byteLength > 0 ? { body: new Uint8Array(body) } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: abort.signal,
    })
    await streamResponse(response, upstream)
  } finally {
    request.off("aborted", onAborted)
    response.off("close", onClosed)
  }
}

async function streamResponse(response: ServerResponse, upstream: Response): Promise<void> {
  response.statusCode = upstream.status
  if (upstream.statusText) response.statusMessage = upstream.statusText
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) response.setHeader(name, value)
  }
  response.setHeader("x-content-type-options", "nosniff")
  if (!upstream.body) {
    response.end()
    return
  }

  const reader = upstream.body.getReader()
  try {
    while (!response.destroyed) {
      const { value, done } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) await once(response, "drain")
    }
  } finally {
    reader.releaseLock()
  }
  if (!response.destroyed) response.end()
}

async function writeTestFallback(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  if (path === "v1/capabilities") {
    writeJson(response, 200, {
      endpoints: ["/v1/runs", "/v1/responses", "/v1/chat/completions"],
      streaming: true,
    })
    return
  }
  if (request.method === "OPTIONS") {
    response.statusCode = 204
    response.setHeader("allow", "POST, OPTIONS")
    response.end()
    return
  }
  if (path === "v1/runs" && request.method === "POST") {
    await discardLimitedBody(request, DEFAULT_BODY_LIMIT)
    writeJson(response, 202, { run_id: "run_test", status: "started" })
    return
  }
  if (path === "v1/runs/run_test/events" && request.method === "GET") {
    response.statusCode = 200
    response.setHeader("content-type", "text/event-stream; charset=utf-8")
    response.setHeader("cache-control", "no-store")
    response.write('data: {"event":"message.delta","run_id":"run_test","delta":"پاسخ آزمایشی"}\n\n')
    response.end('data: {"event":"run.completed","run_id":"run_test","output":"پاسخ آزمایشی"}\n\n')
    return
  }
  if (path === "v1/runs/run_test/stop" && request.method === "POST") {
    await discardLimitedBody(request, DEFAULT_BODY_LIMIT)
    writeJson(response, 200, { run_id: "run_test", status: "stopping" })
    return
  }
  if (request.method === "POST") await discardLimitedBody(request, DEFAULT_BODY_LIMIT)
  response.statusCode = 200
  response.setHeader("content-type", "text/event-stream; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.setHeader("x-content-type-options", "nosniff")
  response.write('event: response.output_text.delta\ndata: {"delta":"پاسخ آزمایشی"}\n\n')
  response.end('event: response.completed\ndata: {"id":"response-test","output_text":"پاسخ آزمایشی"}\n\n')
}

async function discardLimitedBody(request: IncomingMessage, limit: number): Promise<void> {
  await readLimitedBody(request, limit)
}

async function readLimitedBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const declared = Number(request.headers["content-length"] ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw new BodyLimitError(limit)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += value.byteLength
    if (total > limit) throw new BodyLimitError(limit)
    chunks.push(value)
  }
  return total > 0 ? Buffer.concat(chunks, total) : undefined
}

function allowMethod(request: IncomingMessage, response: ServerResponse, methods: readonly string[]): boolean {
  const method = (request.method ?? "GET").toUpperCase()
  if (methods.includes(method)) return true
  response.setHeader("allow", methods.join(", "))
  writeJsonError(response, 405, "Method not allowed")
  return false
}

function copyRequestHeader(request: IncomingMessage, headers: Headers, name: string): void {
  const value = request.headers[name]
  if (typeof value === "string") headers.set(name, value)
  else if (Array.isArray(value) && value.length) headers.set(name, value.join(", "))
}

function singlePathSegment(pathname: string, prefix: string): string | null {
  const value = pathRemainder(pathname, prefix)
  if (value === null || !value || value.includes("/")) return null
  try {
    const decoded = decodeURIComponent(value)
    return decoded.includes("/") || decoded.includes("\\") || decoded === ".." ? null : decoded
  } catch {
    return null
  }
}

const MAX_SESSION_ID_LENGTH = 256
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u

function sessionMessagesPathSegment(pathname: string): string | null {
  const suffix = "/messages"
  if (!pathname.endsWith(suffix)) return null
  const value = singlePathSegment(pathname.slice(0, -suffix.length), "/api/hermes/sessions/")
  if (
    !value ||
    value.length > MAX_SESSION_ID_LENGTH ||
    value === "." ||
    value === ".." ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null
  }
  return value
}

function pathRemainder(pathname: string, prefix: string): string | null {
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Build the entire upstream query here so browser-supplied aggregate/filter
 * switches (especially `profile=all`) can never cross the BFF boundary. */
function profileSessionQuery(requestUrl: URL): URLSearchParams | null {
  const profile = concreteProfile(requestUrl)
  if (!profile) return null

  const rawLimit = requestUrl.searchParams.get("limit")
  const parsedLimit = rawLimit === null || rawLimit === "" ? 100 : Number(rawLimit)
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) return null
  const limit = Math.min(parsedLimit, 200)
  return new URLSearchParams({
    limit: String(limit),
    offset: "0",
    min_messages: "0",
    archived: "exclude",
    order: "recent",
    profile,
    exclude_sources: "tool",
  })
}

function concreteProfile(requestUrl: URL): string | null {
  const requestedProfiles = requestUrl.searchParams.getAll("profile")
  if (requestedProfiles.length !== 1) return null
  const profile = requestedProfiles[0]?.trim() ?? ""
  return PROFILE_NAME_PATTERN.test(profile) && profile !== "all" ? profile : null
}

function parseRenameTitle(body: Buffer | undefined): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== "title")) return null
    if (typeof record.title !== "string") return null
    const title = record.title.trim()
    return title && title.length <= 100 ? title : null
  } catch {
    return null
  }
}

function resolveHttpFallbackRoute(path: string): { methods: readonly string[] } | null {
  if (!HTTP_FALLBACK_BASE_PATHS.has(path)) {
    const run = /^v1\/runs\/([A-Za-z0-9_-]+)(?:\/(events|stop))?$/.exec(path)
    if (!run) return null
    if (run[2] === "events" || run[2] === undefined) return { methods: ["GET"] }
    if (run[2] === "stop") return { methods: ["POST"] }
    return null
  }
  if (path === "v1/capabilities") return { methods: ["GET", "OPTIONS"] }
  return { methods: ["POST", "OPTIONS"] }
}

function writeJsonError(response: ServerResponse, status: number, error: string): void {
  writeJson(response, status, { error })
}

function writeJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.setHeader("x-content-type-options", "nosniff")
  response.end(JSON.stringify(data))
}

function testStatusPayload(): JsonRecord {
  return {
    active_sessions: 0,
    config_path: "test://config.yaml",
    config_version: 2,
    env_path: "test://.env",
    gateway_running: true,
    hermes_home: "test://hermes",
    latest_config_version: 2,
    release_date: "2026-07-13",
    version: "0.18.2-test",
  }
}

function testProfilesPayload(): JsonRecord {
  return {
    profiles: [
      {
        has_env: true,
        is_default: true,
        model: "gpt-5.6-sol",
        name: "default",
        path: "test://hermes",
        provider: "openai-codex",
        skill_count: 0,
      },
    ],
  }
}

function testModelsPayload(): JsonRecord {
  return {
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    providers: [
      {
        slug: "openai-codex",
        name: "OpenAI Codex",
        is_current: true,
        authenticated: true,
        models: ["gpt-5.6-sol"],
        capabilities: { "gpt-5.6-sol": { fast: true, reasoning: true } },
      },
      {
        slug: "anthropic",
        name: "Anthropic",
        is_current: false,
        authenticated: true,
        models: ["claude-sonnet-4.6"],
        capabilities: { "claude-sonnet-4.6": { fast: false, reasoning: true } },
      },
    ],
  }
}

class BodyLimitError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`)
    this.name = "BodyLimitError"
  }
}
