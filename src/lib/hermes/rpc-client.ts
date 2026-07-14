import { rawGatewayEventSchema, rpcFrameSchema, type RawGatewayEvent } from "./schemas"
import type { ConnectionState } from "./types"

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const PROMPT_REQUEST_TIMEOUT_MS = 1_800_000

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
  detachAbort?: () => void
}

export class HermesRpcError extends Error {
  readonly code?: number
  readonly data?: unknown
  readonly method: string

  constructor(method: string, message: string, options: { code?: number; data?: unknown } = {}) {
    super(message)
    this.name = "HermesRpcError"
    this.method = method
    this.code = options.code
    this.data = options.data
  }
}

export function isMethodNotFound(error: unknown): boolean {
  return (
    (error instanceof HermesRpcError && error.code === -32601) ||
    /method not found|-32601|unknown method|no such method/i.test(error instanceof Error ? error.message : String(error))
  )
}

export interface RpcClientOptions {
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  socketFactory?: (url: string) => WebSocket
}

export class JsonRpcGatewayClient {
  private socket: WebSocket | null = null
  private state: ConnectionState = "idle"
  private nextRequestId = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: RawGatewayEvent) => void>()
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private messageQueue = Promise.resolve()
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly socketFactory?: (url: string) => WebSocket

  constructor(options: RpcClientOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.socketFactory = options.socketFactory
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  onEvent(listener: (event: RawGatewayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => this.stateListeners.delete(listener)
  }

  async connect(url: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.state === "connecting") throw new Error("Hermes gateway connection already in progress")

    this.setState("connecting")
    const socket = this.socketFactory?.(url) ?? new WebSocket(url)
    this.socket = socket

    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) return
      this.messageQueue = this.messageQueue.then(async () => {
        const text = await toText(message.data)
        this.handleMessage(text)
      })
    })

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setState("closed")
      this.rejectAll(new Error("Hermes gateway connection closed"))
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        if (this.socket === socket) {
          this.socket = null
          socket.close()
        }
        this.setState("error")
        reject(new Error("Timed out connecting to Hermes gateway"))
      }, this.connectTimeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onError)
      }
      const onOpen = () => {
        if (settled || this.socket !== socket) return
        settled = true
        cleanup()
        this.setState("open")
        resolve()
      }
      const onError = () => {
        if (settled || this.socket !== socket) return
        settled = true
        cleanup()
        this.setState("error")
        reject(new Error("Could not connect to Hermes gateway"))
      }

      socket.addEventListener("open", onOpen, { once: true })
      socket.addEventListener("error", onError, { once: true })
    })
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client disconnect")
    this.rejectAll(new Error("Hermes gateway connection closed"))
    this.setState("closed")
  }

  request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Hermes gateway is not connected"))
    }
    if (signal?.aborted) return Promise.reject(abortError())

    const id = `web-${++this.nextRequestId}`
    const timeoutMs = method === "prompt.submit" ? PROMPT_REQUEST_TIMEOUT_MS : this.requestTimeoutMs

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          pending.detachAbort?.()
          reject(new Error(`Hermes request timed out: ${method}`))
        }, timeoutMs)
      }
      if (signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return
          if (pending.timer) clearTimeout(pending.timer)
          reject(abortError())
        }
        signal.addEventListener("abort", onAbort, { once: true })
        pending.detachAbort = () => signal.removeEventListener("abort", onAbort)
      }
      this.pending.set(id, pending)
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch (error) {
        this.clearPending(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleMessage(text: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(text)
    } catch {
      return
    }
    const parsed = rpcFrameSchema.safeParse(decoded)
    if (!parsed.success) return
    const frame = parsed.data

    if (frame.id !== undefined && frame.id !== null) {
      const id = String(frame.id)
      const pending = this.pending.get(id)
      if (!pending) return
      this.clearPending(id)
      if (frame.error) {
        pending.reject(
          new HermesRpcError(pending.method, frame.error.message, {
            ...(frame.error.code === undefined ? {} : { code: frame.error.code }),
            ...(frame.error.data === undefined ? {} : { data: frame.error.data }),
          }),
        )
      } else {
        pending.resolve(frame.result)
      }
      return
    }

    if (frame.method === "event" && frame.params) {
      const event = rawGatewayEventSchema.safeParse(frame.params)
      if (event.success) {
        for (const listener of this.eventListeners) listener(event.data)
      }
    }
  }

  private clearPending(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.detachAbort?.()
    this.pending.delete(id)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.clearPending(id)
      pending.reject(error)
    }
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError")
}

async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") return data
  if (data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  return String(data)
}
