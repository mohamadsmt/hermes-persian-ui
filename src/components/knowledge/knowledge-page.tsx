"use client";

import {useMemo} from "react";

import {useHermesWorkspace} from "@/components/workspace/workspace-provider";

import {
  defaultLearningApi,
  LearningApiError,
  type LearningApi,
} from "./learning-api";
import {KnowledgePanel} from "./knowledge-panel";

function unsupported(error: unknown): boolean {
  return error instanceof LearningApiError && (error.status === 404 || error.status === 405);
}

export function KnowledgePage() {
  const {features, runtime, setFeatureSupport, transport} = useHermesWorkspace();
  const api = useMemo<LearningApi>(() => ({
    async timeline(profile, signal) {
      try {
        const result = await defaultLearningApi.timeline(profile, signal);
        setFeatureSupport("learningTimeline", "available");
        setFeatureSupport("learning", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) {
          setFeatureSupport("learningTimeline", "unavailable");
          setFeatureSupport("learning", "unavailable");
        }
        throw error;
      }
    },
    async pending(profile, signal) {
      try {
        const result = await defaultLearningApi.pending(profile, signal);
        setFeatureSupport("learningPending", "available");
        setFeatureSupport("pendingApprovals", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) {
          setFeatureSupport("learningPending", "unavailable");
          setFeatureSupport("pendingApprovals", "unavailable");
          return [];
        }
        throw error;
      }
    },
    async detail(profile, id, signal) {
      try {
        const result = await defaultLearningApi.detail(profile, id, signal);
        setFeatureSupport("learningDetail", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) setFeatureSupport("learningDetail", "unavailable");
        throw error;
      }
    },
  }), [setFeatureSupport]);
  const available = features.learning !== "unavailable";
  const canReview =
    available &&
    features.pendingApprovals === "available" &&
    runtime.connection === "connected" &&
    runtime.capabilities?.gateway === true &&
    Boolean(runtime.identity) &&
    !runtime.running;

  return (
    <KnowledgePanel
      activeSessionId={runtime.identity?.storedId}
      api={api}
      available={available}
      canReview={canReview}
      executeCommand={async (command) => {
        const identity = runtime.identity;
        if (!identity || runtime.connection !== "connected" || runtime.running) {
          throw new Error("The active profile session is not idle and connected");
        }
        return transport.command(identity, command);
      }}
      profile={runtime.activeProfile}
      sessionRunning={runtime.running}
    />
  );
}
