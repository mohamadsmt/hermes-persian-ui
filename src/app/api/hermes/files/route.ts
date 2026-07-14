import { proxyHermesRequest } from "@/lib/server/proxy"

export const dynamic = "force-dynamic"

export function GET(request: Request): Promise<Response> {
  return proxyHermesRequest(request, "/api/files", {
    methods: ["GET"],
    query: new URL(request.url).searchParams,
  })
}

export function DELETE(request: Request): Promise<Response> {
  return proxyHermesRequest(request, "/api/files", {
    methods: ["DELETE"],
    query: new URL(request.url).searchParams,
  })
}
