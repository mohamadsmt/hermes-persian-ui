import { json, proxyHermesRequest, testModelsPayload } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

export function GET(request: Request): Promise<Response> | Response {
  const runtime = requireHermesServerRuntime()
  if (runtime.snapshot().mode === "test") return json(testModelsPayload())
  return proxyHermesRequest(request, "/api/model/options", {
    methods: ["GET"],
    query: new URL(request.url).searchParams,
  })
}
