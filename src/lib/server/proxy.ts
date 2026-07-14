import { requireHermesServerRuntime } from "./runtime"

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024
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

export interface ProxyOptions {
  methods?: readonly string[]
  maxBodyBytes?: number
  query?: URLSearchParams
}

export async function proxyHermesRequest(request: Request, upstreamPath: string, options: ProxyOptions = {}): Promise<Response> {
  const method = request.method.toUpperCase()
  if (options.methods && !options.methods.includes(method)) return jsonError(405, "Method not allowed")
  if (!isSafeUpstreamPath(upstreamPath)) return jsonError(400, "Invalid upstream path")

  const runtime = requireHermesServerRuntime()
  const target = runtime.upstream()
  if (!target.httpBaseUrl) return jsonError(503, "Hermes HTTP backend is unavailable")

  const url = new URL(upstreamPath, `${target.httpBaseUrl.replace(/\/+$/, "")}/`)
  for (const [key, value] of options.query ?? []) url.searchParams.append(key, value)

  const headers = new Headers()
  const accept = request.headers.get("accept")
  const contentType = request.headers.get("content-type")
  const range = request.headers.get("range")
  if (accept) headers.set("accept", accept)
  if (contentType) headers.set("content-type", contentType)
  if (range) headers.set("range", range)
  if (target.token) headers.set("X-Hermes-Session-Token", target.token)
  if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`)

  let body: ArrayBuffer | undefined
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    try {
      body = await readLimitedBody(request, options.maxBodyBytes ?? DEFAULT_BODY_LIMIT)
    } catch (error) {
      return jsonError(413, error instanceof Error ? error.message : "Request body is too large")
    }
  }

  const upstream = await fetch(url, {
    method,
    headers,
    ...(body ? { body } : {}),
    cache: "no-store",
    redirect: "manual",
    signal: request.signal,
  }).catch((error: unknown) => {
    throw new Error(`Could not reach Hermes backend: ${error instanceof Error ? error.message : String(error)}`)
  })

  const responseHeaders = new Headers()
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  responseHeaders.set("x-content-type-options", "nosniff")
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function jsonError(status: number, error: string): Response {
  return json({ error }, { status })
}

export function testStatusPayload() {
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

export function testProfilesPayload() {
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

export function testModelsPayload() {
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

async function readLimitedBody(request: Request, limit: number): Promise<ArrayBuffer | undefined> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw new Error(`Request body exceeds ${limit} bytes`)
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error(`Request body exceeds ${limit} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return undefined
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output.buffer
}

function isSafeUpstreamPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\\") && !path.split("/").some((segment) => segment === "..")
}
