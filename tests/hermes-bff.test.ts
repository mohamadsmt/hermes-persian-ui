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

  it("provides profile-scoped FTS search with bounded input and text-only highlights", async () => {
    const observed: string[] = []
    const upstream = createServer((request, response) => {
      observed.push(request.url ?? "")
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        results: [{
          session_id: "session-1",
          lineage_root: "root-1",
          snippet: "before >>>matched<<< after <img src=x>",
          role: "assistant",
          source: "cli",
          model: "model-1",
          session_started: 123,
        }],
      }))
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const response = await fetch(`${base}/api/hermes/sessions/search?profile=research&q=match&limit=50&archived=all`)
    const payload = await response.json() as Record<string, unknown>
    const invalid = await Promise.all([
      fetch(`${base}/api/hermes/sessions/search?q=x`),
      fetch(`${base}/api/hermes/sessions/search?profile=all&q=x`),
      fetch(`${base}/api/hermes/sessions/search?profile=research&profile=default&q=x`),
      fetch(`${base}/api/hermes/sessions/search?profile=research&q=x&limit=51`),
      fetch(`${base}/api/hermes/sessions/search?profile=research&q=${"x".repeat(257)}`),
    ])

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      profile: "research",
      query: "match",
      results: [{
        profile: "research",
        sessionId: "session-1",
        lineageRoot: "root-1",
        snippet: "before matched after <img src=x>",
        highlights: [{ start: 7, end: 14 }],
        role: "assistant",
        source: "cli",
        model: "model-1",
        startedAt: 123,
      }],
    })
    expect(observed).toEqual(["/api/sessions/search?profile=research&q=match&limit=50"])
    expect(invalid.map((item) => item.status)).toEqual([400, 400, 400, 400, 400])
  })

  it("roots workspace reads and downloads at the persisted session cwd", async () => {
    const observed: string[] = []
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://upstream")
      observed.push(`${request.method} ${url.pathname}${url.search}`)
      if (url.pathname === "/api/sessions/stored-1") {
        respondJson(response, { id: "stored-1", profile: "research", cwd: "/work/repo" })
        return
      }
      if (url.pathname === "/api/files" && url.searchParams.get("path") === "/work/repo") {
        respondJson(response, { path: "/work/repo", entries: [], root: null })
        return
      }
      if (url.pathname === "/api/files" && url.searchParams.get("path") === "/work/repo/src") {
        respondJson(response, {
          path: "/work/repo/src",
          entries: [
            { name: "a.ts", path: "/work/repo/src/a.ts", is_directory: false, size: 18, mtime: 100, mime_type: "text/plain" },
            { name: "escape.txt", path: "/outside/escape.txt", is_directory: false, size: 1, mtime: 100, mime_type: "text/plain" },
            { name: "config.yaml", path: "/work/repo/src/config.yaml", is_directory: false, size: 1, mtime: 100, mime_type: "text/plain" },
          ],
        })
        return
      }
      if (url.pathname === "/api/files/read") {
        respondJson(response, {
          path: "/work/repo/src/a.ts",
          size: 18,
          mime_type: "text/plain",
          data_url: `data:text/plain;base64,${Buffer.from("export const a = 1\n").toString("base64")}`,
        })
        return
      }
      if (url.pathname === "/api/files/download") {
        response.setHeader("content-type", "text/plain")
        response.setHeader("content-disposition", "attachment; filename=leaked-absolute-path")
        response.end("export const a = 1\n")
        return
      }
      respondJson(response, { detail: `unexpected ${url.pathname}` }, 404)
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase, token: "server-token" }))

    const listed = await fetch(`${base}/api/hermes/workspace/list?profile=research&sessionId=stored-1&path=src&root=/etc`)
    const read = await fetch(`${base}/api/hermes/workspace/read?profile=research&sessionId=stored-1&path=src/a.ts`)
    const downloaded = await fetch(`${base}/api/hermes/workspace/download?profile=research&sessionId=stored-1&path=src/a.ts`)
    const [traversal, sensitive, absolute, mutation, legacy] = await Promise.all([
      fetch(`${base}/api/hermes/workspace/list?profile=research&sessionId=stored-1&path=../etc`),
      fetch(`${base}/api/hermes/workspace/read?profile=research&sessionId=stored-1&path=config.yaml`),
      fetch(`${base}/api/hermes/workspace/list?profile=research&sessionId=stored-1&path=/etc`),
      fetch(`${base}/api/hermes/workspace/list?profile=research&sessionId=stored-1`, { method: "POST" }),
      fetch(`${base}/api/hermes/files/read?path=/etc/passwd`),
    ])
    const listedPayload = await listed.json() as Record<string, unknown>
    const readPayload = await read.json() as Record<string, unknown>

    expect(listedPayload).toEqual({
      profile: "research",
      sessionId: "stored-1",
      path: "src",
      parent: "",
      entries: [{
        name: "a.ts",
        path: "src/a.ts",
        isDirectory: false,
        size: 18,
        modifiedAt: 100,
        mimeType: "text/plain",
        previewable: true,
      }],
    })
    expect(readPayload).toMatchObject({
      profile: "research",
      sessionId: "stored-1",
      file: { path: "src/a.ts", kind: "text", content: "export const a = 1\n", truncated: false },
    })
    expect(await downloaded.text()).toBe("export const a = 1\n")
    expect(downloaded.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''a.ts")
    expect(JSON.stringify(listedPayload) + JSON.stringify(readPayload)).not.toContain("/work/repo")
    expect([traversal.status, sensitive.status, absolute.status, mutation.status, legacy.status]).toEqual([403, 403, 400, 405, 404])
    expect(observed.every((value) => !value.includes("../") && !value.includes("/etc"))).toBe(true)
  })

  it("fails closed when workspace session ownership is absent or cross-profile", async () => {
    const observed: string[] = []
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://upstream")
      observed.push(url.pathname)
      if (url.pathname.endsWith("/missing-owner")) {
        respondJson(response, {id: "missing-owner", cwd: "/work/repo"})
      } else if (url.pathname.endsWith("/other-owner")) {
        respondJson(response, {id: "other-owner", profile: "other", cwd: "/work/repo"})
      } else {
        respondJson(response, {detail: "unexpected"}, 404)
      }
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({httpBaseUrl: upstreamBase}))

    const [missing, other] = await Promise.all([
      fetch(`${base}/api/hermes/workspace/list?profile=research&sessionId=missing-owner`),
      fetch(`${base}/api/hermes/workspace/list?profile=research&sessionId=other-owner`),
    ])

    expect([missing.status, other.status]).toEqual([403, 403])
    expect(observed.sort()).toEqual([
      "/api/sessions/missing-owner",
      "/api/sessions/other-owner",
    ].sort())
  })

  it("canonicalizes a custom new-session CWD without falling back", async () => {
    const observed: string[] = []
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://upstream")
      observed.push(`${url.pathname}${url.search}`)
      if (url.pathname === "/api/profiles") {
        respondJson(response, { profiles: [{ name: "research", path: "/profiles/research" }] })
        return
      }
      if (url.pathname === "/api/files" && url.searchParams.get("path") === "/work/link") {
        respondJson(response, { path: "/work/canonical", entries: [] })
        return
      }
      respondJson(response, { detail: "not found" }, 404)
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase, token: "server-token" }))

    const valid = await fetch(`${base}/api/hermes/workspace/validate?profile=research&cwd=${encodeURIComponent("/work/link")}`)
    const invalid = await fetch(`${base}/api/hermes/workspace/validate?profile=research&cwd=${encodeURIComponent("../work")}`)

    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({
      profile: "research",
      cwdAvailable: true,
      canonicalPath: "/work/canonical",
    })
    expect(invalid.status).toBe(400)
    expect(observed).toEqual([
      "/api/profiles",
      "/api/files?path=%2Fwork%2Flink",
    ])
  })

  it("exposes only safe automation controls and strips profile paths, claims, and delivery targets", async () => {
    const observed: Array<{ body: string; method: string; path: string }> = []
    const job = {
      id: "daily-1",
      profile: "research",
      profile_name: "research",
      hermes_home: "/profiles/research",
      fire_claim: { token: "fire-secret" },
      run_claim: { token: "run-secret" },
      name: "Daily",
      schedule: { kind: "cron", expr: "0 10 * * *" },
      schedule_display: "daily at 10",
      repeat: { times: null, completed: 2 },
      enabled: true,
      state: "scheduled",
      deliver: "telegram:438717122",
      last_run_at: "2026-07-15T10:00:00Z",
      next_run_at: "2026-07-16T10:00:00Z",
      last_error: "Bearer abc123 failed at /Users/private/.hermes/config.yaml",
    }
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        observed.push({ body: Buffer.concat(chunks).toString("utf8"), method: request.method ?? "", path: request.url ?? "" })
        if (request.url?.startsWith("/api/cron/jobs?")) respondJson(response, [job])
        else if (request.url?.includes("/runs")) respondJson(response, { runs: [{ id: "cron_daily-1_1", profile: "research", source: "cron", started_at: 100, ended_at: 110 }] })
        else respondJson(response, { ...job, fire_claim: null, run_claim: null })
      })
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const listed = await fetch(`${base}/api/hermes/automations?profile=research&profile_hint=all`)
    const runs = await fetch(`${base}/api/hermes/automations/daily-1/runs?profile=research&limit=20&full=1`)
    const paused = await fetch(`${base}/api/hermes/automations/daily-1/pause?profile=research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "all", updates: { enabled: false } }),
    })
    const run = await fetch(`${base}/api/hermes/automations/daily-1/run?profile=research`, { method: "POST" })
    const [create, edit, remove, unsafe] = await Promise.all([
      fetch(`${base}/api/hermes/automations?profile=research`, { method: "POST" }),
      fetch(`${base}/api/hermes/automations/daily-1?profile=research`, { method: "PUT" }),
      fetch(`${base}/api/hermes/automations/daily-1?profile=research`, { method: "DELETE" }),
      fetch(`${base}/api/hermes/automations/${encodeURIComponent("../escape")}/pause?profile=research`, { method: "POST" }),
    ])
    const listedText = await listed.text()
    const listedPayload = JSON.parse(listedText) as Record<string, unknown>
    const runPayload = await run.json() as Record<string, unknown>

    expect(listedPayload).toMatchObject({
      profile: "research",
      jobs: [{ id: "daily-1", delivery: "telegram", scheduleDisplay: "daily at 10" }],
    })
    expect(listedText).not.toContain("438717122")
    expect(listedText).not.toContain("profiles/research")
    expect(listedText).not.toContain("fire-secret")
    expect(listedText).not.toContain("run-secret")
    expect(listedText).not.toContain("abc123")
    expect(listedText).not.toContain("/Users/private")
    expect(await runs.json()).toMatchObject({
      profile: "research",
      jobId: "daily-1",
      runs: [{ id: "cron_daily-1_1", jobId: "daily-1", sessionId: "cron_daily-1_1", status: "complete" }],
    })
    expect(paused.status).toBe(200)
    expect(runPayload).toMatchObject({ ok: true, profile: "research", action: "run", queued: true })
    expect([create.status, edit.status, remove.status, unsafe.status]).toEqual([405, 405, 405, 404])
    expect(observed.map((item) => `${item.method} ${item.path}`)).toContain("POST /api/cron/jobs/daily-1/trigger?profile=research")
    expect(observed.find((item) => item.path.includes("/pause"))?.body).toBe("")
  })

  it("lists safe automation outputs without exposing their managed absolute paths", async () => {
    const savedOutput = "# output\nBearer top-secret\ntoken=cron-secret\n/Users/private/.hermes/output.md\n"
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://upstream")
      if (url.pathname === "/api/profiles") {
        respondJson(response, { profiles: [{ name: "research", path: "/profiles/research" }] })
      } else if (url.pathname === "/api/cron/jobs/daily-1") {
        respondJson(response, { id: "canonical-1", profile: "research", name: "Daily" })
      } else if (url.pathname === "/api/files" && url.searchParams.get("path") === "/profiles/research") {
        respondJson(response, { path: "/profiles/research", entries: [] })
      } else if (url.pathname === "/api/files") {
        respondJson(response, {
          path: "/profiles/research/cron/output/canonical-1",
          entries: [
            { name: "2026-07-15_10-00-00.md", path: "/profiles/research/cron/output/canonical-1/2026-07-15_10-00-00.md", is_directory: false, size: 10, mtime: 123 },
            { name: "oversize.md", path: "/profiles/research/cron/output/canonical-1/oversize.md", is_directory: false, size: 600_000, mtime: 123 },
            { name: "escape.md", path: "/outside/escape.md", is_directory: false, size: 10, mtime: 123 },
          ],
        })
      } else if (url.pathname === "/api/files/read") {
        respondJson(response, { data_url: `data:text/markdown;base64,${Buffer.from(savedOutput).toString("base64")}` })
      } else if (url.pathname === "/api/files/download") {
        response.setHeader("content-type", "text/markdown")
        response.end("# output\n")
      } else {
        respondJson(response, { detail: "not found" }, 404)
      }
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const list = await fetch(`${base}/api/hermes/automations/daily-1/outputs?profile=research`)
    const detail = await fetch(`${base}/api/hermes/automations/daily-1/outputs/2026-07-15_10-00-00?profile=research`)
    const download = await fetch(`${base}/api/hermes/automations/daily-1/outputs/2026-07-15_10-00-00/download?profile=research`)
    const listText = await list.text()

    expect(JSON.parse(listText)).toEqual({
      profile: "research",
      jobId: "canonical-1",
      outputs: [{
        id: "2026-07-15_10-00-00",
        name: "2026-07-15_10-00-00.md",
        size: 10,
        modifiedAt: 123,
        createdAt: 123,
        mimeType: "text/markdown",
        downloadUrl: "/api/hermes/automations/canonical-1/outputs/2026-07-15_10-00-00/download?profile=research",
      }],
    })
    expect(listText).not.toContain("/profiles/research")
    const detailText = JSON.stringify(await detail.json())
    const downloadText = await download.text()
    expect(detailText).toContain("# output")
    expect(detailText).toContain("Bearer [redacted]")
    expect(downloadText).toContain("token=[redacted]")
    expect(`${detailText}\n${downloadText}`).not.toContain("top-secret")
    expect(`${detailText}\n${downloadText}`).not.toContain("cron-secret")
    expect(`${detailText}\n${downloadText}`).not.toContain("/Users/private")
    expect(download.headers.get("content-disposition")).toContain("2026-07-15_10-00-00.md")
  })

  it("returns a read-only learning timeline and sanitized pending review records", async () => {
    const pendingRecord = {
      id: "abcdef12",
      subsystem: "memory",
      action: "batch",
      summary: "remember preference",
      origin: "background_review",
      created_at: 123,
      payload: {
        action: "batch",
        target: "user",
        operations: [{ action: "replace", old_text: "old", content: "new" }],
      },
    }
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://upstream")
      if (url.pathname === "/api/learning/graph") {
        respondJson(response, {
          nodes: [
            { id: "skill-one", label: "Skill one", kind: "skill", timestamp: 100, category: "coding", useCount: 2 },
            { id: "memory:memory:0", label: "Memory", kind: "memory", timestamp: 200, category: "memory" },
          ],
          edges: [{ source: "skill-one", target: "memory:memory:0" }],
          clusters: [{ category: "memory", count: 1 }],
          stats: { nodes: 2, ignored: "unsafe" },
        })
      } else if (url.pathname === "/api/learning/node") {
        respondJson(response, { ok: true, id: "memory:memory:0", kind: "memory", label: "Memory", content: "Full memory" })
      } else if (url.pathname === "/api/profiles") {
        respondJson(response, { profiles: [{ name: "research", path: "/profiles/research" }] })
      } else if (url.pathname === "/api/files" && url.searchParams.get("path") === "/profiles/research") {
        respondJson(response, { path: "/profiles/research", entries: [] })
      } else if (url.pathname === "/api/files" && url.searchParams.get("path") === "/profiles/research/pending/memory") {
        respondJson(response, { path: "/profiles/research/pending/memory", entries: [{ name: "abcdef12.json", path: "/profiles/research/pending/memory/abcdef12.json", is_directory: false, size: 200 }] })
      } else if (url.pathname === "/api/files" && url.searchParams.get("path") === "/profiles/research/pending/skills") {
        respondJson(response, { detail: "not found" }, 404)
      } else if (url.pathname === "/api/files/read") {
        respondJson(response, { data_url: `data:application/json;base64,${Buffer.from(JSON.stringify(pendingRecord)).toString("base64")}` })
      } else {
        respondJson(response, { detail: "not found" }, 404)
      }
    })
    const upstreamBase = await listen(upstream)
    const base = await startBff(stubBackend({ httpBaseUrl: upstreamBase }))

    const timeline = await fetch(`${base}/api/hermes/learning/timeline?profile=research`)
    const detail = await fetch(`${base}/api/hermes/learning/detail?profile=research&id=memory%3Amemory%3A0`)
    const pending = await fetch(`${base}/api/hermes/learning/pending?profile=research`)
    const pendingText = await pending.text()
    const [edit, remove, aggregate] = await Promise.all([
      fetch(`${base}/api/hermes/learning/detail?profile=research&id=memory%3Amemory%3A0`, { method: "PUT" }),
      fetch(`${base}/api/hermes/learning/detail?profile=research&id=memory%3Amemory%3A0`, { method: "DELETE" }),
      fetch(`${base}/api/hermes/learning/pending?profile=all`),
    ])

    expect(await timeline.json()).toMatchObject({
      profile: "research",
      items: [
        { id: "memory:memory:0", kind: "memory", timestamp: 200 },
        { id: "skill-one", kind: "skill", timestamp: 100 },
      ],
      stats: { nodes: 2 },
    })
    expect(await detail.json()).toMatchObject({ node: { id: "memory:memory:0", content: "Full memory", truncated: false } })
    expect(JSON.parse(pendingText)).toMatchObject({
      profile: "research",
      pending: [{
        id: "abcdef12",
        kind: "memory",
        title: "remember preference",
        origin: "background_review",
        operations: [{ action: "replace", path: "user", before: "old", after: "new" }],
      }],
    })
    expect(pendingText).not.toContain("/profiles/research")
    expect([edit.status, remove.status, aggregate.status]).toEqual([405, 405, 400])
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

function respondJson(response: import("node:http").ServerResponse, data: unknown, status = 200): void {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(data))
}
