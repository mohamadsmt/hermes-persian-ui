export type LearningKind = "memory" | "skill";

export interface LearningNode {
  id: string;
  kind: LearningKind;
  title: string;
  summary?: string;
  body?: string;
  category?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LearningDetail extends LearningNode {
  metadata?: Record<string, unknown>;
}

export interface PendingOperation {
  action: "add" | "remove" | "replace" | "unknown";
  path?: string;
  before?: string;
  after?: string;
}

export interface PendingWrite {
  id: string;
  kind: LearningKind;
  title: string;
  summary?: string;
  origin?: string;
  createdAt?: string;
  operations: PendingOperation[];
}

export interface LearningApi {
  timeline(profile: string, signal?: AbortSignal): Promise<LearningNode[]>;
  pending(profile: string, signal?: AbortSignal): Promise<PendingWrite[]>;
  detail(profile: string, id: string, signal?: AbortSignal): Promise<LearningDetail>;
}

export class LearningApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "LearningApiError";
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

function date(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "number" && typeof value !== "string") continue;
    const input = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return undefined;
}

function kind(source: Record<string, unknown>, fallback: LearningKind = "memory"): LearningKind {
  const value = string(source, "kind", "type", "category")?.toLowerCase();
  return value?.includes("skill") ? "skill" : value?.includes("memory") ? "memory" : fallback;
}

function normalizeNode(value: unknown, fallbackKind?: LearningKind): LearningNode | null {
  const source = object(value);
  const metadata = object(source.meta ?? source.metadata);
  const id = string(source, "id", "node_id", "nodeId") ?? string(metadata, "id");
  if (!id) return null;
  return {
    id,
    kind: kind({...metadata, ...source}, fallbackKind),
    title:
      string(source, "title", "label", "fullLabel", "full_label", "name") ??
      string(metadata, "title", "label") ??
      id,
    summary: string(source, "summary", "description") ?? string(metadata, "summary", "description"),
    body: string(source, "body", "content", "text"),
    category: string(source, "category") ?? string(metadata, "category", "bucket"),
    createdAt: date(source, "created_at", "createdAt", "timestamp") ?? date(metadata, "created_at", "createdAt"),
    updatedAt: date(source, "updated_at", "updatedAt") ?? date(metadata, "updated_at", "updatedAt"),
  };
}

function normalizeAction(value: unknown): PendingOperation["action"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (normalized === "add" || normalized === "insert" || normalized === "create") return "add";
  if (normalized === "remove" || normalized === "delete") return "remove";
  if (normalized === "replace" || normalized === "update" || normalized === "edit") return "replace";
  return "unknown";
}

function normalizeOperation(value: unknown): PendingOperation {
  const source = object(value);
  return {
    action: normalizeAction(source.action ?? source.operation ?? source.type),
    path: string(source, "path", "target", "section"),
    before: string(source, "before", "old", "old_text", "oldText"),
    after: string(source, "after", "new", "new_text", "newText", "content"),
  };
}

function normalizePending(value: unknown, fallbackKind: LearningKind): PendingWrite | null {
  const source = object(value);
  const id = string(source, "id", "request_id", "requestId", "pending_id", "pendingId");
  if (!id) return null;
  const operationsSource = Array.isArray(source.operations)
    ? source.operations
    : Array.isArray(source.changes)
      ? source.changes
      : [];
  return {
    id,
    kind: kind(source, fallbackKind),
    title: string(source, "title", "name", "label") ?? id,
    summary: string(source, "summary", "description", "reason"),
    origin: string(source, "origin", "source", "session_id", "sessionId"),
    createdAt: date(source, "created_at", "createdAt", "timestamp"),
    operations: operationsSource.map(normalizeOperation),
  };
}

function graphItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const source = object(value);
  for (const key of ["nodes", "items", "frames"]) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  const buckets = source.buckets;
  if (Array.isArray(buckets)) {
    return buckets.flatMap((bucket) => {
      const candidate = object(bucket);
      return Array.isArray(candidate.nodes) ? candidate.nodes : [];
    });
  }
  if (buckets && typeof buckets === "object") {
    return Object.values(buckets).flatMap((bucket) => {
      if (Array.isArray(bucket)) return bucket;
      const candidate = object(bucket);
      return Array.isArray(candidate.nodes) ? candidate.nodes : [];
    });
  }
  return [];
}

function pendingItems(value: unknown): PendingWrite[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizePending(item, "memory"))
      .filter((item): item is PendingWrite => Boolean(item));
  }
  const source = object(value);
  const generic = Array.isArray(source.items) ? source.items : Array.isArray(source.pending) ? source.pending : [];
  const memory = Array.isArray(source.memory)
    ? source.memory
    : Array.isArray(source.memories)
      ? source.memories
      : [];
  const skills = Array.isArray(source.skills) ? source.skills : [];
  return [
    ...generic.map((item) => normalizePending(item, "memory")),
    ...memory.map((item) => normalizePending(item, "memory")),
    ...skills.map((item) => normalizePending(item, "skill")),
  ].filter((item): item is PendingWrite => Boolean(item));
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value === "all" || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new LearningApiError(`Invalid ${label}`, 400);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new LearningApiError("Hermes learning request failed", response.status);
  return response.status === 204 ? null : response.json();
}

export function createLearningApi(fetchImpl: typeof fetch = fetch): LearningApi {
  const endpoint = (profile: string, resource: "detail" | "pending" | "timeline", id?: string) => {
    assertIdentifier(profile, "profile");
    const query = new URLSearchParams({profile});
    if (id) {
      assertIdentifier(id, "learning id");
      query.set("id", id);
    }
    return `/api/hermes/learning/${resource}?${query.toString()}`;
  };

  return {
    async timeline(profile, signal) {
      const payload = await responseJson(
        await fetchImpl(endpoint(profile, "timeline"), {
          headers: {Accept: "application/json"},
          signal,
        }),
      );
      return graphItems(payload)
        .map((item) => normalizeNode(item))
        .filter((item): item is LearningNode => Boolean(item))
        .sort((left, right) => (right.createdAt ?? right.updatedAt ?? "").localeCompare(left.createdAt ?? left.updatedAt ?? ""));
    },
    async pending(profile, signal) {
      const payload = await responseJson(
        await fetchImpl(endpoint(profile, "pending"), {
          headers: {Accept: "application/json"},
          signal,
        }),
      );
      return pendingItems(payload);
    },
    async detail(profile, id, signal) {
      const payload = await responseJson(
        await fetchImpl(endpoint(profile, "detail", id), {
          headers: {Accept: "application/json"},
          signal,
        }),
      );
      const source = object(payload);
      const candidate = source.node ?? source.detail ?? payload;
      const normalized = normalizeNode(candidate);
      if (!normalized) throw new LearningApiError("Invalid learning detail response", 502);
      const candidateObject = object(candidate);
      return {...normalized, metadata: object(candidateObject.meta ?? candidateObject.metadata)};
    },
  };
}

export const defaultLearningApi = createLearningApi();
