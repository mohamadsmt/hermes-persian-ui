import { createServer, type Server } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import { HermesBackendManager } from "../server/backend-manager"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeIdleConnections()
    server.close(() => resolve())
  })))
})

describe("Hermes backend capability probes", () => {
  it("enables voice only when both safe invalid-payload probes reach real audio handlers", async () => {
    const paths: string[] = []
    const server = createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`)
      if (request.url === "/api/status") {
        response.setHeader("content-type", "application/json")
        response.end('{"version":"0.18.2","release_date":"2026-07-13"}')
        return
      }
      if (request.url === "/api/audio/transcribe" || request.url === "/api/audio/speak") {
        response.statusCode = 422
        response.end('{"detail":"validation error"}')
        return
      }
      response.statusCode = 404
      response.end()
    })
    const baseUrl = await listen(server)
    const manager = new HermesBackendManager({
      NODE_ENV: "test",
      HERMES_BACKEND_MODE: "external",
      HERMES_BASE_URL: baseUrl,
      HERMES_API_KEY: "server-only-key",
    })

    await manager.start()

    expect(manager.snapshot()).toMatchObject({
      ready: true,
      backend: { version: "0.18.2", releaseDate: "2026-07-13" },
      capabilities: { gateway: false, httpFallback: true, voice: true },
    })
    expect(paths).toEqual(expect.arrayContaining([
      "GET /api/status",
      "POST /api/audio/transcribe",
      "POST /api/audio/speak",
    ]))
    await manager.stop()
  })

  it("keeps voice hidden when either endpoint is absent", async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/api/audio/transcribe" ? 422 : 404
      response.end()
    })
    const baseUrl = await listen(server)
    const manager = new HermesBackendManager({ NODE_ENV: "test", HERMES_BACKEND_MODE: "external", HERMES_BASE_URL: baseUrl })

    await manager.start()

    expect(manager.snapshot().capabilities.voice).toBe(false)
    await manager.stop()
  })

  it("refuses the deterministic fake backend unless the entrypoint explicitly authorizes it", () => {
    const envWithoutNodeEnv = { HERMES_TEST_MODE: "1" } as unknown as NodeJS.ProcessEnv
    expect(() => new HermesBackendManager(envWithoutNodeEnv))
      .toThrow("available only to an explicitly authorized development/test entrypoint")
    expect(new HermesBackendManager(
      envWithoutNodeEnv,
      { allowTestMode: true },
    ).snapshot().mode).toBe("test")
  })
})

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
