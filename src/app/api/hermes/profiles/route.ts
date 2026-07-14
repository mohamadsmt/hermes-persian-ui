import { json, proxyHermesRequest, testProfilesPayload } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

export function GET(request: Request): Promise<Response> | Response {
  const runtime = requireHermesServerRuntime()
  if (runtime.snapshot().mode === "test") return json(testProfilesPayload())
  return proxyHermesRequest(request, "/api/profiles", { methods: ["GET"] })
}
