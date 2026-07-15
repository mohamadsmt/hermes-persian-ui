export type AutomationState = "error" | "idle" | "paused" | "queued" | "running" | "unknown";

export interface AutomationJob {
  id: string;
  profile: string;
  name: string;
  schedule: string;
  enabled: boolean;
  state: AutomationState;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  lastDeliveryError?: string;
  delivery?: string;
  model?: string;
  provider?: string;
  workdir?: string;
}

export interface AutomationRun {
  id: string;
  jobId: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  summary?: string;
  error?: string;
}

export interface AutomationOutput {
  id: string;
  jobId: string;
  name: string;
  createdAt?: string;
  size?: number;
  markdown?: string;
  downloadUrl?: string;
}

export type AutomationControl = "pause" | "resume" | "run";

export interface AutomationsApi {
  list(profile: string, signal?: AbortSignal): Promise<AutomationJob[]>;
  runs(profile: string, jobId: string, signal?: AbortSignal): Promise<AutomationRun[]>;
  outputs(profile: string, jobId: string, signal?: AbortSignal): Promise<AutomationOutput[]>;
  output(profile: string, jobId: string, outputId: string, signal?: AbortSignal): Promise<AutomationOutput>;
  control(profile: string, jobId: string, action: AutomationControl): Promise<void>;
}

export class AutomationsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AutomationsApiError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function boolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof source[key] === "boolean" ? source[key] : fallback;
}

function number(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isoDate(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const parsed = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(parsed);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return undefined;
}

function normalizeState(value: unknown, enabled: boolean): AutomationState {
  if (!enabled) return "paused";
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase().replaceAll("_", "-");
  if (["active", "idle", "ready", "enabled", "scheduled"].includes(normalized)) return "idle";
  if (["paused", "disabled"].includes(normalized)) return "paused";
  if (["running", "executing", "in-progress"].includes(normalized)) return "running";
  if (["queued", "pending"].includes(normalized)) return "queued";
  if (["error", "failed", "failure"].includes(normalized)) return "error";
  return "unknown";
}

function normalizeJob(value: unknown, fallbackProfile: string): AutomationJob | null {
  const source = object(value);
  const id = string(source, "id", "job_id", "jobId");
  if (!id) return null;
  const enabled = boolean(source, "enabled", true);
  return {
    id,
    profile: string(source, "profile") ?? fallbackProfile,
    name: string(source, "name", "title") ?? id,
    schedule:
      string(source, "schedule_display", "scheduleDisplay", "schedule", "repeat") ?? "—",
    enabled,
    state: normalizeState(source.state ?? source.status ?? source.last_status, enabled),
    lastRunAt: isoDate(source, "last_run_at", "lastRunAt"),
    nextRunAt: isoDate(source, "next_run_at", "nextRunAt"),
    lastStatus: string(source, "last_status", "lastStatus"),
    lastError: string(source, "last_error", "lastError"),
    lastDeliveryError: string(source, "last_delivery_error", "lastDeliveryError"),
    delivery: string(source, "deliver", "delivery"),
    model: string(source, "model"),
    provider: string(source, "provider"),
    workdir: string(source, "workdir", "cwd"),
  };
}

function normalizeRun(value: unknown, fallbackJobId: string): AutomationRun | null {
  const source = object(value);
  const id = string(source, "id", "run_id", "runId");
  if (!id) return null;
  return {
    id,
    jobId: string(source, "job_id", "jobId") ?? fallbackJobId,
    status: string(source, "status", "state") ?? "unknown",
    startedAt: isoDate(source, "started_at", "startedAt", "created_at", "createdAt"),
    finishedAt: isoDate(source, "finished_at", "finishedAt", "completed_at", "completedAt"),
    sessionId: string(source, "session_id", "sessionId"),
    summary: string(source, "summary", "output"),
    error: string(source, "error", "last_error", "lastError"),
  };
}

function normalizeOutput(value: unknown, fallbackJobId: string): AutomationOutput | null {
  const source = object(value);
  const id = string(source, "id", "output_id", "outputId", "name");
  if (!id) return null;
  return {
    id,
    jobId: string(source, "job_id", "jobId") ?? fallbackJobId,
    name: string(source, "name", "title") ?? id,
    createdAt: isoDate(source, "created_at", "createdAt", "updated_at", "updatedAt"),
    size: number(source, "size", "size_bytes", "sizeBytes"),
    markdown: string(source, "markdown", "content"),
    downloadUrl: string(source, "download_url", "downloadUrl"),
  };
}

function listFrom(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const source = object(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  return [];
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value === "all" || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AutomationsApiError(`Invalid ${label}`, 400);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new AutomationsApiError("Hermes automation request failed", response.status);
  }
  return response.status === 204 ? null : response.json();
}

export function createAutomationsApi(fetchImpl: typeof fetch = fetch): AutomationsApi {
  const endpoint = (profile: string, suffix = "") => {
    assertIdentifier(profile, "profile");
    return `/api/hermes/automations${suffix}?profile=${encodeURIComponent(profile)}`;
  };

  return {
    async list(profile, signal) {
      const payload = await responseJson(
        await fetchImpl(endpoint(profile), {headers: {Accept: "application/json"}, signal}),
      );
      return listFrom(payload, "jobs", "items")
        .map((item) => normalizeJob(item, profile))
        .filter((item): item is AutomationJob => Boolean(item));
    },
    async runs(profile, jobId, signal) {
      assertIdentifier(jobId, "job id");
      const payload = await responseJson(
        await fetchImpl(endpoint(profile, `/${encodeURIComponent(jobId)}/runs`), {
          headers: {Accept: "application/json"},
          signal,
        }),
      );
      return listFrom(payload, "runs", "items")
        .map((item) => normalizeRun(item, jobId))
        .filter((item): item is AutomationRun => Boolean(item));
    },
    async outputs(profile, jobId, signal) {
      assertIdentifier(jobId, "job id");
      const payload = await responseJson(
        await fetchImpl(endpoint(profile, `/${encodeURIComponent(jobId)}/outputs`), {
          headers: {Accept: "application/json"},
          signal,
        }),
      );
      return listFrom(payload, "outputs", "items")
        .map((item) => normalizeOutput(item, jobId))
        .filter((item): item is AutomationOutput => Boolean(item));
    },
    async output(profile, jobId, outputId, signal) {
      assertIdentifier(jobId, "job id");
      assertIdentifier(outputId, "output id");
      const payload = await responseJson(
        await fetchImpl(
          endpoint(
            profile,
            `/${encodeURIComponent(jobId)}/outputs/${encodeURIComponent(outputId)}`,
          ),
          {headers: {Accept: "application/json"}, signal},
        ),
      );
      const source = object(payload);
      const normalized = normalizeOutput(source.output ?? payload, jobId);
      if (!normalized || normalized.id !== outputId) {
        throw new AutomationsApiError("Invalid automation output response", 502);
      }
      return normalized;
    },
    async control(profile, jobId, action) {
      assertIdentifier(jobId, "job id");
      if (!(["pause", "resume", "run"] as const).includes(action)) {
        throw new AutomationsApiError("Invalid automation control", 400);
      }
      await responseJson(
        await fetchImpl(endpoint(profile, `/${encodeURIComponent(jobId)}/${action}`), {
          body: JSON.stringify({profile}),
          headers: {Accept: "application/json", "Content-Type": "application/json"},
          method: "POST",
        }),
      );
    },
  };
}

export const defaultAutomationsApi = createAutomationsApi();
