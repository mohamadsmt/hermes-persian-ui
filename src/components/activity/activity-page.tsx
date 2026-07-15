"use client";

import {useCallback, useEffect, useReducer, useRef, useState} from "react";

import {useHermesWorkspace} from "@/components/workspace/workspace-provider";

import {ActivityCenter} from "./activity-center";
import {
  activityReducer,
  createActivityState,
  normalizeActivityStatus,
  type ActivityProcess,
  type ActivitySnapshot,
} from "./activity-reducer";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function processSnapshot(value: unknown): ActivityProcess[] {
  const payload = object(value);
  const items = Array.isArray(payload.processes) ? payload.processes : [];
  return items.slice(0, 50).flatMap((item, index) => {
    const source = object(item);
    const id = text(source, "id", "process_id", "processId") ?? `process:${index}`;
    const command = text(source, "command", "cmd");
    return [{
      id,
      label: text(source, "label", "name") ?? command ?? id,
      status: normalizeActivityStatus(source.status ?? source.state),
      ...(command ? {command} : {}),
      ...(typeof source.started_at === "number" ? {startedAt: source.started_at} : {}),
      updatedAt: Date.now(),
    }];
  });
}

function delegationSnapshot(value: unknown): ActivitySnapshot["delegation"] {
  const payload = object(value);
  const active = Array.isArray(payload.active) ? payload.active.length : undefined;
  const explicit = normalizeActivityStatus(payload.status);
  return {
    status: explicit === "unknown" ? (active ? "running" : "complete") : explicit,
    ...(typeof active === "number" ? {activeCount: active} : {}),
    ...(text(payload, "summary", "message") ? {summary: text(payload, "summary", "message")} : {}),
    updatedAt: Date.now(),
  };
}

function verificationSnapshot(value: unknown): ActivitySnapshot["verification"] {
  const root = object(value);
  const payload = object(root.verification ?? root);
  const summary = text(payload, "output_summary", "summary", "message", "result");
  const command = text(payload, "canonical_command", "command");
  const details = text(payload, "details", "output", "evidence");
  return {
    status: normalizeActivityStatus(payload.status),
    ...(summary ? {summary} : {}),
    ...(command ? {command} : {}),
    ...(details ? {details} : {}),
    updatedAt: Date.now(),
  };
}

export function ActivityPage() {
  const {activityEvents, runtime, setFeatureSupport, transport} = useHermesWorkspace();
  const [activity, dispatch] = useReducer(activityReducer, runtime.activeProfile, createActivityState);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const processed = useRef(new Set<string>());
  const processedProfile = useRef(runtime.activeProfile);

  useEffect(() => {
    if (processedProfile.current !== runtime.activeProfile) {
      processedProfile.current = runtime.activeProfile;
      processed.current.clear();
      dispatch({type: "set-profile", profile: runtime.activeProfile});
    }
    const retainedKeys = new Set<string>();
    for (const scoped of activityEvents) {
      if (scoped.profile !== runtime.activeProfile) continue;
      const key = `${scoped.event.connectionEpoch}:${scoped.event.id}`;
      retainedKeys.add(key);
      if (processed.current.has(key)) continue;
      processed.current.add(key);
      dispatch({type: "event", event: scoped.event});
    }
    for (const key of processed.current) {
      if (!retainedKeys.has(key)) processed.current.delete(key);
    }
  }, [activityEvents, runtime.activeProfile]);

  const refresh = useCallback(async () => {
    const identity = runtime.identity;
    if (!identity || runtime.connection !== "connected" || !runtime.capabilities?.gateway) {
      setStale(Boolean(identity));
      return;
    }
    setLoading(true);
    try {
      const [processes, delegation, verification] = await Promise.allSettled([
        transport.request("process.list", {session_id: identity.runtimeId}),
        transport.request("delegation.status", {session_id: identity.runtimeId}),
        transport.request("verification.status", {
          session_id: identity.runtimeId,
          stored_session_id: identity.storedId,
        }),
      ]);
      const snapshot: ActivitySnapshot = {};
      if (processes.status === "fulfilled") snapshot.processes = processSnapshot(processes.value);
      if (verification.status === "fulfilled") snapshot.verification = verificationSnapshot(verification.value);
      dispatch({type: "hydrate", sessionId: identity.runtimeId, snapshot});
      if (delegation.status === "fulfilled") {
        dispatch({type: "hydrate", snapshot: {delegation: delegationSnapshot(delegation.value)}});
      }
      const supported = [processes, delegation, verification].some((result) => result.status === "fulfilled");
      setFeatureSupport("activity", supported ? "available" : "readOnly");
      setStale(!supported);
    } finally {
      setLoading(false);
    }
  }, [runtime.capabilities?.gateway, runtime.connection, runtime.identity, setFeatureSupport, transport]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    if (!runtime.identity || runtime.connection !== "connected") {
      return () => window.clearTimeout(initial);
    }
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh, runtime.connection, runtime.identity]);

  return (
    <ActivityCenter
      activity={activity}
      activeSessionId={runtime.identity?.runtimeId}
      activeSessionTitle={runtime.sessionTitle}
      loading={loading}
      onRefresh={refresh}
      stale={stale}
    />
  );
}
