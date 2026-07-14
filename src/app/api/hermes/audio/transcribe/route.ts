import { json, proxyHermesRequest } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

export function POST(request: Request): Promise<Response> | Response {
  if (requireHermesServerRuntime().snapshot().mode === "test") {
    return json({ ok: true, transcript: "صدای آزمایشی", provider: "test" })
  }
  return proxyHermesRequest(request, "/api/audio/transcribe", { methods: ["POST"], maxBodyBytes: 25 * 1024 * 1024 })
}
