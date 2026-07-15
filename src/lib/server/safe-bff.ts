import path from "node:path"

export interface SafeHermesTarget {
  httpBaseUrl?: string
  token?: string
  apiKey?: string
}

export interface SafeHermesRequest {
  method: string
  mode: "managed" | "external" | "test"
  range?: string | null
  signal?: AbortSignal
  target: SafeHermesTarget
  url: URL
}

type JsonObject = Record<string, unknown>

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u
const AUTOMATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const OUTPUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u
const MAX_SEARCH_QUERY = 256
const MAX_SEARCH_RESULTS = 50
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const MAX_PENDING_FILE_BYTES = 256 * 1024
const MAX_PENDING_RECORDS = 100
const MAX_LEARNING_CONTENT = 512 * 1024

const TEST_AUTOMATION_ID = "workspace-daily"
const TEST_AUTOMATION_OUTPUT_ID = "2026-07-15"
const TEST_AUTOMATION_OUTPUT = [
  "# Workspace daily brief",
  "",
  "Deterministic test output for the Hermes Workspace.",
].join("\n")
const TEST_WORKSPACE_PATH = "README.md"
const TEST_WORKSPACE_CONTENT = [
  "# Hermes Workspace",
  "",
  "This deterministic file is available only while HERMES_TEST_MODE is enabled.",
].join("\n")
const TEST_TIMESTAMP = "2026-07-15T09:00:00.000Z"

const RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".env.example", ".go",
  ".h", ".hpp", ".ini", ".java", ".js", ".json", ".jsx", ".log", ".md",
  ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml", ".zsh",
])

const SENSITIVE_BASENAMES = new Set([
  "auth.json",
  "auth.lock",
  "credentials",
  "config.yaml",
  ".anthropic_oauth.json",
  "google_token.json",
  "google_oauth_pending.json",
  "google_oauth.json",
  "webhook_subscriptions.json",
  "bws_cache.json",
  ".git-credentials",
])

const SENSITIVE_DIRECTORIES = new Set([".git", ".gnupg", ".ssh", "mcp-tokens", "pairing"])

/**
 * Resolve the deliberately narrow browser-facing BFF surface. Returning null
 * means the caller should continue with its older Hermes routes.
 */
export async function handleSafeHermesRequest(input: SafeHermesRequest): Promise<Response | null> {
  const pathname = input.url.pathname
  if (pathname === "/api/hermes/sessions/search") {
    return withSafeErrors(() => handleSessionSearch(input))
  }

  const workspaceMatch = /^\/api\/hermes\/workspace\/(validate|list|read|download)$/u.exec(pathname)
  if (workspaceMatch?.[1]) {
    return withSafeErrors(() => handleWorkspace(input, workspaceMatch[1] as WorkspaceOperation))
  }

  if (pathname === "/api/hermes/automations") {
    return withSafeErrors(() => handleAutomationList(input))
  }
  if (pathname.startsWith("/api/hermes/automations/")) {
    return withSafeErrors(() => handleAutomationRoute(input))
  }

  const learningMatch = /^\/api\/hermes\/learning\/(timeline|detail|pending)$/u.exec(pathname)
  if (learningMatch?.[1]) {
    return withSafeErrors(() => handleLearning(input, learningMatch[1] as LearningOperation))
  }

  return null
}

type WorkspaceOperation = "validate" | "list" | "read" | "download"
type LearningOperation = "timeline" | "detail" | "pending"

async function handleSessionSearch(input: SafeHermesRequest): Promise<Response> {
  if (input.method !== "GET") return methodNotAllowed(["GET"])
  const profile = requireConcreteProfile(input.url)
  const query = oneQueryValue(input.url, "q", false)?.trim() ?? ""
  if (query.length > MAX_SEARCH_QUERY || CONTROL_PATTERN.test(query)) {
    throw new SafeBffError(400, `Search query must be at most ${MAX_SEARCH_QUERY} characters`)
  }
  const limit = boundedInteger(input.url, "limit", 20, 1, MAX_SEARCH_RESULTS)
  if (!query) return json({ profile, query, results: [] })
  if (input.mode === "test") return json({ profile, query, results: [] })

  const payload = await upstreamJson(input, "/api/sessions/search", new URLSearchParams({
    profile,
    q: query,
    limit: String(limit),
  }))
  const rawResults = isObject(payload) && Array.isArray(payload.results) ? payload.results : []
  const results = rawResults.slice(0, limit).flatMap((value) => {
    if (!isObject(value)) return []
    const sessionId = safeIdentifier(value.session_id, 256)
    if (!sessionId) return []
    const markedSnippet = cleanText(value.snippet, 4_000)
    const { text, highlights } = parseSnippet(markedSnippet)
    return [{
      profile,
      sessionId,
      lineageRoot: safeIdentifier(value.lineage_root, 256) ?? sessionId,
      snippet: text,
      highlights,
      role: safeEnum(value.role, ["user", "assistant", "tool", "system"]),
      source: cleanLabel(value.source, 80) || null,
      model: cleanLabel(value.model, 160) || null,
      startedAt: safeTimestamp(value.session_started),
    }]
  })
  return json({ profile, query, results })
}

async function handleWorkspace(input: SafeHermesRequest, operation: WorkspaceOperation): Promise<Response> {
  if (input.method !== "GET") return methodNotAllowed(["GET"])
  const profile = requireConcreteProfile(input.url)
  const requestedCwd = oneQueryValue(input.url, "cwd", false)?.trim() ?? ""
  if (operation === "validate" && requestedCwd) {
    if (!isAbsoluteServerPath(requestedCwd) || CONTROL_PATTERN.test(requestedCwd)) {
      throw new SafeBffError(400, "CWD must be an absolute directory path")
    }
    if (input.mode === "test") {
      return json({ profile, cwdAvailable: true, canonicalPath: requestedCwd })
    }
    await resolveProfileHome(input, profile)
    const raw = await managedList(input, requestedCwd)
    const canonicalPath = requireAbsolutePayloadPath(raw.path)
    return json({ profile, cwdAvailable: true, canonicalPath })
  }
  const sessionId = requireSafeQueryId(input.url, "sessionId")
  const relativePath = normalizeRelativePath(oneQueryValue(input.url, "path", false) ?? "")

  if (input.mode === "test") {
    if (operation === "validate") {
      return json({ profile, sessionId, cwdAvailable: true, root: { name: "workspace" } })
    }
    if (operation === "list") {
      return json({
        profile,
        sessionId,
        path: relativePath,
        parent: parentRelativePath(relativePath),
        entries: relativePath ? [] : [testWorkspaceEntry()],
      })
    }
    if (relativePath !== TEST_WORKSPACE_PATH) throw new SafeBffError(404, "Workspace file not found")
    if (operation === "read") {
      return json({
        profile,
        sessionId,
        file: {
          ...testWorkspaceEntry(),
          content: TEST_WORKSPACE_CONTENT,
          kind: "text",
          previewable: true,
          truncated: false,
        },
      })
    }
    return new Response(TEST_WORKSPACE_CONTENT, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(TEST_WORKSPACE_PATH)}`,
        "content-type": "text/markdown; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    })
  }

  const context = await resolveWorkspaceContext(input, profile, sessionId)
  if (operation === "validate") {
    return json({
      profile,
      sessionId,
      cwdAvailable: true,
      root: { name: context.rootName },
    })
  }
  if (operation === "list") return workspaceList(input, context, relativePath)

  const file = await resolveWorkspaceFile(input, context, relativePath)
  if (operation === "download") {
    if ((file.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new SafeBffError(413, "Workspace file is too large to download")
    const upstream = await upstreamFetch(input, "/api/files/download", new URLSearchParams({ path: file.absolutePath }), {
      range: input.range,
    })
    if (!upstream.ok && upstream.status !== 206) throw upstreamFailure(upstream.status)
    const headers = new Headers()
    copyHeader(upstream.headers, headers, "accept-ranges")
    copyHeader(upstream.headers, headers, "content-length")
    copyHeader(upstream.headers, headers, "content-range")
    copyHeader(upstream.headers, headers, "content-type")
    copyHeader(upstream.headers, headers, "etag")
    copyHeader(upstream.headers, headers, "last-modified")
    headers.set("cache-control", "no-store")
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    headers.set("x-content-type-options", "nosniff")
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  const publicEntry = publicWorkspaceEntry(file)
  const previewKind = workspacePreviewKind(file)
  if (previewKind === "metadata") {
    return json({ profile, sessionId, file: { ...publicEntry, kind: "metadata", previewable: false } })
  }
  const raw = await upstreamJson(input, "/api/files/read", new URLSearchParams({ path: file.absolutePath }))
  if (!isObject(raw)) throw new SafeBffError(502, "Hermes returned an invalid workspace file")
  const dataUrl = typeof raw.data_url === "string" ? raw.data_url : ""
  const decoded = decodeDataUrl(dataUrl, previewKind === "text" ? MAX_TEXT_PREVIEW_BYTES : MAX_IMAGE_PREVIEW_BYTES)
  if (previewKind === "text") {
    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes)
    } catch {
      return json({ profile, sessionId, file: { ...publicEntry, kind: "metadata", previewable: false } })
    }
    return json({
      profile,
      sessionId,
      file: { ...publicEntry, kind: "text", previewable: true, content, truncated: false },
    })
  }
  return json({
    profile,
    sessionId,
    file: {
      ...publicEntry,
      kind: "image",
      previewable: true,
      dataUrl: `data:${file.mimeType};base64,${Buffer.from(decoded.bytes).toString("base64")}`,
      truncated: false,
    },
  })
}

function testWorkspaceEntry() {
  return {
    name: TEST_WORKSPACE_PATH,
    path: TEST_WORKSPACE_PATH,
    isDirectory: false,
    size: Buffer.byteLength(TEST_WORKSPACE_CONTENT, "utf8"),
    modifiedAt: Date.parse(TEST_TIMESTAMP),
    mimeType: "text/markdown",
    previewable: true,
  }
}

interface WorkspaceContext {
  profile: string
  sessionId: string
  canonicalRoot: string
  rootName: string
}

interface ResolvedWorkspaceEntry {
  absolutePath: string
  isDirectory: boolean
  mimeType: string | null
  modifiedAt: number | null
  name: string
  path: string
  size: number | null
}

async function resolveWorkspaceContext(
  input: SafeHermesRequest,
  profile: string,
  sessionId: string,
): Promise<WorkspaceContext> {
  const session = await upstreamJson(
    input,
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    new URLSearchParams({ profile }),
  )
  if (!isObject(session)) throw new SafeBffError(502, "Hermes returned an invalid session")
  const ownerProfile = cleanLabel(session.profile ?? session.profile_name, 64)
  if (ownerProfile !== profile) {
    throw new SafeBffError(403, "Session does not belong to the selected profile")
  }
  const cwd = typeof session.cwd === "string" ? session.cwd.trim() : ""
  if (!cwd || !isAbsoluteServerPath(cwd) || CONTROL_PATTERN.test(cwd)) {
    throw new SafeBffError(409, "This session does not have a persisted workspace")
  }
  const root = await managedList(input, cwd)
  const canonicalRoot = requireAbsolutePayloadPath(root.path)
  return {
    profile,
    sessionId,
    canonicalRoot,
    rootName: safeBasename(canonicalRoot),
  }
}

async function workspaceList(
  input: SafeHermesRequest,
  context: WorkspaceContext,
  relativePath: string,
): Promise<Response> {
  const target = joinServerPath(context.canonicalRoot, relativePath)
  const raw = await managedList(input, target)
  const canonicalTarget = requireAbsolutePayloadPath(raw.path)
  if (!pathIsUnder(context.canonicalRoot, canonicalTarget)) throw new SafeBffError(403, "Workspace path escaped its session root")
  const actualRelative = relativeFromRoot(context.canonicalRoot, canonicalTarget)
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).slice(0, 1_000).flatMap((value) => {
    const entry = resolveManagedEntry(value, context.canonicalRoot)
    if (!entry || isSensitiveRelativePath(entry.path)) return []
    return [publicWorkspaceEntry(entry)]
  })
  return json({
    profile: context.profile,
    sessionId: context.sessionId,
    path: actualRelative,
    parent: parentRelativePath(actualRelative),
    entries,
  })
}

async function resolveWorkspaceFile(
  input: SafeHermesRequest,
  context: WorkspaceContext,
  relativePath: string,
): Promise<ResolvedWorkspaceEntry> {
  if (!relativePath) throw new SafeBffError(400, "A workspace file path is required")
  const segments = relativePath.split("/")
  const name = segments.pop() ?? ""
  const parent = segments.join("/")
  const raw = await managedList(input, joinServerPath(context.canonicalRoot, parent))
  const canonicalParent = requireAbsolutePayloadPath(raw.path)
  if (!pathIsUnder(context.canonicalRoot, canonicalParent)) throw new SafeBffError(403, "Workspace path escaped its session root")
  const entry = (Array.isArray(raw.entries) ? raw.entries : [])
    .map((value) => resolveManagedEntry(value, context.canonicalRoot))
    .find((value) => value?.name === name)
  if (!entry || entry.isDirectory || entry.path !== relativePath || isSensitiveRelativePath(entry.path)) {
    throw new SafeBffError(404, "Workspace file not found")
  }
  return entry
}

function resolveManagedEntry(value: unknown, canonicalRoot: string): ResolvedWorkspaceEntry | null {
  if (!isObject(value)) return null
  const absolutePath = typeof value.path === "string" ? value.path : ""
  if (!isAbsoluteServerPath(absolutePath) || !pathIsUnder(canonicalRoot, absolutePath)) return null
  const relative = relativeFromRoot(canonicalRoot, absolutePath)
  if (!relative || isSensitiveRelativePath(relative)) return null
  const name = cleanLabel(value.name, 255)
  if (!name || name !== relative.split("/").at(-1)) return null
  const isDirectory = value.is_directory === true
  return {
    absolutePath,
    isDirectory,
    mimeType: isDirectory ? null : cleanLabel(value.mime_type, 160) || "application/octet-stream",
    modifiedAt: safeNumber(value.mtime),
    name,
    path: relative,
    size: isDirectory ? null : nonNegativeNumber(value.size),
  }
}

function publicWorkspaceEntry(entry: ResolvedWorkspaceEntry) {
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    mimeType: entry.mimeType,
    previewable: workspacePreviewKind(entry) !== "metadata",
  }
}

function workspacePreviewKind(entry: ResolvedWorkspaceEntry): "text" | "image" | "metadata" {
  if (entry.isDirectory || entry.size === null) return "metadata"
  const mime = (entry.mimeType ?? "").toLowerCase()
  if (RASTER_MIME_TYPES.has(mime) && entry.size <= MAX_IMAGE_PREVIEW_BYTES) return "image"
  if (isTextFile(entry.name, mime) && entry.size <= MAX_TEXT_PREVIEW_BYTES) return "text"
  return "metadata"
}

async function handleAutomationList(input: SafeHermesRequest): Promise<Response> {
  if (input.method !== "GET") return methodNotAllowed(["GET"])
  const profile = requireConcreteProfile(input.url)
  if (input.mode === "test") return json({ profile, jobs: [testAutomationJob(profile)] })
  const payload = await upstreamJson(input, "/api/cron/jobs", new URLSearchParams({ profile }))
  const rawJobs = Array.isArray(payload) ? payload : isObject(payload) && Array.isArray(payload.jobs) ? payload.jobs : []
  return json({ profile, jobs: rawJobs.slice(0, 500).flatMap((value) => {
    const job = sanitizeAutomationJob(value, profile)
    return job ? [job] : []
  }) })
}

async function handleAutomationRoute(input: SafeHermesRequest): Promise<Response> {
  const suffix = input.url.pathname.slice("/api/hermes/automations/".length)
  const rawSegments = suffix.split("/")
  const segments = rawSegments.map(decodeSafeSegment)
  if (segments.some((value) => value === null)) throw new SafeBffError(404, "Unknown automation endpoint")
  const [jobIdRaw, operation, outputIdRaw] = segments as Array<string | undefined>
  const jobId = validateAutomationId(jobIdRaw)
  const profile = requireConcreteProfile(input.url)

  if (segments.length === 1) {
    if (input.method !== "GET") return methodNotAllowed(["GET"])
    if (input.mode === "test") {
      requireTestAutomation(jobId)
      return json({ profile, job: testAutomationJob(profile) })
    }
    const raw = await upstreamJson(input, `/api/cron/jobs/${encodeURIComponent(jobId)}`, new URLSearchParams({ profile }))
    const job = sanitizeAutomationJob(raw, profile)
    if (!job) throw new SafeBffError(502, "Hermes returned an invalid automation")
    return json({ profile, job })
  }

  if (segments.length === 2 && operation === "runs") {
    if (input.method !== "GET") return methodNotAllowed(["GET"])
    const limit = boundedInteger(input.url, "limit", 20, 1, 100)
    if (input.mode === "test") {
      requireTestAutomation(jobId)
      return json({
        profile,
        jobId,
        limit,
        runs: [{
          id: "run-2026-07-15",
          jobId,
          profile,
          status: "complete",
          startedAt: TEST_TIMESTAMP,
          finishedAt: "2026-07-15T09:00:12.000Z",
          summary: "Deterministic scheduler run completed.",
        }].slice(0, limit),
      })
    }
    const payload = await upstreamJson(
      input,
      `/api/cron/jobs/${encodeURIComponent(jobId)}/runs`,
      new URLSearchParams({ profile, limit: String(limit) }),
    )
    const rawRuns = isObject(payload) && Array.isArray(payload.runs) ? payload.runs : []
    return json({
      profile,
      jobId,
      limit,
      runs: rawRuns.slice(0, limit).flatMap((value) => {
        const run = sanitizeAutomationRun(value, profile, jobId)
        return run ? [run] : []
      }),
    })
  }

  if (segments.length === 2 && operation === "outputs") {
    if (input.method !== "GET") return methodNotAllowed(["GET"])
    if (input.mode === "test") {
      requireTestAutomation(jobId)
      return json({ profile, jobId, outputs: [testAutomationOutput(profile)] })
    }
    return listAutomationOutputs(input, profile, jobId)
  }

  if (segments.length === 3 && operation === "outputs") {
    if (input.method !== "GET") return methodNotAllowed(["GET"])
    const outputId = validateOutputId(outputIdRaw)
    if (input.mode === "test") {
      requireTestAutomationOutput(jobId, outputId)
      return json({ profile, jobId, output: {...testAutomationOutput(profile), markdown: TEST_AUTOMATION_OUTPUT} })
    }
    return readAutomationOutput(input, profile, jobId, outputId)
  }

  if (segments.length === 4 && operation === "outputs" && segments[3] === "download") {
    if (input.method !== "GET") return methodNotAllowed(["GET"])
    const outputId = validateOutputId(outputIdRaw)
    if (input.mode === "test") {
      requireTestAutomationOutput(jobId, outputId)
      return new Response(TEST_AUTOMATION_OUTPUT, {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${outputId}.md`)}`,
          "content-type": "text/markdown; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      })
    }
    return downloadAutomationOutput(input, profile, jobId, outputId)
  }

  if (segments.length === 2 && operation && ["pause", "resume", "run"].includes(operation)) {
    if (input.method !== "POST") return methodNotAllowed(["POST"])
    if (input.mode === "test") {
      requireTestAutomation(jobId)
      return json({
        ok: true,
        profile,
        action: operation,
        queued: operation === "run",
        job: testAutomationJob(profile, operation === "pause" ? "paused" : "idle"),
      })
    }
    if (operation === "run") {
      const current = await upstreamJson(input, `/api/cron/jobs/${encodeURIComponent(jobId)}`, new URLSearchParams({ profile }))
      if (!isObject(current)) throw new SafeBffError(502, "Hermes returned an invalid automation")
      const state = cleanLabel(current.state, 64).toLowerCase()
      if (current.enabled === false || state === "paused" || state === "disabled") {
        throw new SafeBffError(409, "Paused automations must be resumed before they can run")
      }
      if (state === "running" || state === "executing" || current.run_claim || current.fire_claim) {
        throw new SafeBffError(409, "Automation is already running")
      }
    }
    const upstreamOperation = operation === "run" ? "trigger" : operation
    const payload = await upstreamJson(
      input,
      `/api/cron/jobs/${encodeURIComponent(jobId)}/${upstreamOperation}`,
      new URLSearchParams({ profile }),
      "POST",
    )
    const job = sanitizeAutomationJob(payload, profile)
    if (!job) throw new SafeBffError(502, "Hermes returned an invalid automation")
    return json({ ok: true, profile, action: operation, queued: operation === "run", job })
  }

  throw new SafeBffError(404, "Unknown automation endpoint")
}

function requireTestAutomation(jobId: string): void {
  if (jobId !== TEST_AUTOMATION_ID) throw new SafeBffError(404, "Automation not found")
}

function requireTestAutomationOutput(jobId: string, outputId: string): void {
  requireTestAutomation(jobId)
  if (outputId !== TEST_AUTOMATION_OUTPUT_ID) throw new SafeBffError(404, "Automation output not found")
}

function testAutomationJob(profile: string, state: "idle" | "paused" = "idle") {
  return {
    id: TEST_AUTOMATION_ID,
    profile,
    name: "Workspace daily brief",
    schedule: "0 9 * * *",
    scheduleDisplay: "Every day at 09:00",
    enabled: state !== "paused",
    running: false,
    state,
    delivery: "local",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    lastRunAt: TEST_TIMESTAMP,
    nextRunAt: "2026-07-16T09:00:00.000Z",
    lastStatus: "complete",
  }
}

function testAutomationOutput(profile: string) {
  return {
    id: TEST_AUTOMATION_OUTPUT_ID,
    jobId: TEST_AUTOMATION_ID,
    name: `${TEST_AUTOMATION_OUTPUT_ID}.md`,
    createdAt: TEST_TIMESTAMP,
    size: Buffer.byteLength(TEST_AUTOMATION_OUTPUT, "utf8"),
    downloadUrl: `/api/hermes/automations/${TEST_AUTOMATION_ID}/outputs/${TEST_AUTOMATION_OUTPUT_ID}/download?profile=${encodeURIComponent(profile)}`,
  }
}

async function listAutomationOutputs(
  input: SafeHermesRequest,
  profile: string,
  requestedJobId: string,
): Promise<Response> {
  const { canonicalJobId, outputRoot, profileRoot } = await resolveAutomationOutputRoot(input, profile, requestedJobId)
  let raw: JsonObject
  try {
    raw = await managedList(input, outputRoot)
  } catch (error) {
    if (error instanceof SafeBffError && error.status === 404) {
      return json({ profile, jobId: canonicalJobId, outputs: [] })
    }
    throw error
  }
  const canonicalRoot = requireAbsolutePayloadPath(raw.path)
  if (!pathIsUnder(profileRoot, canonicalRoot)) throw new SafeBffError(403, "Automation output escaped its profile root")
  const outputs = (Array.isArray(raw.entries) ? raw.entries : []).slice(0, 500).flatMap((value) => {
    if (!isObject(value) || value.is_directory === true) return []
    const name = cleanLabel(value.name, 160)
    if (!name.endsWith(".md")) return []
    const id = name.slice(0, -3)
    if (!OUTPUT_ID_PATTERN.test(id)) return []
    const absolutePath = typeof value.path === "string" ? value.path : ""
    if (!pathIsUnder(canonicalRoot, absolutePath)) return []
    const size = nonNegativeNumber(value.size)
    if (size === null || size > MAX_TEXT_PREVIEW_BYTES) return []
    return [{
      id,
      name,
      size,
      modifiedAt: safeNumber(value.mtime),
      createdAt: safeNumber(value.mtime),
      mimeType: "text/markdown",
      downloadUrl: `/api/hermes/automations/${encodeURIComponent(canonicalJobId)}/outputs/${encodeURIComponent(id)}/download?profile=${encodeURIComponent(profile)}`,
    }]
  }).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 100)
  return json({ profile, jobId: canonicalJobId, outputs })
}

async function downloadAutomationOutput(
  input: SafeHermesRequest,
  profile: string,
  requestedJobId: string,
  outputId: string,
): Promise<Response> {
  const { outputRoot, profileRoot } = await resolveAutomationOutputRoot(input, profile, requestedJobId)
  const rawList = await managedList(input, outputRoot)
  const canonicalRoot = requireAbsolutePayloadPath(rawList.path)
  if (!pathIsUnder(profileRoot, canonicalRoot)) throw new SafeBffError(403, "Automation output escaped its profile root")
  const expectedName = `${outputId}.md`
  const entry = (Array.isArray(rawList.entries) ? rawList.entries : []).find((value) => {
    if (!isObject(value) || value.is_directory === true || value.name !== expectedName) return false
    return typeof value.path === "string" && pathIsUnder(canonicalRoot, value.path)
  })
  if (!isObject(entry)) throw new SafeBffError(404, "Automation output not found")
  const size = nonNegativeNumber(entry.size)
  if (size === null || size > MAX_TEXT_PREVIEW_BYTES) throw new SafeBffError(413, "Automation output is too large")
  const absolutePath = requireAbsolutePayloadPath(entry.path)
  const content = await readAutomationMarkdown(input, absolutePath)
  const headers = new Headers({
    "cache-control": "no-store",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(expectedName)}`,
    "content-type": "text/markdown; charset=utf-8",
    "x-content-type-options": "nosniff",
  })
  return new Response(content, {status: 200, headers})
}

async function readAutomationOutput(
  input: SafeHermesRequest,
  profile: string,
  requestedJobId: string,
  outputId: string,
): Promise<Response> {
  const { canonicalJobId, outputRoot, profileRoot } = await resolveAutomationOutputRoot(input, profile, requestedJobId)
  const rawList = await managedList(input, outputRoot)
  const canonicalRoot = requireAbsolutePayloadPath(rawList.path)
  if (!pathIsUnder(profileRoot, canonicalRoot)) throw new SafeBffError(403, "Automation output escaped its profile root")
  const expectedName = `${outputId}.md`
  const entry = (Array.isArray(rawList.entries) ? rawList.entries : []).find((value) => {
    if (!isObject(value) || value.is_directory === true || value.name !== expectedName) return false
    return typeof value.path === "string" && pathIsUnder(canonicalRoot, value.path)
  })
  if (!isObject(entry)) throw new SafeBffError(404, "Automation output not found")
  const size = nonNegativeNumber(entry.size)
  if (size === null || size > MAX_TEXT_PREVIEW_BYTES) throw new SafeBffError(413, "Automation output is too large")
  const absolutePath = requireAbsolutePayloadPath(entry.path)
  const content = await readAutomationMarkdown(input, absolutePath)
  return json({
    profile,
    jobId: canonicalJobId,
    output: {
      id: outputId,
      name: expectedName,
      size,
      modifiedAt: safeNumber(entry.mtime),
      mimeType: "text/markdown",
      content,
      truncated: false,
    },
  })
}

async function readAutomationMarkdown(input: SafeHermesRequest, absolutePath: string): Promise<string> {
  const raw = await upstreamJson(input, "/api/files/read", new URLSearchParams({ path: absolutePath }))
  if (!isObject(raw) || typeof raw.data_url !== "string") throw new SafeBffError(502, "Hermes returned an invalid automation output")
  const decoded = decodeDataUrl(raw.data_url, MAX_TEXT_PREVIEW_BYTES)
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes)
  } catch {
    throw new SafeBffError(422, "Automation output is not valid UTF-8 Markdown")
  }
  return scrubAutomationMarkdown(content)
}

async function resolveAutomationOutputRoot(
  input: SafeHermesRequest,
  profile: string,
  requestedJobId: string,
): Promise<{ canonicalJobId: string; outputRoot: string; profileRoot: string }> {
  const [profileHome, rawJob] = await Promise.all([
    resolveProfileHome(input, profile),
    upstreamJson(input, `/api/cron/jobs/${encodeURIComponent(requestedJobId)}`, new URLSearchParams({ profile })),
  ])
  if (!isObject(rawJob)) throw new SafeBffError(502, "Hermes returned an invalid automation")
  const canonicalJobId = validateAutomationId(cleanLabel(rawJob.id, 128))
  const profileRoot = requireAbsolutePayloadPath((await managedList(input, profileHome)).path)
  return { canonicalJobId, outputRoot: joinServerPath(profileRoot, `cron/output/${canonicalJobId}`), profileRoot }
}

function sanitizeAutomationJob(value: unknown, profile: string): JsonObject | null {
  if (!isObject(value)) return null
  const id = safeAutomationId(value.id)
  if (!id) return null
  const sourceProfile = cleanLabel(value.profile ?? value.profile_name, 64)
  if (sourceProfile && sourceProfile !== profile) return null
  const enabled = value.enabled === true
  const persistedState = cleanLabel(value.state, 64).toLowerCase()
  const running =
    persistedState === "running" ||
    isObject(value.run_claim) ||
    isObject(value.fire_claim)
  const state = !enabled
    ? "paused"
    : running
      ? "running"
      : persistedState === "error" || persistedState === "failed"
        ? "error"
        : "idle"
  return {
    id,
    profile,
    name: cleanLabel(value.name, 200) || id,
    schedule: sanitizeStructuredValue(value.schedule, 2),
    scheduleDisplay: cleanText(value.schedule_display, 240) || null,
    repeat: sanitizeStructuredValue(value.repeat, 2),
    enabled,
    running,
    state,
    delivery: deliveryKind(value.deliver),
    model: cleanLabel(value.model, 160) || null,
    provider: cleanLabel(value.provider, 120) || null,
    noAgent: value.no_agent === true,
    skills: safeStringArray(value.skills ?? value.skill, 50, 120),
    contextFrom: safeStringArray(value.context_from, 50, 128),
    enabledToolsets: safeStringArray(value.enabled_toolsets, 50, 128),
    createdAt: safeIsoDate(value.created_at),
    lastRunAt: safeIsoDate(value.last_run_at),
    nextRunAt: safeIsoDate(value.next_run_at),
    lastStatus: cleanLabel(value.last_status, 64) || null,
    lastError: scrubDiagnostic(value.last_error),
    lastDeliveryError: scrubDiagnostic(value.last_delivery_error),
    pausedAt: safeIsoDate(value.paused_at),
    pausedReason: scrubDiagnostic(value.paused_reason),
  }
}

function sanitizeAutomationRun(value: unknown, profile: string, jobId: string): JsonObject | null {
  if (!isObject(value)) return null
  const sessionId = safeIdentifier(value.id ?? value.session_id, 256)
  if (!sessionId) return null
  const sourceProfile = cleanLabel(value.profile, 64)
  if (sourceProfile && sourceProfile !== profile) return null
  return {
    id: sessionId,
    jobId,
    sessionId,
    profile,
    title: cleanText(value.title, 300) || null,
    source: cleanLabel(value.source, 64) || "cron",
    model: cleanLabel(value.model, 160) || null,
    provider: cleanLabel(value.provider, 120) || null,
    startedAt: safeTimestamp(value.started_at),
    lastActiveAt: safeTimestamp(value.last_active),
    endedAt: safeTimestamp(value.ended_at),
    finishedAt: safeTimestamp(value.ended_at),
    status: value.is_active === true ? "running" : cleanLabel(value.end_reason, 120) || "complete",
    isActive: value.is_active === true,
    archived: value.archived === true,
    messageCount: nonNegativeNumber(value.message_count),
    endReason: cleanLabel(value.end_reason, 120) || null,
  }
}

async function handleLearning(input: SafeHermesRequest, operation: LearningOperation): Promise<Response> {
  if (input.method !== "GET") return methodNotAllowed(["GET"])
  const profile = requireConcreteProfile(input.url)
  if (input.mode === "test") {
    if (operation === "timeline") {
      return json({
        profile,
        items: testLearningNodes(),
        edges: [{source: "memory-workspace", target: "skill-automation-review"}],
        clusters: [{category: "memory", count: 1}, {category: "skill", count: 1}],
        stats: {memory: 1, skills: 1},
      })
    }
    if (operation === "pending") return json({ profile, pending: testPendingWrites() })
    const id = requireLearningNodeQuery(input.url)
    const node = testLearningNodes().find((item) => item.id === id)
    if (!node) throw new SafeBffError(404, "Learning node not found")
    return json({
      profile,
      node: {
        ...node,
        content: node.kind === "memory"
          ? "Keep workspace reads profile-scoped and fail closed on ambiguous ownership."
          : "Review only one pending automation learning write at a time.",
        metadata: {source: "deterministic-test-fixture"},
      },
    })
  }
  if (operation === "timeline") return learningTimeline(input, profile)
  if (operation === "detail") return learningDetail(input, profile)
  return learningPending(input, profile)
}

function testLearningNodes() {
  return [
    {
      id: "memory-workspace",
      kind: "memory" as const,
      label: "Workspace conventions",
      summary: "Profile-scoped workspace safety conventions.",
      timestamp: "2026-07-15T08:30:00.000Z",
      category: "memory",
    },
    {
      id: "skill-automation-review",
      kind: "skill" as const,
      label: "Safe automation review",
      summary: "Read-only automation review guidance.",
      timestamp: "2026-07-14T16:00:00.000Z",
      category: "skill",
    },
  ]
}

function testPendingWrites() {
  return [
    {
      id: "memory-test",
      kind: "memory",
      title: "Remember workspace ownership",
      summary: "A deterministic pending memory write.",
      origin: "session-test",
      createdAt: TEST_TIMESTAMP,
      operations: [{
        action: "replace",
        path: "workspace/ownership",
        before: "Infer the active profile.",
        after: "Require the owning profile explicitly.",
      }],
    },
    {
      id: "skill-test",
      kind: "skill",
      title: "Review automation output safely",
      summary: "A deterministic pending skill write.",
      origin: "session-test",
      createdAt: "2026-07-15T08:45:00.000Z",
      operations: [],
    },
  ]
}

async function learningTimeline(input: SafeHermesRequest, profile: string): Promise<Response> {
  const payload = await upstreamJson(input, "/api/learning/graph", new URLSearchParams({ profile }))
  if (!isObject(payload)) throw new SafeBffError(502, "Hermes returned an invalid learning timeline")
  const items = (Array.isArray(payload.nodes) ? payload.nodes : []).slice(0, 2_000).flatMap((value) => {
    if (!isObject(value)) return []
    const id = safeLearningNodeId(value.id)
    const kind = value.kind === "memory" ? "memory" : value.kind === "skill" ? "skill" : null
    if (!id || !kind) return []
    return [{
      id,
      kind,
      label: cleanText(value.label, 300) || id,
      timestamp: safeTimestamp(value.timestamp),
      category: cleanLabel(value.category, 120) || kind,
      useCount: nonNegativeNumber(value.useCount),
      state: cleanLabel(value.state, 64) || null,
      createdBy: cleanLabel(value.createdBy, 80) || null,
      pinned: value.pinned === true,
    }]
  }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  const validIds = new Set(items.map((item) => item.id))
  const edges = (Array.isArray(payload.edges) ? payload.edges : []).flatMap((value) => {
    if (!isObject(value)) return []
    const source = safeLearningNodeId(value.source)
    const target = safeLearningNodeId(value.target)
    return source && target && validIds.has(source) && validIds.has(target) ? [{ source, target }] : []
  }).slice(0, 2_000)
  const clusters = (Array.isArray(payload.clusters) ? payload.clusters : []).flatMap((value) => {
    if (!isObject(value)) return []
    const category = cleanLabel(value.category, 120)
    const count = nonNegativeNumber(value.count)
    return category && count !== null ? [{ category, count }] : []
  }).slice(0, 200)
  return json({ profile, items, edges, clusters, stats: sanitizeNumericStats(payload.stats) })
}

async function learningDetail(input: SafeHermesRequest, profile: string): Promise<Response> {
  const id = requireLearningNodeQuery(input.url)
  const payload = await upstreamJson(input, "/api/learning/node", new URLSearchParams({ profile, id }))
  if (!isObject(payload) || payload.ok !== true) throw new SafeBffError(404, "Learning node not found")
  const returnedId = safeLearningNodeId(payload.id)
  if (!returnedId || returnedId !== id) throw new SafeBffError(502, "Hermes returned an invalid learning node")
  if (payload.kind !== "memory" && payload.kind !== "skill") {
    throw new SafeBffError(502, "Hermes returned an invalid learning node")
  }
  const rawContent = typeof payload.content === "string" ? payload.content : ""
  const bytes = Buffer.byteLength(rawContent, "utf8")
  const truncated = bytes > MAX_LEARNING_CONTENT
  const content = truncated ? truncateUtf8(rawContent, MAX_LEARNING_CONTENT) : rawContent
  return json({
    profile,
    node: {
      id,
      kind: payload.kind,
      label: cleanText(payload.label, 300) || id,
      content,
      truncated,
    },
  })
}

async function learningPending(input: SafeHermesRequest, profile: string): Promise<Response> {
  const profileHome = await resolveProfileHome(input, profile)
  const canonicalProfileHome = requireAbsolutePayloadPath((await managedList(input, profileHome)).path)
  const pending: JsonObject[] = []
  for (const subsystem of ["memory", "skills"] as const) {
    if (pending.length >= MAX_PENDING_RECORDS) break
    const directory = joinServerPath(canonicalProfileHome, `pending/${subsystem}`)
    let raw: JsonObject
    try {
      raw = await managedList(input, directory)
    } catch (error) {
      if (error instanceof SafeBffError && error.status === 404) continue
      throw error
    }
    const canonicalPendingRoot = requireAbsolutePayloadPath(raw.path)
    if (!pathIsUnder(canonicalProfileHome, canonicalPendingRoot)) throw new SafeBffError(403, "Pending store escaped its profile root")
    const entries = Array.isArray(raw.entries) ? raw.entries : []
    for (const value of entries) {
      if (pending.length >= MAX_PENDING_RECORDS || !isObject(value) || value.is_directory === true) continue
      const name = cleanLabel(value.name, 80)
      const match = /^([0-9a-f]{8})\.json$/u.exec(name)
      const size = nonNegativeNumber(value.size)
      const absolutePath = typeof value.path === "string" ? value.path : ""
      if (!match?.[1] || size === null || size > MAX_PENDING_FILE_BYTES || !pathIsUnder(canonicalPendingRoot, absolutePath)) continue
      const rawRecord = await upstreamJson(input, "/api/files/read", new URLSearchParams({ path: absolutePath }))
      if (!isObject(rawRecord) || typeof rawRecord.data_url !== "string") continue
      let record: unknown
      try {
        const decoded = decodeDataUrl(rawRecord.data_url, MAX_PENDING_FILE_BYTES)
        record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes)) as unknown
      } catch {
        continue
      }
      const sanitized = sanitizePendingRecord(record, subsystem, match[1])
      if (sanitized) pending.push(sanitized)
    }
  }
  pending.sort((a, b) => (safeNumber(a.createdAt) ?? 0) - (safeNumber(b.createdAt) ?? 0))
  return json({ profile, pending })
}

function sanitizePendingRecord(value: unknown, subsystem: "memory" | "skills", expectedId: string): JsonObject | null {
  if (!isObject(value) || value.id !== expectedId || value.subsystem !== subsystem || !isObject(value.payload)) return null
  const action = cleanLabel(value.action ?? value.payload.action, 40)
  if (!action) return null
  const common = {
    id: expectedId,
    subsystem: subsystem === "skills" ? "skill" : "memory",
    action,
    summary: cleanText(value.summary, 1_000),
    origin: value.origin === "background_review" ? "background_review" : "foreground",
    createdAt: safeTimestamp(value.created_at),
  }
  if (subsystem === "memory") {
    const target = value.payload.target === "user" ? "user" : "memory"
    const rawOperations = value.payload.action === "batch" && Array.isArray(value.payload.operations)
      ? value.payload.operations.slice(0, 50)
      : [value.payload]
    const operations = rawOperations.flatMap((operation) => {
      if (!isObject(operation)) return []
      const operationAction = safeEnum(operation.action, ["add", "replace", "remove"])
      if (!operationAction) return []
      return [{
        action: operationAction,
        content: cleanText(operation.content, 16_000),
        oldText: cleanText(operation.old_text, 16_000),
      }]
    })
    const publicOperations = operations.map((operation) => ({
      action: operation.action,
      path: target,
      before: operation.oldText,
      after: operation.content,
    }))
    return {
      ...common,
      kind: "memory",
      title: cleanText(value.summary, 300) || expectedId,
      operations: publicOperations,
      review: { kind: "memory", target, operations },
    }
  }
  const payload = value.payload
  const filePath = safeRelativeReviewPath(payload.file_path)
  return {
    ...common,
    kind: "skill",
    title: cleanLabel(payload.name, 200) || cleanText(value.summary, 300) || expectedId,
    operations: [{
      action,
      path: filePath ?? (cleanLabel(payload.name, 200) || undefined),
      before: "",
      after: "",
    }],
    review: {
      kind: "skill",
      skillName: cleanLabel(payload.name, 200) || null,
      action: cleanLabel(payload.action, 40) || action,
      filePath,
      requiresDiff: true,
    },
  }
}

async function resolveProfileHome(input: SafeHermesRequest, profile: string): Promise<string> {
  const payload = await upstreamJson(input, "/api/profiles")
  const profiles = isObject(payload) && Array.isArray(payload.profiles) ? payload.profiles : []
  const selected = profiles.find((value) => isObject(value) && value.name === profile)
  if (!isObject(selected)) throw new SafeBffError(404, "Hermes profile not found")
  const profilePath = typeof selected.path === "string" ? selected.path.trim() : ""
  if (!isAbsoluteServerPath(profilePath) || CONTROL_PATTERN.test(profilePath)) {
    throw new SafeBffError(502, "Hermes returned an invalid profile")
  }
  return profilePath
}

async function managedList(input: SafeHermesRequest, absolutePath: string): Promise<JsonObject> {
  const payload = await upstreamJson(input, "/api/files", new URLSearchParams({ path: absolutePath }))
  if (!isObject(payload)) throw new SafeBffError(502, "Hermes returned an invalid file listing")
  return payload
}

async function upstreamJson(
  input: SafeHermesRequest,
  upstreamPath: string,
  query?: URLSearchParams,
  method = "GET",
): Promise<unknown> {
  const response = await upstreamFetch(input, upstreamPath, query, { method })
  if (!response.ok) throw upstreamFailure(response.status)
  const contentLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > 4 * 1024 * 1024) {
    throw new SafeBffError(502, "Hermes response exceeded the safe limit")
  }
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new SafeBffError(502, "Hermes response exceeded the safe limit")
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SafeBffError(502, "Hermes returned invalid JSON")
  }
}

async function upstreamFetch(
  input: SafeHermesRequest,
  upstreamPath: string,
  query?: URLSearchParams,
  options: { method?: string; range?: string | null } = {},
): Promise<Response> {
  if (!input.target.httpBaseUrl) throw new SafeBffError(503, "Hermes HTTP backend is unavailable")
  const url = new URL(upstreamPath, `${input.target.httpBaseUrl.replace(/\/+$/u, "")}/`)
  for (const [key, value] of query ?? []) url.searchParams.append(key, value)
  const headers = new Headers({ accept: "application/json" })
  if (input.target.token) headers.set("X-Hermes-Session-Token", input.target.token)
  if (input.target.apiKey) headers.set("authorization", `Bearer ${input.target.apiKey}`)
  if (options.range && /^bytes=(?:\d+-\d*|-\d+)$/u.test(options.range)) headers.set("range", options.range)
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: input.signal,
    })
  } catch {
    throw new SafeBffError(502, "Could not reach Hermes backend")
  }
}

function upstreamFailure(status: number): SafeBffError {
  if (status === 400 || status === 422) return new SafeBffError(status, "Hermes rejected the request")
  if (status === 401 || status === 403) return new SafeBffError(status, "Hermes denied the request")
  if (status === 404) return new SafeBffError(404, "Hermes resource not found")
  if (status === 409) return new SafeBffError(409, "Hermes reported a conflicting state")
  if (status === 413) return new SafeBffError(413, "Hermes resource is too large")
  return new SafeBffError(status >= 500 && status <= 599 ? 502 : status, "Hermes backend request failed")
}

async function withSafeErrors(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SafeBffError) return jsonError(error.status, error.message)
    return jsonError(502, "Hermes backend request failed")
  }
}

class SafeBffError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "SafeBffError"
  }
}

function requireConcreteProfile(url: URL): string {
  const profile = oneQueryValue(url, "profile", true).trim()
  if (!PROFILE_PATTERN.test(profile) || profile === "all") {
    throw new SafeBffError(400, "A concrete Hermes profile is required")
  }
  return profile
}

function oneQueryValue(url: URL, key: string, required: true): string
function oneQueryValue(url: URL, key: string, required: false): string | null
function oneQueryValue(url: URL, key: string, required: boolean): string | null {
  const values = url.searchParams.getAll(key)
  if (values.length > 1 || (required && values.length !== 1)) throw new SafeBffError(400, `A single ${key} value is required`)
  return values[0] ?? null
}

function boundedInteger(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = oneQueryValue(url, key, false)
  if (raw === null || raw === "") return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SafeBffError(400, `${key} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function requireSafeQueryId(url: URL, key: string): string {
  const value = oneQueryValue(url, key, true).trim()
  if (!value || value.length > 256 || value === "." || value === ".." || CONTROL_PATTERN.test(value) || value.includes("/") || value.includes("\\")) {
    throw new SafeBffError(400, `A valid ${key} is required`)
  }
  return value
}

function requireLearningNodeQuery(url: URL): string {
  const value = oneQueryValue(url, "id", true).trim()
  const id = safeLearningNodeId(value)
  if (!id) throw new SafeBffError(400, "A valid learning node id is required")
  return id
}

function safeLearningNodeId(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 256 || CONTROL_PATTERN.test(value) || value.includes("/") || value.includes("\\")) return null
  if (value.startsWith("memory:")) return /^memory:(memory|profile):\d{1,8}$/u.test(value) ? value : null
  return SAFE_ID_PATTERN.test(value) ? value : null
}

function decodeSafeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded && !CONTROL_PATTERN.test(decoded) && !decoded.includes("/") && !decoded.includes("\\") && decoded !== "." && decoded !== ".."
      ? decoded
      : null
  } catch {
    return null
  }
}

function validateAutomationId(value: unknown): string {
  if (typeof value !== "string" || !AUTOMATION_ID_PATTERN.test(value)) throw new SafeBffError(404, "Automation not found")
  return value
}

function safeAutomationId(value: unknown): string | null {
  return typeof value === "string" && AUTOMATION_ID_PATTERN.test(value) ? value : null
}

function validateOutputId(value: unknown): string {
  if (typeof value !== "string" || !OUTPUT_ID_PATTERN.test(value)) throw new SafeBffError(404, "Automation output not found")
  return value
}

function normalizeRelativePath(value: string): string {
  const text = value.trim().replace(/^\.\//u, "")
  if (!text) return ""
  if (text.length > 1_024 || CONTROL_PATTERN.test(text) || text.startsWith("/") || text.includes("\\")) {
    throw new SafeBffError(400, "Invalid workspace path")
  }
  const segments = text.split("/").filter((segment) => segment && segment !== ".")
  if (segments.some((segment) => segment === ".." || isSensitivePathComponent(segment))) {
    throw new SafeBffError(403, "Workspace path is not allowed")
  }
  return segments.join("/")
}

function isSensitiveRelativePath(value: string): boolean {
  return value.split("/").some(isSensitivePathComponent)
}

function isSensitivePathComponent(value: string): boolean {
  const lowered = value.toLowerCase()
  return lowered === ".env" || lowered.startsWith(".env.") || lowered === ".envrc" || SENSITIVE_BASENAMES.has(lowered) || SENSITIVE_DIRECTORIES.has(lowered)
}

function joinServerPath(root: string, relative: string): string {
  return relative ? `${root.replace(/\/+$/u, "")}/${relative}` : root
}

function isAbsoluteServerPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)
}

function requireAbsolutePayloadPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsoluteServerPath(value) || CONTROL_PATTERN.test(value)) {
    throw new SafeBffError(502, "Hermes returned an invalid managed path")
  }
  return normalizeServerPath(value)
}

function normalizeServerPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/"
}

function pathIsUnder(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeServerPath(root)
  const normalizedCandidate = normalizeServerPath(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function relativeFromRoot(root: string, candidate: string): string {
  if (!pathIsUnder(root, candidate)) throw new SafeBffError(403, "Path escaped its allowed root")
  const normalizedRoot = normalizeServerPath(root)
  const normalizedCandidate = normalizeServerPath(candidate)
  return normalizedCandidate === normalizedRoot ? "" : normalizedCandidate.slice(normalizedRoot.length + 1)
}

function safeBasename(value: string): string {
  return cleanLabel(path.posix.basename(normalizeServerPath(value)), 255) || "workspace"
}

function parentRelativePath(value: string): string | null {
  if (!value) return null
  const index = value.lastIndexOf("/")
  return index < 0 ? "" : value.slice(0, index)
}

function isTextFile(name: string, mime: string): boolean {
  if (mime === "text/html" || mime === "image/svg+xml" || mime === "application/pdf") return false
  if (mime.startsWith("text/")) return true
  if (["application/json", "application/ld+json", "application/javascript", "application/xml", "application/yaml", "application/x-yaml"].includes(mime)) return true
  const lower = name.toLowerCase()
  return [...TEXT_EXTENSIONS].some((extension) => lower.endsWith(extension))
}

function decodeDataUrl(dataUrl: string, maxBytes: number): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(dataUrl)
  if (!match?.[1] || !match[2]) throw new SafeBffError(502, "Hermes returned an invalid file payload")
  const bytes = Buffer.from(match[2].replace(/[\r\n]/gu, ""), "base64")
  if (bytes.byteLength > maxBytes) throw new SafeBffError(413, "File preview is too large")
  return { bytes, mimeType: match[1] }
}

function parseSnippet(value: string): { text: string; highlights: Array<{ start: number; end: number }> } {
  let output = ""
  let cursor = 0
  const highlights: Array<{ start: number; end: number }> = []
  while (cursor < value.length) {
    const startMarker = value.indexOf(">>>", cursor)
    if (startMarker < 0) {
      output += value.slice(cursor)
      break
    }
    output += value.slice(cursor, startMarker)
    const endMarker = value.indexOf("<<<", startMarker + 3)
    if (endMarker < 0) {
      output += value.slice(startMarker + 3)
      break
    }
    const start = output.length
    output += value.slice(startMarker + 3, endMarker)
    if (output.length > start) highlights.push({ start, end: output.length })
    cursor = endMarker + 3
  }
  return { text: output, highlights }
}

function deliveryKind(value: unknown): string {
  const text = cleanLabel(value, 200)
  if (!text) return "local"
  const separator = text.indexOf(":")
  return separator > 0 ? text.slice(0, separator) : text
}

function scrubDiagnostic(value: unknown): string | null {
  const text = cleanText(value, 2_000)
  if (!text) return null
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .replace(/(?:\/Users|\/home|\/root|\/opt\/data)\/[^\s:]+/gu, "[path]")
    .replace(/[A-Za-z]:\\[^\s:]+/gu, "[path]")
}

function scrubAutomationMarkdown(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\s*[:=]\s*[^\s`]+/giu, "$1=[redacted]")
    .replace(/(?:\/Users|\/home|\/root|\/opt\/data)\/[^\s)`>]+/gu, "[path]")
    .replace(/[A-Za-z]:\\[^\s)`>]+/gu, "[path]")
}

function sanitizeStructuredValue(value: unknown, depth: number): unknown {
  if (depth < 0) return null
  if (typeof value === "string") return cleanText(value, 300)
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeStructuredValue(item, depth - 1))
  if (!isObject(value)) return null
  const output: JsonObject = {}
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) continue
    output[key] = sanitizeStructuredValue(item, depth - 1)
  }
  return output
}

function sanitizeNumericStats(value: unknown): JsonObject {
  if (!isObject(value)) return {}
  const output: JsonObject = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) continue
    if (typeof item === "number" && Number.isFinite(item)) output[key] = item
  }
  return output
}

function safeRelativeReviewPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 512 || CONTROL_PATTERN.test(value) || value.startsWith("/") || value.includes("\\")) return null
  const segments = value.split("/")
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? null : value
}

function safeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return source.slice(0, maxItems).flatMap((item) => {
    const text = cleanLabel(item, maxLength)
    return text ? [text] : []
  })
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= maxBytes) return value
  return new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes))
}

function safeIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80 || CONTROL_PATTERN.test(value)) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

function safeTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  if (typeof value === "string" && value && value.length <= 80) {
    const timestamp = Date.parse(value)
    return Number.isNaN(timestamp) ? null : timestamp / 1_000
  }
  return null
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  const number = safeNumber(value)
  return number !== null && number >= 0 ? number : null
}

function safeIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || !value || value.length > maxLength || CONTROL_PATTERN.test(value) || value.includes("/") || value.includes("\\")) return null
  return value
}

function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : null
}

function cleanLabel(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(CONTROL_PATTERN_GLOBAL, " ").trim().slice(0, maxLength) : ""
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, maxLength) : ""
}

const CONTROL_PATTERN_GLOBAL = /[\u0000-\u001f\u007f]/gu

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name)
  if (value) target.set(name, value)
}

function methodNotAllowed(methods: readonly string[]): Response {
  return jsonError(405, "Method not allowed", { allow: methods.join(", ") })
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  return new Response(JSON.stringify(data), { ...init, headers })
}

function jsonError(status: number, error: string, headers?: HeadersInit): Response {
  return json({ error }, { status, headers })
}
