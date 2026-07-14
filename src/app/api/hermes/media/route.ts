import { proxyHermesRequest } from "@/lib/server/proxy"

export const dynamic = "force-dynamic"

export function GET(request: Request): Promise<Response> {
  return proxyHermesRequest(request, "/api/media", {
    methods: ["GET"],
    query: new URL(request.url).searchParams,
  })
}
