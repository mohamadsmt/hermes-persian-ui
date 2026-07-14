import { createServer } from "node:http"
import type { Duplex } from "node:stream"

import nextModule from "next/dist/server/next.js"
import type { NextServer, NextServerOptions } from "next/dist/server/next.js"

import { registerHermesServerRuntime } from "../src/lib/server/runtime.js"
import { HermesBackendManager } from "./backend-manager.js"
import { dispatchHermesBff, isHermesBffPath } from "./hermes-bff.js"
import {
  applySecurityHeaders,
  assertLoopbackBind,
  rejectRequest,
  validateHttpRequest,
  validateWebSocketRequest,
} from "./security.js"
import { HermesWebSocketRelay, type TestGatewayAdapter } from "./ws-relay.js"

export interface StartHermesUiServerOptions {
  allowTestMode?: boolean
  dev: boolean
  testGateway?: TestGatewayAdapter
}

export async function startHermesUiServer(options: StartHermesUiServerOptions): Promise<void> {
  const { dev, testGateway } = options
  const host = process.env.HOST?.trim() || "127.0.0.1"
  const requestedPort = parsePort(process.env.PORT)
  assertLoopbackBind(host)

  const backend = new HermesBackendManager(process.env, {
    allowTestMode: options.allowTestMode === true,
  })
  registerHermesServerRuntime(backend)

  const createNextServer = nextModule as unknown as (input: NextServerOptions) => NextServer
  const app = createNextServer({ dev, hostname: host, port: requestedPort })
  const handle = app.getRequestHandler()
  const relay = new HermesWebSocketRelay(backend, testGateway)

  await Promise.all([
    app.prepare(),
    backend.start().catch(() => {
      console.error(`[hermes-ui] backend startup failed: ${backend.snapshot().error ?? "unknown error"}`)
    }),
  ])

  let actualPort = requestedPort
  const server = createServer((request, response) => {
    applySecurityHeaders(response, dev)
    if (!validateHttpRequest(request, actualPort)) {
      rejectRequest(response)
      return
    }
    if (request.url?.split("?", 1)[0] === "/api/hermes/ws") {
      rejectRequest(response, 426, "WebSocket upgrade required")
      return
    }
    if (isHermesBffPath(request)) {
      void dispatchHermesBff(request, response, backend)
      return
    }
    void handle(request, response)
  })

  const nextUpgradeHandler = app.getUpgradeHandler()
  server.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?", 1)[0]
    if (path !== "/api/hermes/ws") {
      if (validateHttpRequest(request, actualPort)) {
        void nextUpgradeHandler(request, socket, head)
      } else {
        socket.destroy()
      }
      return
    }
    const allowMissingOrigin = options.allowTestMode === true && process.env.NODE_ENV === "test"
    if (!validateWebSocketRequest(request, actualPort, allowMissingOrigin)) {
      rejectUpgrade(socket)
      return
    }
    relay.handleUpgrade(request, socket, head)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(requestedPort, host, () => {
      server.off("error", reject)
      const address = server.address()
      if (address && typeof address === "object") actualPort = address.port
      resolve()
    })
  })

  console.log(`[hermes-ui] ready on http://${host}:${actualPort}`)

  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[hermes-ui] shutting down (${signal})`)
    const force = setTimeout(() => process.exit(1), 10_000)
    force.unref()
    server.closeIdleConnections()
    await Promise.allSettled([
      new Promise<void>((resolve) => server.close(() => resolve())),
      relay.close(),
      backend.stop(),
    ])
    clearTimeout(force)
    process.exit(0)
  }

  process.once("SIGINT", () => void shutdown("SIGINT"))
  process.once("SIGTERM", () => void shutdown("SIGTERM"))
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid PORT: ${value}`)
  return port
}

function rejectUpgrade(socket: Duplex): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
}
