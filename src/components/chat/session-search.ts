"use client";

import { useEffect, useRef, useState } from "react";

import type { SessionSearchHit } from "@/lib/hermes";

export const MAX_SESSION_SEARCH_QUERY = 256;
export const MAX_SESSION_SEARCH_RESULTS = 50;

export interface SessionSearchState {
  error: string | null;
  loading: boolean;
  results: SessionSearchHit[];
}

export interface UseSessionSearchOptions {
  debounceMs?: number;
  enabled?: boolean;
  limit?: number;
  onCapabilityChange?: (support: "available" | "unavailable") => void;
  profile?: string;
  query: string;
}

interface SearchResponse {
  profile?: unknown;
  query?: unknown;
  results?: unknown;
}

interface RequestState extends SessionSearchState {
  query: string;
}

export function normalizeSessionSearchQuery(query: string): string {
  return query.trim().slice(0, MAX_SESSION_SEARCH_QUERY);
}

export function dedupeSessionSearchHits(hits: SessionSearchHit[]): SessionSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = hit.lineageRoot?.trim() || hit.sessionId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Debounced, profile-scoped FTS search. Results are tied to the normalized
 * query that produced them, so late responses can never flash under a newer
 * query even on browsers where abort races with response delivery.
 */
export function useSessionSearch({
  debounceMs = 250,
  enabled = true,
  limit = 50,
  onCapabilityChange,
  profile,
  query,
}: UseSessionSearchOptions): SessionSearchState {
  const normalizedQuery = normalizeSessionSearchQuery(query);
  const concreteProfile = profile?.trim() ?? "";
  const safeLimit = Math.max(1, Math.min(MAX_SESSION_SEARCH_RESULTS, Math.trunc(limit)));
  const requestSequence = useRef(0);
  const [request, setRequest] = useState<RequestState>({
    error: null,
    loading: false,
    query: "",
    results: [],
  });

  useEffect(() => {
    if (!enabled || !normalizedQuery || !concreteProfile || concreteProfile === "all") return;

    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRequest({ error: null, loading: true, query: normalizedQuery, results: [] });

      const params = new URLSearchParams({
        profile: concreteProfile,
        q: normalizedQuery,
        limit: String(safeLimit),
      });

      void fetch(`/api/hermes/sessions/search?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            if (response.status === 404 || response.status === 405) {
              onCapabilityChange?.("unavailable");
            }
            throw new Error(`Session search failed (${response.status})`);
          }
          onCapabilityChange?.("available");
          return (await response.json()) as SearchResponse;
        })
        .then((payload) => {
          if (controller.signal.aborted || sequence !== requestSequence.current) return;
          if (payload.profile !== concreteProfile || payload.query !== normalizedQuery) {
            throw new Error("Session search returned a mismatched scope");
          }
          setRequest({
            error: null,
            loading: false,
            query: normalizedQuery,
            results: parseSessionSearchHits(payload.results, concreteProfile),
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || sequence !== requestSequence.current) return;
          setRequest({
            error: error instanceof Error ? error.message : "Session search failed",
            loading: false,
            query: normalizedQuery,
            results: [],
          });
        });
    }, Math.max(0, debounceMs));

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [concreteProfile, debounceMs, enabled, normalizedQuery, onCapabilityChange, safeLimit]);

  if (
    !enabled ||
    !normalizedQuery ||
    !concreteProfile ||
    concreteProfile === "all" ||
    request.query !== normalizedQuery
  ) {
    return { error: null, loading: false, results: [] };
  }

  return request;
}

function parseSessionSearchHits(value: unknown, profile: string): SessionSearchHit[] {
  if (!Array.isArray(value)) return [];
  const hits = value.flatMap((candidate): SessionSearchHit[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Record<string, unknown>;
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
    const resultProfile = typeof raw.profile === "string" ? raw.profile.trim() : "";
    if (!sessionId || resultProfile !== profile) return [];

    const role = ["assistant", "system", "tool", "user"].includes(String(raw.role))
      ? (raw.role as SessionSearchHit["role"])
      : undefined;
    return [{
      profile,
      sessionId,
      lineageRoot: typeof raw.lineageRoot === "string" ? raw.lineageRoot.trim() || undefined : undefined,
      snippet: typeof raw.snippet === "string" ? raw.snippet.slice(0, 4_000) : "",
      role,
      source: typeof raw.source === "string" ? raw.source : undefined,
      model: typeof raw.model === "string" ? raw.model : undefined,
      startedAt: typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
        ? raw.startedAt
        : undefined,
    }];
  });
  return dedupeSessionSearchHits(hits);
}
