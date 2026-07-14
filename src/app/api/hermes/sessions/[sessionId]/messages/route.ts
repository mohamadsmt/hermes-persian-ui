import { json, jsonError, proxyHermesRequest } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_SESSION_ID_LENGTH = 256
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u

type RouteContext = { params: Promise<{ sessionId: string }> }

export function GET(request: Request, context: RouteContext): Promise<Response> | Response {
  return readSessionMessages(request, context)
}

async function readSessionMessages(request: Request, context: RouteContext): Promise<Response> {
  const profile = concreteProfile(new URL(request.url))
  const sessionId = safeSessionId((await context.params).sessionId)
  if (!profile || !sessionId) {
    return jsonError(400, "A concrete Hermes profile and safe session id are required")
  }
  if (requireHermesServerRuntime().snapshot().mode === "test") {
    return json({ session_id: sessionId, messages: [] })
  }
  return proxyHermesRequest(request, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    methods: ["GET"],
    // Build the full query server-side. Pagination and cross-profile switches
    // supplied by the browser must never cross this boundary.
    query: new URLSearchParams({ profile }),
  })
}

function concreteProfile(url: URL): string | null {
  const values = url.searchParams.getAll("profile")
  if (values.length !== 1) return null
  const profile = values[0]?.trim() ?? ""
  return PROFILE_NAME_PATTERN.test(profile) && profile !== "all" ? profile : null
}

function safeSessionId(value: string): string | null {
  if (
    !value ||
    value.length > MAX_SESSION_ID_LENGTH ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null
  }
  return value
}
