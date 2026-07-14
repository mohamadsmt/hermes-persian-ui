export type HttpFallbackKind = "runs" | "responses" | "chat-completions"

export interface HttpFallbackSelection {
  kind: HttpFallbackKind
  endpoint: string
  capabilities?: Record<string, unknown>
}

export interface HttpFallbackPrompt {
  text: string
  model?: string
  previousResponseId?: string
  metadata?: Record<string, string>
  messages?: Array<{ role: "assistant" | "system" | "user"; content: string }>
  sessionId?: string
}

export type HttpStreamEvent =
  | { type: "text.delta"; text: string; id?: string }
  | { type: "response.complete"; text: string; responseId?: string; id?: string }
  | { type: "error"; message: string; id?: string }
  | { type: "raw"; data: unknown; id?: string; event?: string }

const CANDIDATES: readonly HttpFallbackSelection[] = [
  { kind: "runs", endpoint: "/v1/runs" },
  { kind: "responses", endpoint: "/v1/responses" },
  { kind: "chat-completions", endpoint: "/v1/chat/completions" },
]

export async function negotiateHttpFallback(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<HttpFallbackSelection | null> {
  const capabilities = await fetchImpl("/api/hermes/http/v1/capabilities", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).catch(() => null)

  if (capabilities?.ok) {
    const payload = (await capabilities.json().catch(() => ({}))) as Record<string, unknown>
    const endpoints = capabilityEndpointPaths(payload.endpoints)
    const supported = CANDIDATES.find((candidate) => endpoints.includes(candidate.endpoint))
    if (supported) return { ...supported, capabilities: payload }
  }

  for (const candidate of CANDIDATES) {
    const probe = await fetchImpl(`/api/hermes/http${candidate.endpoint}`, {
      method: "OPTIONS",
      cache: "no-store",
      credentials: "same-origin",
    }).catch(() => null)
    if (probe && probe.status !== 404 && probe.status !== 405 && probe.status < 500) return candidate
  }
  return null
}

export async function streamHttpFallback(
  selection: HttpFallbackSelection,
  prompt: HttpFallbackPrompt,
  onEvent: (event: HttpStreamEvent) => void,
  options: { signal?: AbortSignal; fetch?: typeof fetch; onRunId?: (runId: string) => void } = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  if (selection.kind === "runs") {
    await streamRunsFallback(selection, prompt, onEvent, { ...options, fetch: fetchImpl })
    return
  }
  const body = requestBody(selection.kind, prompt)
  const response = await fetchImpl(`/api/hermes/http${selection.endpoint}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  if (!response.ok) throw new Error(await readHttpError(response))
  if (!response.body) throw new Error("Hermes fallback returned no response stream")

  for await (const event of parseSse(response.body)) {
    if (event.data === "[DONE]") {
      onEvent({ type: "response.complete", text: "", ...(event.id ? { id: event.id } : {}) })
      continue
    }
    let payload: unknown = event.data
    try {
      payload = JSON.parse(event.data)
    } catch {
      // Some compatible servers stream plain text data fields.
    }
    onEvent(normalizeHttpStreamEvent(payload, event))
  }
}

export async function stopHttpFallbackRun(
  runId: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid Hermes run id")
  const response = await fetchImpl(`/api/hermes/http/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  })
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(await readHttpError(response))
  }
}

interface SseMessage {
  data: string
  event?: string
  id?: string
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n")
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const message = parseSseBlock(block)
        if (message) yield message
        boundary = buffer.indexOf("\n\n")
      }
      if (done) break
    }
    const finalMessage = parseSseBlock(buffer)
    if (finalMessage) yield finalMessage
  } finally {
    reader.releaseLock()
  }
}

function parseSseBlock(block: string): SseMessage | null {
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "data") data.push(value)
    if (field === "event") event = value
    if (field === "id") id = value
  }
  if (data.length === 0) return null
  return { data: data.join("\n"), ...(event ? { event } : {}), ...(id ? { id } : {}) }
}

function requestBody(kind: HttpFallbackKind, prompt: HttpFallbackPrompt): Record<string, unknown> {
  if (kind === "chat-completions") {
    return {
      model: prompt.model,
      messages: prompt.messages?.length ? prompt.messages : [{ role: "user", content: prompt.text }],
      stream: true,
    }
  }
  if (kind === "responses") {
    return {
      model: prompt.model,
      input: prompt.text,
      stream: true,
      ...(prompt.previousResponseId ? { previous_response_id: prompt.previousResponseId } : {}),
      ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
    }
  }
  return {
    model: prompt.model,
    input: prompt.text,
    ...(prompt.messages && prompt.messages.length > 1 ? { conversation_history: prompt.messages.slice(0, -1) } : {}),
    ...(prompt.sessionId ? { session_id: prompt.sessionId } : {}),
    ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
  }
}

function normalizeHttpStreamEvent(payload: unknown, source: SseMessage): HttpStreamEvent {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  const choice = Array.isArray(record.choices) && record.choices[0] && typeof record.choices[0] === "object"
    ? (record.choices[0] as Record<string, unknown>)
    : {}
  const delta = choice.delta && typeof choice.delta === "object" ? (choice.delta as Record<string, unknown>) : {}
  const eventName = source.event ?? stringValue(record.event) ?? stringValue(record.type)
  const nestedResponse = record.response && typeof record.response === "object"
    ? (record.response as Record<string, unknown>)
    : {}
  if (record.error) {
    const error = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : {}
    return { type: "error", message: String(error.message ?? record.error), ...(source.id ? { id: source.id } : {}) }
  }
  if (eventName?.includes("failed") || eventName?.includes("error")) {
    return {
      type: "error",
      message: stringValue(record.message) ?? `Hermes fallback event failed: ${eventName}`,
      ...(source.id ? { id: source.id } : {}),
    }
  }
  if (eventName?.includes("cancelled") || eventName?.includes("canceled")) {
    return {
      type: "error",
      message: "Hermes fallback run was cancelled",
      ...(source.id ? { id: source.id } : {}),
    }
  }
  if (eventName?.includes("completed") || eventName?.includes("done")) {
    return {
      type: "response.complete",
      text:
        stringValue(record.output) ??
        stringValue(record.output_text) ??
        stringValue(nestedResponse.output_text) ??
        stringValue(record.text) ??
        "",
      ...(stringValue(record.id) || stringValue(nestedResponse.id)
        ? { responseId: stringValue(record.id) ?? stringValue(nestedResponse.id) }
        : {}),
      ...(source.id ? { id: source.id } : {}),
    }
  }
  const text =
    stringValue(record.delta) ??
    stringValue(delta.content) ??
    stringValue((record.output_text as Record<string, unknown> | undefined)?.delta) ??
    (!eventName || eventName.includes("delta") ? stringValue(record.text) : undefined)
  if (text !== undefined) return { type: "text.delta", text, ...(source.id ? { id: source.id } : {}) }
  return { type: "raw", data: payload, ...(source.id ? { id: source.id } : {}), ...(eventName ? { event: eventName } : {}) }
}

async function streamRunsFallback(
  selection: HttpFallbackSelection,
  prompt: HttpFallbackPrompt,
  onEvent: (event: HttpStreamEvent) => void,
  options: { signal?: AbortSignal; fetch: typeof fetch; onRunId?: (runId: string) => void },
): Promise<void> {
  const response = await options.fetch(`/api/hermes/http${selection.endpoint}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(requestBody("runs", prompt)),
    signal: options.signal,
  })
  if (!response.ok) throw new Error(await readHttpError(response))
  const started = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const runId = stringValue(started?.run_id)
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Hermes Runs fallback returned an invalid run id")
  options.onRunId?.(runId)

  try {
    const events = await options.fetch(`/api/hermes/http/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "text/event-stream" },
      signal: options.signal,
    })
    if (!events.ok) throw new Error(await readHttpError(events))
    if (!events.body) throw new Error("Hermes Runs fallback returned no event stream")
    for await (const event of parseSse(events.body)) {
      let payload: unknown = event.data
      try {
        payload = JSON.parse(event.data)
      } catch {
        // Runs normally emits JSON; keep plain data observable if a compatible server does not.
      }
      onEvent(normalizeHttpStreamEvent(payload, event))
    }
  } catch (error) {
    if (options.signal?.aborted) await stopHttpFallbackRun(runId, options.fetch).catch(() => undefined)
    throw error
  }
}

function capabilityEndpointPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (!value || typeof value !== "object") return []
  const paths: string[] = []
  for (const endpoint of Object.values(value as Record<string, unknown>)) {
    if (typeof endpoint === "string") paths.push(endpoint)
    else if (endpoint && typeof endpoint === "object") {
      const path = stringValue((endpoint as Record<string, unknown>).path)
      if (path) paths.push(path)
    }
  }
  return paths
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

async function readHttpError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  return `Hermes fallback failed (${response.status}): ${text.slice(0, 500) || response.statusText}`
}
