"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  createHermesTransport,
  type BootstrapInfo,
  type CapabilitySet,
  type HermesEvent,
  type HermesTransport,
  type SessionIdentity,
} from "@/lib/hermes";
import type { ConnectionPhase } from "@/components/chat/ui-types";

export type FeatureSupport = "unknown" | "available" | "readOnly" | "unavailable";

export type WorkspaceFeature =
  | "activity"
  | "automationControl"
  | "automationList"
  | "automationOutputs"
  | "automationRuns"
  | "automations"
  | "contextBreakdown"
  | "learning"
  | "learningDetail"
  | "learningPending"
  | "learningTimeline"
  | "pendingApprovals"
  | "projects"
  | "recovery"
  | "sessionSearch"
  | "workspaceDownload"
  | "workspaceFiles"
  | "workspaceList"
  | "workspaceRead"
  | "workspaceValidate";

export type WorkspaceFeatureCapabilities = Record<WorkspaceFeature, FeatureSupport>;

export interface WorkspaceRuntimeState {
  activeProfile: string;
  activeStoredId?: string;
  bootstrap: BootstrapInfo | null;
  capabilities?: CapabilitySet;
  connection: ConnectionPhase;
  gatewayContract?: number;
  identity: SessionIdentity | null;
  profiles: string[];
  running: boolean;
  sessionTitle?: string;
}

const DEFAULT_FEATURES: WorkspaceFeatureCapabilities = {
  activity: "unknown",
  automationControl: "unknown",
  automationList: "unknown",
  automationOutputs: "unknown",
  automationRuns: "unknown",
  automations: "unknown",
  contextBreakdown: "unknown",
  learning: "unknown",
  learningDetail: "unknown",
  learningPending: "unknown",
  learningTimeline: "unknown",
  pendingApprovals: "unknown",
  projects: "unknown",
  recovery: "unknown",
  sessionSearch: "unknown",
  workspaceDownload: "unknown",
  workspaceFiles: "unknown",
  workspaceList: "unknown",
  workspaceRead: "unknown",
  workspaceValidate: "unknown",
};

const DEFAULT_RUNTIME: WorkspaceRuntimeState = {
  activeProfile: "default",
  bootstrap: null,
  connection: "connecting",
  identity: null,
  profiles: ["default"],
  running: false,
};

interface HermesWorkspaceContextValue {
  activityEvents: WorkspaceActivityEvent[];
  features: WorkspaceFeatureCapabilities;
  publishRuntime: (next: Partial<WorkspaceRuntimeState>) => void;
  recordActivityEvent: (event: HermesEvent, profile?: string) => void;
  runtime: WorkspaceRuntimeState;
  setFeatureSupport: (feature: WorkspaceFeature, support: FeatureSupport) => void;
  transport: HermesTransport;
}

export interface WorkspaceActivityEvent {
  event: HermesEvent;
  profile: string;
}

const HermesWorkspaceContext = createContext<HermesWorkspaceContextValue | null>(null);

function isActivityEvent(event: HermesEvent): boolean {
  return (
    event.type.startsWith("subagent.") ||
    event.type.startsWith("tool.") ||
    event.type.startsWith("process.") ||
    event.type === "background.complete" ||
    event.type === "delegation.status" ||
    event.type === "verification.status" ||
    event.type === "status.update" ||
    event.type === "thinking.delta" ||
    event.type === "reasoning.delta" ||
    event.type === "message.complete"
  );
}

export function HermesWorkspaceProvider({ children }: { children: ReactNode }) {
  const [transport] = useState<HermesTransport>(() => createHermesTransport());
  const [runtime, setRuntime] = useState<WorkspaceRuntimeState>(DEFAULT_RUNTIME);
  const [features, setFeatures] = useState<WorkspaceFeatureCapabilities>(DEFAULT_FEATURES);
  const [activityEvents, setActivityEvents] = useState<WorkspaceActivityEvent[]>([]);

  const publishRuntime = useCallback((next: Partial<WorkspaceRuntimeState>) => {
    setRuntime((current) => ({ ...current, ...next }));
  }, []);

  const setFeatureSupport = useCallback((feature: WorkspaceFeature, support: FeatureSupport) => {
    setFeatures((current) => (current[feature] === support ? current : { ...current, [feature]: support }));
  }, []);

  const recordActivityEvent = useCallback((event: HermesEvent, profile?: string) => {
    if (!isActivityEvent(event)) return;
    setActivityEvents((current) => {
      if (
        current.some(
          (item) =>
            item.event.id === event.id &&
            item.event.connectionEpoch === event.connectionEpoch,
        )
      ) {
        return current;
      }
      const next = [...current, {event, profile: profile?.trim() || runtime.activeProfile}];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, [runtime.activeProfile]);

  const value = useMemo<HermesWorkspaceContextValue>(
    () => ({
      activityEvents,
      features,
      publishRuntime,
      recordActivityEvent,
      runtime,
      setFeatureSupport,
      transport,
    }),
    [activityEvents, features, publishRuntime, recordActivityEvent, runtime, setFeatureSupport, transport],
  );

  return <HermesWorkspaceContext.Provider value={value}>{children}</HermesWorkspaceContext.Provider>;
}

export function useHermesWorkspace(): HermesWorkspaceContextValue {
  const value = useContext(HermesWorkspaceContext);
  if (!value) throw new Error("useHermesWorkspace must be used inside HermesWorkspaceProvider");
  return value;
}
