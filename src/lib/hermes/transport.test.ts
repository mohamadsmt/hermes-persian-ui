import { describe, expect, it, vi } from "vitest"

import { negotiateHttpFallback, parseSse } from "./http-fallback"
import { contentToText, normalizeSessionSnapshot, pendingPromptFromEvent, reduceHermesEventState, emptyHermesEventState } from "./normalize"
import { JsonRpcGatewayClient, HermesRpcError, isMethodNotFound } from "./rpc-client"
import { rawActiveSessionListSchema, rawSessionSnapshotSchema } from "./schemas"
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

describe("Hermes live-session transport", () => {
  it("serializes active-list focus and normalizes runtime and stored identities", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const listing = transport.sessionActiveList("runtime-b")
    const request = await waitForRpcRequest(socket, 0)
    expect(request).toMatchObject({
      method: "session.active_list",
      params: { current_session_id: "runtime-b" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessions: [
          {
            id: "runtime-a",
            session_key: "stored-a",
            status: "idle",
            title: "Research",
            message_count: 3,
            started_at: 10,
            last_active: 20,
          },
          {
            id: "runtime-b",
            session_key: "stored-b",
            current: true,
            status: "waiting",
            preview: "Choose an option",
            model: "gpt-5.6-sol",
          },
        ],
      },
    })

    await expect(listing).resolves.toEqual([
      {
        identity: { runtimeId: "runtime-a", storedId: "stored-a" },
        current: false,
        status: "idle",
        title: "Research",
        messageCount: 3,
        startedAt: 10,
        lastActive: 20,
      },
      {
        identity: { runtimeId: "runtime-b", storedId: "stored-b" },
        current: true,
        status: "waiting",
        preview: "Choose an option",
        model: "gpt-5.6-sol",
        messageCount: 0,
      },
    ])
    transport.disconnect()
  })

  it("normalizes session.activate as an authoritative live snapshot", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const activating = transport.sessionActivate("runtime-b")
    const request = await waitForRpcRequest(socket, 0)
    expect(request).toMatchObject({
      method: "session.activate",
      params: { session_id: "runtime-b" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        session_id: "runtime-b",
        session_key: "stored-b",
        message_count: 1,
        messages: [{ role: "user", text: "continue" }],
        inflight: { user: "continue", assistant: "partial", streaming: true },
        info: { desktop_contract: 2, model: "gpt-5.6-sol" },
        running: true,
        started_at: 42,
        status: "working",
      },
    })

    await expect(activating).resolves.toMatchObject({
      identity: { runtimeId: "runtime-b", storedId: "stored-b" },
      messageCount: 1,
      messages: [{ role: "user", content: "continue" }],
      inflight: { user: "continue", assistant: "partial", streaming: true },
      info: { contract: 2, model: "gpt-5.6-sol" },
      running: true,
      startedAt: 42,
      status: "working",
    })
    transport.disconnect()
  })

  it("preserves method-not-found for ChatShell fallback without disabling sessions", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const activating = transport.sessionActivate("runtime-old")
    const request = await waitForRpcRequest(socket, 0)
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "method not found" },
    })

    const error = await activating.catch((value: unknown) => value)
    expect(isMethodNotFound(error)).toBe(true)
    expect(transport.capabilities.sessions).toBe(true)
    transport.disconnect()
  })

  it("rejects invalid live statuses at the gateway boundary", () => {
    expect(
      rawActiveSessionListSchema.safeParse({
        sessions: [{ id: "runtime-1", session_key: "stored-1", status: "streaming" }],
      }).success,
    ).toBe(false)
  })

  it("keeps live-session methods unsupported in HTTP fallback mode", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/hermes/bootstrap") return httpOnlyBootstrap()
      return jsonResponse({ endpoints: { responses: { method: "POST", path: "/v1/responses" } } })
    }) as typeof fetch
    const transport = new BrowserHermesTransport({ fetch: fetchImpl, reconnect: false })
    await transport.connect()

    await expect(transport.sessionActiveList()).rejects.toThrow(
      "Hermes session.active_list is unavailable in HTTP fallback mode",
    )
    await expect(transport.sessionActivate("runtime-1")).rejects.toThrow(
      "Hermes session.activate is unavailable in HTTP fallback mode",
    )
    transport.disconnect()
  })
})

describe("Hermes slash-command transport", () => {
  it("parses the real pairs/categories/canon/sub catalog envelope", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const catalog = transport.commandCatalog("runtime-1")
    const request = await waitForRpcRequest(socket, 0)
    expect(request).toMatchObject({
      method: "commands.catalog",
      params: { session_id: "runtime-1" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        pairs: [["/help", "Show help"], ["/dynamic-skill", "Dynamic skill"]],
        categories: [{ name: "Info", pairs: [["/help", "Show help"]] }],
        canon: { "/h": "/help", "/help": "/help" },
        sub: { model: ["list", "reset"] },
        skill_count: 1,
        warning: "skill discovery is partial",
      },
    })

    await expect(catalog).resolves.toEqual({
      pairs: [["/help", "Show help"], ["/dynamic-skill", "Dynamic skill"]],
      categories: [{ name: "Info", pairs: [["/help", "Show help"]] }],
      canon: { "/h": "/help", "/help": "/help" },
      sub: { model: ["list", "reset"] },
      skillCount: 1,
      warning: "skill discovery is partial",
    })
    transport.disconnect()
  })

  it("preserves complete.slash display metadata and replace_from", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const completion = transport.completeSlash("runtime-1", "/reasoning h")
    const request = await waitForRpcRequest(socket, 0)
    expect(request).toMatchObject({
      method: "complete.slash",
      params: { session_id: "runtime-1", text: "/reasoning h" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        items: [{ text: "high", display: "high", meta: "Reasoning effort" }],
        replace_from: 11,
      },
    })
    await expect(completion).resolves.toEqual({
      items: [{ text: "high", display: "high", meta: "Reasoning effort" }],
      replaceFrom: 11,
    })
    transport.disconnect()
  })

  it("normalizes plain slash output and preserves a warning", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const execution = transport.executeCommand("runtime-1", "/VERSION")
    const request = await waitForRpcRequest(socket, 0)
    expect(request).toMatchObject({
      method: "slash.exec",
      params: { session_id: "runtime-1", command: "version" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: { output: "Hermes 0.18.2", warning: "newer release available" },
    })
    await expect(execution).resolves.toEqual({
      kind: "output",
      output: "Hermes 0.18.2",
      warning: "newer release available",
      source: "slash.exec",
      resolvedCommand: "/version",
      aliasDepth: 0,
    })
    transport.disconnect()
  })

  it.each([
    [
      "exec output",
      { type: "exec", output: "quick result" },
      { kind: "output", output: "quick result", source: "command.dispatch" },
    ],
    [
      "plugin output",
      { type: "plugin", output: "plugin result" },
      { kind: "output", output: "plugin result", source: "command.dispatch" },
    ],
    [
      "send prompt",
      { type: "send", message: "generated prompt", notice: "Queued" },
      { kind: "send", message: "generated prompt", notice: "Queued", source: "command.dispatch" },
    ],
    [
      "skill prompt",
      { type: "skill", message: "skill prompt", name: "Research" },
      { kind: "send", message: "skill prompt", skillName: "Research", source: "command.dispatch" },
    ],
    [
      "prefill",
      { type: "prefill", message: "restored draft", notice: "History rewound" },
      { kind: "prefill", message: "restored draft", notice: "History rewound", source: "command.dispatch" },
    ],
  ])("falls back to command.dispatch for %s", async (_label, directive, expected) => {
    const { socket, transport } = await connectedGatewayTransport()
    const execution = transport.executeCommand("runtime-1", "/fallback ARG")
    const slashRequest = await waitForRpcRequest(socket, 0)
    socket.receive({
      jsonrpc: "2.0",
      id: slashRequest.id,
      error: { code: 4018, message: "use command.dispatch" },
    })
    const dispatchRequest = await waitForRpcRequest(socket, 1)
    expect(dispatchRequest).toMatchObject({
      method: "command.dispatch",
      params: { session_id: "runtime-1", name: "fallback", arg: "ARG" },
    })
    socket.receive({ jsonrpc: "2.0", id: dispatchRequest.id, result: directive })

    await expect(execution).resolves.toMatchObject({
      ...expected,
      resolvedCommand: "/fallback ARG",
      aliasDepth: 0,
    })
    transport.disconnect()
  })

  it("follows an alias while retaining the original argument", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const execution = transport.executeCommand("runtime-1", "/shortcut report")

    const firstSlash = await waitForRpcRequest(socket, 0)
    socket.receive({ jsonrpc: "2.0", id: firstSlash.id, error: { code: 4018, message: "dispatch" } })
    const firstDispatch = await waitForRpcRequest(socket, 1)
    socket.receive({
      jsonrpc: "2.0",
      id: firstDispatch.id,
      result: { type: "alias", target: "/version", warning: "legacy alias" },
    })

    const targetSlash = await waitForRpcRequest(socket, 2)
    expect(targetSlash).toMatchObject({
      method: "slash.exec",
      params: { command: "version report" },
    })
    socket.receive({ jsonrpc: "2.0", id: targetSlash.id, result: { output: "resolved" } })

    await expect(execution).resolves.toEqual({
      kind: "output",
      output: "resolved",
      warning: "legacy alias",
      source: "slash.exec",
      resolvedCommand: "/version report",
      aliasDepth: 1,
    })
    transport.disconnect()
  })

  it("detects alias loops before issuing another gateway call", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const execution = transport.executeCommand("runtime-1", "/loop-a")

    const slashA = await waitForRpcRequest(socket, 0)
    socket.receive({ jsonrpc: "2.0", id: slashA.id, error: { code: 4018, message: "dispatch" } })
    const dispatchA = await waitForRpcRequest(socket, 1)
    socket.receive({ jsonrpc: "2.0", id: dispatchA.id, result: { type: "alias", target: "loop-b" } })
    const slashB = await waitForRpcRequest(socket, 2)
    socket.receive({ jsonrpc: "2.0", id: slashB.id, error: { code: 4018, message: "dispatch" } })
    const dispatchB = await waitForRpcRequest(socket, 3)
    socket.receive({ jsonrpc: "2.0", id: dispatchB.id, result: { type: "alias", target: "loop-a" } })

    await expect(execution).rejects.toThrow("alias loop detected at /loop-a")
    expect(socket.sent).toHaveLength(4)
    transport.disconnect()
  })

  it("rejects a ninth alias redirect", async () => {
    const { socket, transport } = await connectedGatewayTransport()
    const execution = transport.executeCommand("runtime-1", "/alias-0")

    for (let depth = 0; depth <= 8; depth += 1) {
      const slash = await waitForRpcRequest(socket, depth * 2)
      socket.receive({ jsonrpc: "2.0", id: slash.id, error: { code: 4018, message: "dispatch" } })
      const dispatch = await waitForRpcRequest(socket, depth * 2 + 1)
      socket.receive({
        jsonrpc: "2.0",
        id: dispatch.id,
        result: { type: "alias", target: `alias-${depth + 1}` },
      })
    }

    await expect(execution).rejects.toThrow("alias exceeded 8 redirects")
    expect(socket.sent).toHaveLength(18)
    transport.disconnect()
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

  it("hydrates the v4 repos/groups project tree without flattening its lanes", async () => {
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

    const projects = transport.projects("work")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const overviewRequest = JSON.parse(socket.sent[0] ?? "{}") as {
      id: string
      method: string
      params: Record<string, unknown>
    }
    expect(overviewRequest).toMatchObject({
      method: "projects.tree",
      params: {profile: "work", preview_limit: 3},
    })
    socket.receive({
      jsonrpc: "2.0",
      id: overviewRequest.id,
      result: {
        active_id: "project-1",
        scoped_session_ids: ["session-1"],
        projects: [{
          id: "project-1",
          label: "Hermes UI",
          path: "/workspace/Hermes UI",
          repos: [{
            id: "/workspace/Hermes UI",
            label: "Hermes UI",
            path: "/workspace/Hermes UI",
            groups: [{id: "main", label: "main", sessions: []}],
          }],
          previewSessions: [{id: "session-1", title: "Preview title", last_active: 10}],
        }],
      },
    })

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const detailRequest = JSON.parse(socket.sent[1] ?? "{}") as {
      id: string
      method: string
      params: Record<string, unknown>
    }
    expect(detailRequest).toMatchObject({
      method: "projects.project_sessions",
      params: {profile: "work", project_id: "project-1", session_limit: 5_000},
    })
    socket.receive({
      jsonrpc: "2.0",
      id: detailRequest.id,
      result: {
        project: {
          id: "project-1",
          label: "Hermes UI",
          path: "/workspace/Hermes UI",
          repos: [{
            id: "/workspace/Hermes UI",
            label: "Hermes UI",
            path: "/workspace/Hermes UI",
            groups: [{
              id: "main",
              label: "main",
              sessions: [{
                id: "session-1",
                title: "Hydrated title",
                cwd: "/workspace/Hermes UI",
                last_active: 20,
              }],
            }],
          }],
        },
      },
    })

    await expect(projects).resolves.toEqual({
      activeId: "project-1",
      profile: "work",
      projects: [{
        id: "project-1",
        name: "Hermes UI",
        paths: ["/workspace/Hermes UI"],
        primaryPath: "/workspace/Hermes UI",
        repositories: [{
          id: "/workspace/Hermes UI",
          name: "Hermes UI",
          path: "/workspace/Hermes UI",
          lanes: [{
            id: "main",
            name: "main",
            sessions: [{
              id: "session-1",
              title: "Hydrated title",
              cwd: "/workspace/Hermes UI",
              updatedAt: 20,
            }],
          }],
        }],
      }],
      scopedSessionIds: ["session-1"],
    })
    transport.disconnect()
  })

  it("does not issue drill-in RPCs for projects with an empty overview preview", async () => {
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

    const projects = transport.projects("work")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const overviewRequest = JSON.parse(socket.sent[0] ?? "{}") as {id: string}
    socket.receive({
      jsonrpc: "2.0",
      id: overviewRequest.id,
      result: {
        projects: [
          {
            id: "empty-one",
            label: "Empty one",
            path: "/workspace/empty-one",
            previewSessions: [],
          },
          {
            id: "empty-two",
            label: "Empty two",
            path: "/workspace/empty-two",
          },
        ],
      },
    })

    await expect(projects).resolves.toMatchObject({
      profile: "work",
      projects: [
        {id: "empty-one"},
        {id: "empty-two"},
      ],
    })
    expect(socket.sent).toHaveLength(1)
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

async function connectedGatewayTransport(): Promise<{
  socket: FakeSocket
  transport: BrowserHermesTransport
}> {
  const socket = new FakeSocket()
  const transport = new BrowserHermesTransport({
    fetch: vi.fn().mockResolvedValue(jsonResponse(gatewayBootstrap())) as typeof fetch,
    socketFactory: () => socket as unknown as WebSocket,
    reconnect: false,
  })
  const connected = transport.connect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  socket.open()
  await connected
  return { socket, transport }
}

async function waitForRpcRequest(
  socket: FakeSocket,
  index: number,
): Promise<{
  id: string
  method: string
  params: Record<string, unknown>
}> {
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(index))
  return JSON.parse(socket.sent[index] ?? "{}") as {
    id: string
    method: string
    params: Record<string, unknown>
  }
}

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
