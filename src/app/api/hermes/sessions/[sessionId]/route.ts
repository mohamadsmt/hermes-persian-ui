import { json, jsonError, proxyHermesRequest } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BODY_LIMIT = 4 * 1024

type RouteContext = { params: Promise<{ sessionId: string }> }

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const profile = concreteProfile(new URL(request.url))
  const sessionId = safeSessionId((await context.params).sessionId)
  if (!profile || !sessionId) return jsonError(400, "A concrete Hermes profile and session id are required")
  if (requireHermesServerRuntime().snapshot().mode === "test") return json({ ok: true })
  return proxyHermesRequest(request, `/api/sessions/${encodeURIComponent(sessionId)}`, {
    methods: ["DELETE"],
    query: new URLSearchParams({ profile }),
  })
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const profile = concreteProfile(new URL(request.url))
  const sessionId = safeSessionId((await context.params).sessionId)
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (!profile || !sessionId || (Number.isFinite(declared) && declared > BODY_LIMIT)) {
    return jsonError(declared > BODY_LIMIT ? 413 : 400, "Invalid profile, session id, or body")
  }
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > BODY_LIMIT) return jsonError(413, "Request body is too large")
  const title = parseTitle(raw)
  if (!title) return jsonError(400, "A non-empty session title of at most 100 characters is required")
  if (requireHermesServerRuntime().snapshot().mode === "test") return json({ ok: true, title })

  const upstreamRequest = new Request(request.url, {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ title, profile }),
    signal: request.signal,
  })
  return proxyHermesRequest(upstreamRequest, `/api/sessions/${encodeURIComponent(sessionId)}`, {
    methods: ["PATCH"],
    maxBodyBytes: BODY_LIMIT,
  })
}

function concreteProfile(url: URL): string | null {
  const values = url.searchParams.getAll("profile")
  if (values.length !== 1) return null
  const profile = values[0]?.trim() ?? ""
  return PROFILE_NAME_PATTERN.test(profile) && profile !== "all" ? profile : null
}

function safeSessionId(value: string): string | null {
  if (!value || value === ".." || value.includes("/") || value.includes("\\")) return null
  return value
}

function parseTitle(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== "title") || typeof record.title !== "string") return null
    const title = record.title.trim()
    return title && title.length <= 100 ? title : null
  } catch {
    return null
  }
}
