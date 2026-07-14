import { json, jsonError, proxyHermesRequest } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function GET(request: Request): Promise<Response> | Response {
  const input = new URL(request.url).searchParams
  const requestedProfiles = input.getAll("profile")
  const profile = requestedProfiles.length === 1 ? requestedProfiles[0]?.trim() ?? "" : ""
  const rawLimit = input.get("limit")
  const parsedLimit = rawLimit === null || rawLimit === "" ? 100 : Number(rawLimit)
  if (
    !PROFILE_NAME_PATTERN.test(profile) ||
    profile === "all" ||
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1
  ) {
    return jsonError(400, "A concrete Hermes profile is required")
  }

  const limit = Math.min(parsedLimit, 200)
  if (requireHermesServerRuntime().snapshot().mode === "test") {
    return json({
      sessions: [],
      total: 0,
      profile_totals: { [profile]: 0 },
      limit,
      offset: 0,
      errors: [],
    })
  }

  return proxyHermesRequest(request, "/api/profiles/sessions", {
    methods: ["GET"],
    query: new URLSearchParams({
      limit: String(limit),
      offset: "0",
      min_messages: "0",
      archived: "exclude",
      order: "recent",
      profile,
      exclude_sources: "tool",
    }),
  })
}
