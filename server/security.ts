import type { IncomingMessage, ServerResponse } from "node:http"
import net from "node:net"

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const SENSITIVE_QUERY_KEYS = new Set(["token", "ticket", "api_key", "key", "secret", "password"])

export function assertLoopbackBind(host: string): void {
  const normalized = host.trim().toLowerCase()
  if (!LOOPBACK_NAMES.has(normalized)) {
    throw new Error(`Refusing non-loopback bind: ${host}. Hermes UI is local-only.`)
  }
}

export function validateHttpRequest(request: IncomingMessage, expectedPort: number): boolean {
  const host = parseAuthority(request.headers.host)
  if (!host || !isLoopbackHostname(host.hostname)) return false
  if (host.port !== null && host.port !== expectedPort) return false

  const origin = request.headers.origin
  if (!origin) return true
  return validateOrigin(origin, expectedPort)
}

export function validateWebSocketRequest(request: IncomingMessage, expectedPort: number, allowMissingOrigin = false): boolean {
  if (!validateHttpRequest(request, expectedPort)) return false
  const origin = request.headers.origin
  return origin ? validateOrigin(origin, expectedPort) : allowMissingOrigin
}

export function applySecurityHeaders(response: ServerResponse, development = false): void {
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
  ].join("; "))
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  response.setHeader("Referrer-Policy", "no-referrer")
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("X-Frame-Options", "DENY")
  response.setHeader("X-Permitted-Cross-Domain-Policies", "none")
}

export function rejectRequest(response: ServerResponse, status = 403, message = "Forbidden"): void {
  applySecurityHeaders(response)
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.end(JSON.stringify({ error: message }))
}

export function redact(value: string): string {
  let output = value
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "[redacted]")
    }
    output = url.toString()
  } catch {
    // It is a log line, not a URL.
  }
  return output
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:token|ticket|api[_-]?key|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
}

function validateOrigin(origin: string, expectedPort: number): boolean {
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (!isLoopbackHostname(parsed.hostname)) return false
    const defaultPort = parsed.protocol === "https:" ? 443 : 80
    return Number(parsed.port || defaultPort) === expectedPort
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (LOOPBACK_NAMES.has(normalized)) return true
  if (net.isIP(normalized) === 4) return normalized.startsWith("127.")
  return normalized === "::1"
}

function parseAuthority(authority: string | undefined): { hostname: string; port: number | null } | null {
  if (!authority) return null
  try {
    const parsed = new URL(`http://${authority}`)
    return { hostname: parsed.hostname, port: parsed.port ? Number(parsed.port) : null }
  } catch {
    return null
  }
}
