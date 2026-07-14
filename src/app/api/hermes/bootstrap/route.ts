import { json } from "@/lib/server/proxy"
import { requireHermesServerRuntime } from "@/lib/server/runtime"

export const dynamic = "force-dynamic"

export function GET(): Response {
  const { restartCount: _restartCount, ...bootstrap } = requireHermesServerRuntime().snapshot()
  return json(bootstrap, { status: bootstrap.ready ? 200 : 503 })
}
