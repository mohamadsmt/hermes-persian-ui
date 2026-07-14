import type { BackendMode, BackendState, BootstrapInfo } from "../hermes/types.js"

export interface UpstreamTarget {
  wsUrl?: string
  httpBaseUrl?: string
  token?: string
  apiKey?: string
}

export interface BackendSnapshot extends BootstrapInfo {
  mode: BackendMode
  state: BackendState
  restartCount: number
}

export interface HermesServerRuntime {
  snapshot(): BackendSnapshot
  upstream(): UpstreamTarget
}

const RUNTIME_KEY = Symbol.for("hermes-ui.server-runtime")

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_KEY]?: HermesServerRuntime
}

export function registerHermesServerRuntime(runtime: HermesServerRuntime): void {
  ;(globalThis as RuntimeGlobal)[RUNTIME_KEY] = runtime
}

export function getHermesServerRuntime(): HermesServerRuntime | null {
  return (globalThis as RuntimeGlobal)[RUNTIME_KEY] ?? null
}

export function requireHermesServerRuntime(): HermesServerRuntime {
  const runtime = getHermesServerRuntime()
  if (!runtime) throw new Error("Hermes server runtime is not initialized")
  return runtime
}
