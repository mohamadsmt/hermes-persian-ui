import { json, proxyHermesRequest } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

export function POST(request: Request): Promise<Response> | Response {
  if (requireHermesServerRuntime().snapshot().mode === "test") {
    return json({ ok: true, data_url: "data:audio/wav;base64,UklGRg==", mime_type: "audio/wav", provider: "test" })
  }
  return proxyHermesRequest(request, "/api/audio/speak", { methods: ["POST"], maxBodyBytes: 256 * 1024 })
}
