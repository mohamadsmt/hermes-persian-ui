import { json, jsonError, proxyHermesRequest } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

const ALLOWED_PATHS = new Set(["v1/capabilities", "v1/runs", "v1/responses", "v1/chat/completions"])

interface RouteContext {
  params: Promise<{ path: string[] }>
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const joined = (await context.params).path.join("/")
  if (!ALLOWED_PATHS.has(joined)) return jsonError(404, "Unknown Hermes fallback endpoint")
  if (requireHermesServerRuntime().snapshot().mode === "test") return testResponse(request, joined)
  return proxyHermesRequest(request, `/${joined}`, {
    methods: ["GET", "POST", "OPTIONS"],
    maxBodyBytes: 2 * 1024 * 1024,
    query: new URL(request.url).searchParams,
  })
}

export const GET = proxy
export const POST = proxy
export const OPTIONS = proxy

function testResponse(request: Request, path: string): Response {
  if (path === "v1/capabilities") {
    return json({ endpoints: ["/v1/runs", "/v1/responses", "/v1/chat/completions"], streaming: true })
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } })
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"پاسخ آزمایشی"}\n\n'))
      controller.enqueue(encoder.encode('event: response.completed\ndata: {"id":"response-test","output_text":"پاسخ آزمایشی"}\n\n'))
      controller.close()
    },
  })
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  })
}
