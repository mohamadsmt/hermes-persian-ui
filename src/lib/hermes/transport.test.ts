import { describe, expect, it, vi } from "vitest"

import { negotiateHttpFallback, parseSse } from "./http-fallback"
import { contentToText, normalizeSessionSnapshot, pendingPromptFromEvent, reduceHermesEventState, emptyHermesEventState } from "./normalize"
import { JsonRpcGatewayClient, HermesRpcError, isMethodNotFound } from "./rpc-client"
import { rawSessionSnapshotSchema } from "./schemas"
import { BrowserHermesTransport } from "./transport"

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  readonly sent: string[] = []

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent("close"))
  }
}

describe("JSON-RPC gateway client", () => {
  it("correlates replies and publishes gateway events", async () => {
    const socket = new FakeSocket()
    const client = new JsonRpcGatewayClient({ socketFactory: () => socket as unknown as WebSocket })
    const events = vi.fn()
    client.onEvent(events)
    const connected = client.connect("ws://localhost/api/hermes/ws")
    socket.open()
    await connected

    const resultPromise = client.request<{ ok: boolean }>("session.list")
    const sent = JSON.parse(socket.sent[0] ?? "{}") as { id: string }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { ok: true } })
    await expect(resultPromise).resolves.toEqual({ ok: true })

    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "runtime-1", payload: { text: "سلام" } },
    })
    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledWith({
        type: "message.delta",
        session_id: "runtime-1",
        payload: { text: "سلام" },
      })
    })
  })

  it("preserves method-not-found codes for capability downgrade", async () => {
    const socket = new FakeSocket()
    const client = new JsonRpcGatewayClient({ socketFactory: () => socket as unknown as WebSocket })
    const connected = client.connect("ws://localhost/api/hermes/ws")
    socket.open()
    await connected

    const resultPromise = client.request("session.branch")
    const sent = JSON.parse(socket.sent[0] ?? "{}") as { id: string }
    socket.receive({ jsonrpc: "2.0", id: sent.id, error: { code: -32601, message: "method not found" } })
    const error = await resultPromise.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HermesRpcError)
    expect(isMethodNotFound(error)).toBe(true)
  })

  it("cancels an in-flight request without accepting its late response", async () => {
    const socket = new FakeSocket()
    const client = new JsonRpcGatewayClient({ socketFactory: () => socket as unknown as WebSocket })
    const connected = client.connect("ws://localhost/api/hermes/ws")
    socket.open()
    await connected

    const controller = new AbortController()
    const resultPromise = client.request("session.history", {}, controller.signal)
    const sent = JSON.parse(socket.sent[0] ?? "{}") as { id: string }
    controller.abort()
    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" })
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { messages: [] } })
    await Promise.resolve()
  })
})

describe("browser transport capabilities and deduplication", () => {
  it("deduplicates semantic events and disables a method-not-found capability", async () => {
    const socket = new FakeSocket()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "test",
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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const transport = new BrowserHermesTransport({
      fetch: fetchImpl,
      socketFactory: () => socket as unknown as WebSocket,
      reconnect: false,
    })
    const events = vi.fn()
    transport.onEvent(events)
    const connected = transport.connect()
    await vi.waitFor(() => expect(transport.connectionState).toBe("connecting"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.open()
    await connected

    const frame = {
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "approval.request",
        session_id: "runtime-1",
        payload: { request_id: "approval-9", description: "test" },
      },
    }
    socket.receive(frame)
    socket.receive(frame)
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1))

    const branch = transport.sessionBranch("runtime-1")
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as { id: string }
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "method not found" },
    })
    await expect(branch).rejects.toBeInstanceOf(HermesRpcError)
    expect(transport.capabilities.branch).toBe(false)
    transport.disconnect()
  })

  it("uses the profile-scoped REST list and rejects untagged or cross-profile rows", async () => {
    const socket = new FakeSocket()
    const responses = [
      jsonResponse(gatewayBootstrap()),
      jsonResponse({
        sessions: [{ id: "research-1", profile: "research", title: "Research" }],
        total: 1,
        profile_totals: { research: 1 },
        limit: 200,
        offset: 0,
        errors: [],
      }),
      jsonResponse({
        sessions: [{ id: "default-1", profile: "default" }],
        total: 1,
        profile_totals: { research: 0 },
        limit: 200,
        offset: 0,
        errors: [],
      }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift() ?? jsonResponse({})) as typeof fetch
    const transport = new BrowserHermesTransport({
      fetch: fetchImpl,
      socketFactory: () => socket as unknown as WebSocket,
      reconnect: false,
    })
    const connected = transport.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.open()
    await connected

    await expect(transport.sessionList({ profile: "research", limit: 999 })).resolves.toEqual([
      expect.objectContaining({ id: "research-1", profile: "research", title: "Research" }),
    ])
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/hermes/sessions?profile=research&limit=200",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    )
    await expect(transport.sessionList({ profile: "research" })).rejects.toThrow(
      "Hermes returned sessions from a different profile",
    )
    await expect(transport.sessionList({ profile: "all" })).rejects.toThrow(
      "A concrete Hermes profile is required",
    )
    await expect(transport.sessionCreate({profile: "all"})).rejects.toThrow(
      "A concrete Hermes profile is required",
    )
    expect(socket.sent).toHaveLength(0)
    transport.disconnect()
  })

  it("fails a profile list when Hermes reports a read error for that profile", async () => {
    const socket = new FakeSocket()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(gatewayBootstrap()))
      .mockResolvedValueOnce(jsonResponse({
        sessions: [],
        total: 0,
        limit: 100,
        offset: 0,
        errors: [{ profile: "research", error: "state.db is locked" }],
      })) as typeof fetch
    const transport = new BrowserHermesTransport({
      fetch: fetchImpl,
      socketFactory: () => socket as unknown as WebSocket,
      reconnect: false,
    })
    const connected = transport.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.open()
    await connected

    await expect(transport.sessionList({ profile: "research" })).rejects.toThrow("state.db is locked")
    transport.disconnect()
  })

  it("reads profile-scoped persisted messages from dashboard and API-server envelopes", async () => {
    const socket = new FakeSocket()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(gatewayBootstrap()))
      .mockResolvedValueOnce(jsonResponse({
        session_id: "continued-1",
        messages: [
          {
            role: "assistant",
            content: "",
            timestamp: 10,
            tool_calls: [{ id: "call-1", function: { name: "terminal", arguments: "{}" } }],
          },
          {
            role: "tool",
            content: "{\"success\":false,\"error\":\"agent not found\"}",
            timestamp: 11,
            tool_call_id: "call-1",
            tool_name: "terminal",
          },
        ],
        pagination: { limit: null, offset: 0, returned: 2 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        object: "list",
        session_id: "api-2",
        data: [{ role: "user", content: [{ type: "text", text: "سلام" }] }],
      })) as typeof fetch
    const transport = new BrowserHermesTransport({
      fetch: fetchImpl,
      socketFactory: () => socket as unknown as WebSocket,
      reconnect: false,
    })
    const connected = transport.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.open()
    await connected

    const dashboard = await transport.sessionMessages("stored with space", "research")
    const apiServer = await transport.sessionMessages("stored-2", "default")

    expect(dashboard).toMatchObject({
      sessionId: "continued-1",
      messages: [
        { role: "assistant", toolCalls: [{ id: "call-1", function: { name: "terminal", arguments: "{}" } }] },
        {
          role: "tool",
          content: "{\"success\":false,\"error\":\"agent not found\"}",
          rawContent: "{\"success\":false,\"error\":\"agent not found\"}",
          toolCallId: "call-1",
          toolName: "terminal",
        },
      ],
    })
    expect(apiServer).toMatchObject({
      sessionId: "api-2",
      messages: [{ role: "user", content: "سلام" }],
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/hermes/sessions/stored%20with%20space/messages?profile=research",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "/api/hermes/sessions/stored-2/messages?profile=default",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    )
    await expect(transport.sessionMessages("stored-2", "all")).rejects.toThrow(
      "A concrete Hermes profile is required",
    )
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    transport.disconnect()
  })

  it("renames and deletes through the profile-scoped BFF without sending a gateway mutation", async () => {
    const socket = new FakeSocket()
    const requests: Array<{ body?: string; method: string; path: string }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      requests.push({ path, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) })
      if (path === "/api/hermes/bootstrap") return jsonResponse(gatewayBootstrap())
      return jsonResponse({ ok: true, ...(method === "PATCH" ? { title: "Research title" } : {}) })
    }) as typeof fetch
    const transport = new BrowserHermesTransport({
      fetch: fetchImpl,
      socketFactory: () => socket as unknown as WebSocket,
      reconnect: false,
    })
    const connected = transport.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.open()
    await connected

    await transport.sessionRename("stored with space", "Research title", "research")
    await transport.sessionDelete("stored with space", "research")

    expect(requests.slice(1)).toEqual([
      {
        body: JSON.stringify({ title: "Research title" }),
        method: "PATCH",
        path: "/api/hermes/sessions/stored%20with%20space?profile=research",
      },
      {
        method: "DELETE",
        path: "/api/hermes/sessions/stored%20with%20space?profile=research",
      },
    ])
    expect(socket.sent).toHaveLength(0)
    transport.disconnect()
  })

  it("keeps active-session rename on RPC so the live runtime receives the title", async () => {
    const socket = new FakeSocket()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(gatewayBootstrap())) as typeof fetch
    const transport = new BrowserHermesTransport({
      fetch: fetchImpl,
      socketFactory: () => socket as unknown as WebSocket,
      reconnect: false,
    })
    const connected = transport.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.open()
    await connected

    const renaming = transport.sessionRename(
      { storedId: "stored-1", runtimeId: "runtime-1" },
      "Live title",
      "research",
    )
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: string
      method: string
      params: Record<string, unknown>
    }
    expect(request).toMatchObject({
      method: "session.title",
      params: { session_id: "runtime-1", title: "Live title" },
    })
    socket.receive({ jsonrpc: "2.0", id: request.id, result: { pending: false, title: "Live title" } })
    await expect(renaming).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    transport.disconnect()
  })

  it("negotiates Runs from the real capabilities shape and streams through a local conversation", async () => {
    const requests: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      requests.push(`${method} ${path}`)
      if (path === "/api/hermes/bootstrap") return httpOnlyBootstrap()
      if (path === "/api/hermes/http/v1/capabilities") {
        return jsonResponse({
          object: "hermes.api_server.capabilities",
          model: "gpt-5.6-sol",
          endpoints: {
            runs: { method: "POST", path: "/v1/runs" },
            run_events: { method: "GET", path: "/v1/runs/{run_id}/events" },
            responses: { method: "POST", path: "/v1/responses" },
          },
        })
      }
      if (path === "/api/hermes/http/v1/runs") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ input: "سلام", model: "gpt-5.6-sol" })
        return jsonResponse({ run_id: "run_1", status: "started" }, 202)
      }
      if (path === "/api/hermes/http/v1/runs/run_1/events") {
        return sseResponse([
          'id: delta-1\ndata: {"event":"message.delta","delta":"سلام"}\n\n',
          'id: done-1\ndata: {"event":"run.completed","output":"سلام"}\n\n',
        ])
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`)
    }) as typeof fetch
    const socketFactory = vi.fn(() => {
      throw new Error("WebSocket must not be created for an HTTP-only backend")
    })
    const transport = new BrowserHermesTransport({ fetch: fetchImpl, socketFactory, reconnect: false })
    const events: Array<{ payload?: unknown; type: string }> = []
    transport.onEvent((event) => events.push(event))

    const bootstrap = await transport.connect()
    expect(socketFactory).not.toHaveBeenCalled()
    expect(bootstrap.capabilities).toMatchObject({
      gateway: false,
      sessions: false,
      attachments: false,
      approvals: false,
      httpFallback: true,
    })
    expect(await transport.models()).toEqual([
      expect.objectContaining({ id: "gpt-5.6-sol", provider: "hermes-api", current: true }),
    ])

    const session = await transport.sessionCreate({profile: "default"})
    expect(session.identity.storedId).toMatch(/^http-/)
    await transport.send(session.identity, "سلام")

    expect(events.map((event) => event.type)).toEqual([
      "message.start",
      "message.delta",
      "message.complete",
    ])
    expect(events[1]?.payload).toMatchObject({ text: "سلام", sse_id: "delta-1" })
    expect(events[2]?.payload).toMatchObject({ text: "سلام", status: "complete", run_id: "run_1" })
    expect((await transport.sessionHistory(session.identity)).map((message) => [message.role, message.content])).toEqual([
      ["user", "سلام"],
      ["assistant", "سلام"],
    ])
    expect(requests).toEqual([
      "GET /api/hermes/bootstrap",
      "GET /api/hermes/http/v1/capabilities",
      "POST /api/hermes/http/v1/runs",
      "GET /api/hermes/http/v1/runs/run_1/events",
    ])
    transport.disconnect()
  })

  it("aborts a Runs stream, asks Hermes to stop, and marks the partial response interrupted", async () => {
    const requests: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      requests.push(`${method} ${path}`)
      if (path === "/api/hermes/bootstrap") return httpOnlyBootstrap()
      if (path === "/api/hermes/http/v1/capabilities") {
        return jsonResponse({ endpoints: { runs: { method: "POST", path: "/v1/runs" } } })
      }
      if (path === "/api/hermes/http/v1/runs") return jsonResponse({ run_id: "run_abort" }, 202)
      if (path === "/api/hermes/http/v1/runs/run_abort/events") {
        const signal = init?.signal
        const encoder = new TextEncoder()
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"event":"message.delta","delta":"نیمه"}\n\n'))
            signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true })
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      if (path === "/api/hermes/http/v1/runs/run_abort/stop") return jsonResponse({ status: "stopping" })
      throw new Error(`Unexpected fetch: ${method} ${path}`)
    }) as typeof fetch
    const transport = new BrowserHermesTransport({ fetch: fetchImpl, reconnect: false })
    const events: Array<{ payload?: unknown; type: string }> = []
    transport.onEvent((event) => events.push(event))
    await transport.connect()
    const session = await transport.sessionCreate({profile: "default"})

    const sending = transport.send(session.identity, "ادامه بده")
    await vi.waitFor(() => expect(events.some((event) => event.type === "message.delta")).toBe(true))
    await transport.stop(session.identity)
    await expect(sending).resolves.toBeUndefined()

    expect(requests).toContain("POST /api/hermes/http/v1/runs/run_abort/stop")
    expect(events.at(-1)).toMatchObject({ type: "message.complete", payload: { text: "نیمه", status: "interrupted" } })
    expect((await transport.sessionHistory(session.identity)).at(-1)).toMatchObject({ role: "assistant", content: "نیمه" })
    transport.disconnect()
  })

  it("falls through capabilities in Runs, Responses, then Chat Completions order", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      endpoints: {
        responses: { method: "POST", path: "/v1/responses" },
        chat: { method: "POST", path: "/v1/chat/completions" },
      },
    })) as typeof fetch

    await expect(negotiateHttpFallback(fetchImpl)).resolves.toMatchObject({
      kind: "responses",
      endpoint: "/v1/responses",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("Hermes normalization", () => {
  it("keeps stable and runtime session identities separate", () => {
    const raw = rawSessionSnapshotSchema.parse({
      session_id: "runtime-7",
      stored_session_id: "stored-42",
      messages: [{ role: "user", content: "سلام Hermes" }],
    })
    const snapshot = normalizeSessionSnapshot(raw)
    expect(snapshot.identity).toEqual({ runtimeId: "runtime-7", storedId: "stored-42" })
    expect(snapshot.messages[0]?.content).toBe("سلام Hermes")
  })

  it("extracts text without injecting BiDi control characters", () => {
    const text = contentToText([{ type: "text", text: "Use مدل gpt-5.6-sol برای task" }])
    expect(text).toBe("Use مدل gpt-5.6-sol برای task")
    expect(text).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u)
  })

  it("keys blocking prompts by their exact request and session", () => {
    const event = {
      id: "e1",
      type: "secret.request" as const,
      sessionId: "runtime-1",
      payload: { request_id: "request-9", name: "API_TOKEN" },
      connectionEpoch: 1,
      receivedAt: 1,
    }
    expect(pendingPromptFromEvent(event)).toEqual({
      kind: "secret",
      requestId: "request-9",
      sessionId: "runtime-1",
      name: "API_TOKEN",
    })
    expect(reduceHermesEventState(emptyHermesEventState, event).prompts).toHaveLength(1)
  })
})

describe("SSE fallback parser", () => {
  it("parses chunked event, id, and multiline data fields", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 7\nevent: response.output_text.delta\ndata: {\"delta\":"))
        controller.enqueue(encoder.encode("\"سلام\"}\ndata: tail\n\n"))
        controller.close()
      },
    })
    const messages = []
    for await (const message of parseSse(stream)) messages.push(message)
    expect(messages).toEqual([
      {
        id: "7",
        event: "response.output_text.delta",
        data: '{"delta":"سلام"}\ntail',
      },
    ])
  })
})

function httpOnlyBootstrap(): Response {
  return jsonResponse({
    mode: "external",
    state: "ready",
    ready: true,
    contract: 2,
    wsPath: "/api/hermes/ws",
    profile: null,
    capabilities: {
      gateway: false,
      sessions: false,
      models: true,
      attachments: false,
      approvals: false,
      clarification: false,
      sudo: false,
      secrets: false,
      branch: false,
      compress: false,
      voice: false,
      httpFallback: true,
    },
  })
}

function gatewayBootstrap() {
  return {
    mode: "external",
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
      voice: false,
      httpFallback: true,
    },
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })
}
