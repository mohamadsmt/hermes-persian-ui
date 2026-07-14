import { jsonError, proxyHermesRequest } from "@/lib/server/proxy"

export const dynamic = "force-dynamic"

const ALLOWED = new Set(["read", "download", "upload", "upload-stream", "mkdir"])

interface RouteContext {
  params: Promise<{ path: string[] }>
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params
  if (path.length !== 1 || !path[0] || !ALLOWED.has(path[0])) return jsonError(404, "Unknown file operation")
  return proxyHermesRequest(request, `/api/files/${path[0]}`, {
    methods: ["GET", "POST", "DELETE"],
    maxBodyBytes: 50 * 1024 * 1024,
    query: new URL(request.url).searchParams,
  })
}

export const GET = proxy
export const POST = proxy
export const DELETE = proxy
