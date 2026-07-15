import { handleSafeHermesRequest, json } from "./safe-bff"
import { requireHermesServerRuntime } from "./runtime"

/** Execute one of the narrow Hermes Workspace BFF routes inside a Next route
 * worker. The custom Node server intercepts these paths in normal operation;
 * keeping equivalent App Router handlers makes standalone route tests and
 * alternate Next deployment modes obey the same boundary. */
export async function handleSafeHermesRoute(request: Request): Promise<Response> {
  if (request.method.toUpperCase() === "POST" && new URL(request.url).pathname.startsWith("/api/hermes/automations/")) {
    const declared = Number(request.headers.get("content-length") ?? 0)
    if (Number.isFinite(declared) && declared > 4 * 1024) {
      return json({ error: "Request body exceeds 4096 bytes" }, { status: 413 })
    }
    if (request.body) {
      const reader = request.body.getReader()
      let total = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > 4 * 1024) {
            await reader.cancel()
            return json({ error: "Request body exceeds 4096 bytes" }, { status: 413 })
          }
        }
      } finally {
        reader.releaseLock()
      }
    }
  }
  const runtime = requireHermesServerRuntime()
  const response = await handleSafeHermesRequest({
    method: request.method.toUpperCase(),
    mode: runtime.snapshot().mode,
    range: request.headers.get("range"),
    signal: request.signal,
    target: runtime.upstream(),
    url: new URL(request.url),
  })
  return response ?? json({ error: "Unknown Hermes endpoint" }, { status: 404 })
}
