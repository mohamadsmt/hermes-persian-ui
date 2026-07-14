import { createServer, request as httpRequest, type Server } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import type { BackendSnapshot, UpstreamTarget } from "../server/backend-manager"
import { dispatchHermesBff, TRANSCRIBE_BODY_LIMIT, type HermesBffBackend } from "../server/hermes-bff"
import {
  applySecurityHeaders,
  rejectRequest,
  validateHttpRequest,
} from "../server/security"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

describe("loopback Hermes BFF dispatcher", () => {
  it("serves bootstrap from the owning manager without exposing restart or credentials", async () => {
    const backend = stubBackend({ token: "upstream-secret" })
    const base = await startBff(backend)

    const response = await fetch(`${base}/api/hermes/bootstrap`)
    const payload = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ ready: true, contract: 2, wsPath: "/api/hermes/ws" })
    expect(payload).not.toHaveProperty("restartCount")
    expect(JSON.stringify(payload)).not.toContain("upstream-secret")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
  })

  it("rejects non-loopback Host and cross-origin requests before dispatch", async () => {
    const base = await startBff(stubBackend())
    const url = new URL("/api/hermes/bootstrap", base)

    const badHost = await nodeRequest(url, { host: "example.com" })
    const badOrigin = await fetch(url, { headers: { origin: "http://example.com" } })

    expect(badHost.status).toBe(403)
    expect(badOrigin.status).toBe(403)
  })

  it("forwards only allowlisted request/response headers and keeps upstream credentials server-side", async () => {
    let observed: { apiKey?: string; browserAuthorization?: string; path?: string; token?: string } = {}
    const upstream = createServer((request, response) => {
      observed = {
        apiKey: request.headers.authorization,
        browserAuthorization: request.headers["x-browser-authorization"] as string | undefined,
        path: request.url,
        token: request.headers["x-hermes-session-token"] as string | undefined,
      }
      response.setHeader("content-type", "application/json")
      response.setHeader("set-cookie", "credential=must-not-pass")
      response.setHeader("authorization", "Bearer must-not-pass")
      response.end('{"ok":true}')
    })
    const upstreamBase = await listen(upstream)
    const backend = stubBackend({
      apiKey: "server-api-key",
      httpBaseUrl: upstreamBase,
      token: "server-session-token",
    })
    const base = await startBff(backend)

    const response = await fetch(`${base}/api/hermes/models?profile=default`, {
      headers: {
        authorization: "Bearer browser-value",
        "x-browser-authorization": "browser-value",
        "x-hermes-session-token": "browser-token",
      },
    })

    expect(await response.json()).toEqual({ ok: true })
    expect(observed).toEqual({
      apiKey: "Bearer server-api-key",
      browserAuthorization: undefined,
      path: "/api/model/options?profile=default",
      token: "server-session-token",
    })
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("authorization")).toBeNull()
  })

  it("lists sessions through the read-only profile endpoint and fails closed on aggregate input", async () => {
    const observed: string[] = []
    const upstream = createServer((request, response) => {
      observed.push(request.url ?? "")
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        sessions: [{ id: "research-1", profile: "research" }],
        total: 1,
        profile_totals: { research: 1 },
        limit: 200,
        offset: 0,
        errors: [],
      }))
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const scoped = await fetch(
      `${base}/api/hermes/sessions?profile=research&limit=999&full=1&archived=include`,
    )
    const [missing, aggregate, duplicate, malformed] = await Promise.all([
      fetch(`${base}/api/hermes/sessions`),
      fetch(`${base}/api/hermes/sessions?profile=all`),
      fetch(`${base}/api/hermes/sessions?profile=default&profile=research`),
      fetch(`${base}/api/hermes/sessions?profile=../research`),
    ])

    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toMatchObject({ sessions: [{ id: "research-1", profile: "research" }] })
    expect(observed).toEqual([
      "/api/profiles/sessions?limit=200&offset=0&min_messages=0&archived=exclude&order=recent&profile=research&exclude_sources=tool",
    ])
    expect([missing.status, aggregate.status, duplicate.status, malformed.status]).toEqual([400, 400, 400, 400])
  })

  it("reads one profile-scoped transcript and strips untrusted query switches", async () => {
    const observed: string[] = []
    const upstream = createServer((request, response) => {
      observed.push(request.url ?? "")
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        object: "list",
        session_id: "continued-1",
        data: [{ role: "tool", content: "done", tool_call_id: "call-1" }],
      }))
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const scoped = await fetch(
      `${base}/api/hermes/sessions/stored%20id/messages?profile=research&profile_hint=all&limit=500&offset=-1`,
    )
    const [missing, aggregate, duplicate, malformed, unsafeId, tooLong, wrongMethod] = await Promise.all([
      fetch(`${base}/api/hermes/sessions/stored-1/messages`),
      fetch(`${base}/api/hermes/sessions/stored-1/messages?profile=all`),
      fetch(`${base}/api/hermes/sessions/stored-1/messages?profile=default&profile=research`),
      fetch(`${base}/api/hermes/sessions/stored-1/messages?profile=research%0Aadmin`),
      fetch(`${base}/api/hermes/sessions/${encodeURIComponent("../escape")}/messages?profile=research`),
      fetch(`${base}/api/hermes/sessions/${"x".repeat(257)}/messages?profile=research`),
      fetch(`${base}/api/hermes/sessions/stored-1/messages?profile=research`, { method: "POST" }),
    ])

    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toMatchObject({
      session_id: "continued-1",
      data: [{ role: "tool", content: "done", tool_call_id: "call-1" }],
    })
    expect(observed).toEqual(["/api/sessions/stored%20id/messages?profile=research"])
    expect([missing.status, aggregate.status, duplicate.status, malformed.status]).toEqual([400, 400, 400, 400])
    expect([unsafeId.status, tooLong.status, wrongMethod.status]).toEqual([404, 404, 405])
    expect(wrongMethod.headers.get("allow")).toBe("GET")
  })

  it("rewrites profile-scoped rename/delete mutations to the real Hermes REST contract", async () => {
    const observed: Array<{ body: string; method: string; path: string }> = []
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        observed.push({
          body: Buffer.concat(chunks).toString("utf8"),
          method: request.method ?? "",
          path: request.url ?? "",
        })
        response.setHeader("content-type", "application/json")
        response.end('{"ok":true,"title":"نام امن"}')
      })
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const renamed = await fetch(`${base}/api/hermes/sessions/stored-1?profile=research`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  نام امن  " }),
    })
    const deleted = await fetch(`${base}/api/hermes/sessions/stored-1?profile=research`, { method: "DELETE" })
    const [aggregate, injectedBody, tooLong, wrongMethod] = await Promise.all([
      fetch(`${base}/api/hermes/sessions/stored-1?profile=all`, { method: "DELETE" }),
      fetch(`${base}/api/hermes/sessions/stored-1?profile=research`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x", profile: "default" }),
      }),
      fetch(`${base}/api/hermes/sessions/stored-1?profile=research`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x".repeat(101) }),
      }),
      fetch(`${base}/api/hermes/sessions/stored-1?profile=research`),
    ])

    expect([renamed.status, deleted.status]).toEqual([200, 200])
    expect(observed).toEqual([
      {
        body: JSON.stringify({ title: "نام امن", profile: "research" }),
        method: "PATCH",
        path: "/api/sessions/stored-1",
      },
      { body: "", method: "DELETE", path: "/api/sessions/stored-1?profile=research" },
    ])
    expect([aggregate.status, injectedBody.status, tooLong.status, wrongMethod.status]).toEqual([400, 400, 400, 405])
    expect(wrongMethod.headers.get("allow")).toBe("DELETE, PATCH")
  })

  it("enforces endpoint body limits before contacting upstream", async () => {
    let upstreamRequests = 0
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1
      response.end("unexpected")
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))
    const target = new URL("/api/hermes/audio/speak", base)

    const result = await nodeRequest(target, {
      "content-length": String(256 * 1024 + 1),
      "content-type": "application/json",
    }, "POST")

    expect(result.status).toBe(413)
    expect(result.body).toContain("Request body exceeds 262144 bytes")
    expect(upstreamRequests).toBe(0)
  })

  it("allows JSON base64 expansion for a 25 MiB recording but rejects bodies above 35 MiB", async () => {
    const upstream = createServer((_request, response) => response.end("unexpected"))
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))
    const target = new URL("/api/hermes/audio/transcribe", base)
    const expandedRawLimit = Math.ceil((25 * 1024 * 1024) / 3) * 4

    expect(TRANSCRIBE_BODY_LIMIT).toBe(35 * 1024 * 1024)
    expect(expandedRawLimit + 1024).toBeLessThan(TRANSCRIBE_BODY_LIMIT)
    const result = await nodeRequest(target, {
      "content-length": String(TRANSCRIBE_BODY_LIMIT + 1),
      "content-type": "application/json",
    }, "POST")

    expect(result.status).toBe(413)
    expect(result.body).toContain(`Request body exceeds ${TRANSCRIBE_BODY_LIMIT} bytes`)
  })

  it("streams SSE chunks through without waiting for the terminal chunk", async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader("content-type", "text/event-stream")
      response.write("event: delta\ndata: first\n\n")
      setTimeout(() => response.end("event: done\ndata: second\n\n"), 80)
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const response = await fetch(`${base}/api/hermes/http/v1/responses`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(new TextDecoder().decode(first.value)).toContain("data: first")
    expect(first.done).toBe(false)
    await reader!.cancel()
  })

  it("allows only safe dynamic Runs status, event, and stop paths", async () => {
    const observed: Array<{ body: string; method: string; path: string }> = []
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        observed.push({
          body: Buffer.concat(chunks).toString("utf8"),
          method: request.method ?? "",
          path: request.url ?? "",
        })
        if (request.url?.endsWith("/events")) {
          response.setHeader("content-type", "text/event-stream")
          response.end('data: {"event":"run.completed"}\n\n')
        } else {
          response.setHeader("content-type", "application/json")
          response.end('{"ok":true}')
        }
      })
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const [status, events, stop, unsafe, wrongMethod] = await Promise.all([
      fetch(`${base}/api/hermes/http/v1/runs/run_abc-123`),
      fetch(`${base}/api/hermes/http/v1/runs/run_abc-123/events`),
      fetch(`${base}/api/hermes/http/v1/runs/run_abc-123/stop`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      fetch(`${base}/api/hermes/http/v1/runs/run%2Fescape/events`),
      fetch(`${base}/api/hermes/http/v1/runs/run_abc-123/stop`),
    ])

    expect(status.status).toBe(200)
    expect(events.status).toBe(200)
    expect(stop.status).toBe(200)
    expect(unsafe.status).toBe(404)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST")
    expect(observed).toEqual(expect.arrayContaining([
      { body: "", method: "GET", path: "/v1/runs/run_abc-123" },
      { body: "", method: "GET", path: "/v1/runs/run_abc-123/events" },
      { body: "{}", method: "POST", path: "/v1/runs/run_abc-123/stop" },
    ]))
    expect(observed).toHaveLength(3)
  })

  it("keeps the deterministic test endpoints inside the dispatcher", async () => {
    const backend = stubBackend({}, "test")
    const base = await startBff(backend)

    const [status, profiles, models, capabilities] = await Promise.all([
      fetch(`${base}/api/hermes/status`).then((response) => response.json()),
      fetch(`${base}/api/hermes/profiles`).then((response) => response.json()),
      fetch(`${base}/api/hermes/models`).then((response) => response.json()),
      fetch(`${base}/api/hermes/http/v1/capabilities`).then((response) => response.json()),
    ])

    expect(status).toMatchObject({ version: "0.18.2-test", gateway_running: true })
    expect(profiles.profiles[0]).toMatchObject({ name: "default", provider: "openai-codex" })
    expect(models).toMatchObject({ model: "gpt-5.6-sol", provider: "openai-codex" })
    expect(capabilities.streaming).toBe(true)
  })

  it("fails closed for unknown operations and unsupported methods", async () => {
    const base = await startBff(stubBackend())

    const unknown = await fetch(`${base}/api/hermes/files/not-real`)
    const wrongMethod = await fetch(`${base}/api/hermes/bootstrap`, { method: "POST" })
    const wrongFallbackMethod = await fetch(`${base}/api/hermes/http/v1/capabilities`, { method: "POST" })

    expect(unknown.status).toBe(404)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("GET")
    expect(wrongFallbackMethod.status).toBe(405)
    expect(wrongFallbackMethod.headers.get("allow")).toBe("GET, OPTIONS")
  })
})

function stubBackend(target: UpstreamTarget = {}, mode: BackendSnapshot["mode"] = "external"): HermesBffBackend {
  const snapshot: BackendSnapshot = {
    mode,
    state: "ready",
    ready: true,
    contract: 2,
    wsPath: "/api/hermes/ws",
    profile: null,
    capabilities: {
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
      voice: true,
      httpFallback: true,
    },
    backend: { version: mode === "test" ? "0.18.2-test" : "0.18.2" },
    restartCount: 9,
  }
  return { snapshot: () => snapshot, upstream: () => target }
}

async function startBff(backend: HermesBffBackend): Promise<string> {
  let port = 0
  const server = createServer((request, response) => {
    applySecurityHeaders(response)
    if (!validateHttpRequest(request, port)) {
      rejectRequest(response)
      return
    }
    void dispatchHermesBff(request, response, backend).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.statusCode = 404
        response.end()
      }
    })
  })
  const base = await listen(server)
  port = Number(new URL(base).port)
  return base
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server address")
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections()
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function nodeRequest(
  url: URL,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        status: response.statusCode ?? 0,
      }))
    })
    request.once("error", reject)
    request.end()
  })
}
