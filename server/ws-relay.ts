import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"

import type { HermesBackendManager } from "./backend-manager.js"

/** 50 MiB PDF attachments expand to ~66.7 MiB when encoded into JSON-RPC base64. */
export const MAX_HERMES_FRAME_BYTES = 70 * 1024 * 1024
const MAX_QUEUED_BYTES = 256 * 1024

/** Injected only by source-level development/test entrypoints. */
export interface TestGatewayAdapter {
  close(): void
  handle(browser: WebSocket, request: IncomingMessage): void
}

export class HermesWebSocketRelay {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_HERMES_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  })

  constructor(
    private readonly backend: HermesBackendManager,
    private readonly testGateway?: TestGatewayAdapter,
  ) {
    if (backend.snapshot().mode === "test" && !testGateway) {
      throw new Error("Hermes test mode requires an explicitly injected deterministic gateway")
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const snapshot = this.backend.snapshot()
    if (!snapshot.ready) {
      rejectUpgrade(socket, 503, "Hermes backend unavailable")
      return
    }
    this.server.handleUpgrade(request, socket, head, (browser) => {
      if (snapshot.mode === "test") {
        this.testGateway?.handle(browser, request)
        return
      }
      this.relay(browser)
    })
  }

  close(): Promise<void> {
    for (const client of this.server.clients) client.close(1001, "server shutdown")
    this.testGateway?.close()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private relay(browser: WebSocket): void {
    const target = this.backend.upstream()
    if (!target.wsUrl) {
      browser.close(1013, "Hermes gateway unavailable")
      return
    }
    const url = new URL(target.wsUrl)
    if (target.token && !url.searchParams.has("token") && !url.searchParams.has("ticket")) {
      url.searchParams.set("token", target.token)
    }
    const upstreamOrigin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`
    const headers: Record<string, string> = { Origin: upstreamOrigin }
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`
    const upstream = new WebSocket(url, {
      headers,
      maxPayload: MAX_HERMES_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    })

    const queued: Array<{ data: Buffer | ArrayBuffer | Buffer[]; binary: boolean }> = []
    let queuedBytes = 0
    browser.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary })
        return
      }
      if (upstream.readyState !== WebSocket.CONNECTING) return
      const size = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength
      queuedBytes += size
      if (queuedBytes > MAX_QUEUED_BYTES) {
        browser.close(1009, "Gateway connection queue exceeded")
        upstream.terminate()
        return
      }
      queued.push({ data, binary })
    })

    upstream.once("open", () => {
      for (const message of queued) upstream.send(message.data, { binary: message.binary })
      queued.length = 0
      queuedBytes = 0
    })
    upstream.on("message", (data, binary) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary })
    })
    upstream.once("error", () => {
      if (browser.readyState < WebSocket.CLOSING) browser.close(1013, "Could not connect to Hermes gateway")
    })
    upstream.once("close", (code) => {
      if (browser.readyState < WebSocket.CLOSING) browser.close(safeCloseCode(code), "Hermes gateway closed")
    })
    browser.once("close", (code) => {
      if (upstream.readyState < WebSocket.CLOSING) upstream.close(safeCloseCode(code), "UI connection closed")
    })
    browser.once("error", () => {
      if (upstream.readyState < WebSocket.CLOSING) upstream.close(1011, "UI connection failed")
    })
  }
}

function safeCloseCode(code: number): number {
  return code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const body = JSON.stringify({ error: message })
  socket.end(
    `HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : "Forbidden"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}
