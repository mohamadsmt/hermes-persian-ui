"use client";

import {useLocale} from "next-intl";
import {useRouter} from "next/navigation";
import {useMemo} from "react";

import {useHermesWorkspace} from "@/components/workspace/workspace-provider";

import {
  AutomationsApiError,
  defaultAutomationsApi,
  type AutomationsApi,
} from "./automations-api";
import {AutomationsPanel} from "./automations-panel";

function unsupported(error: unknown): boolean {
  return error instanceof AutomationsApiError && (error.status === 404 || error.status === 405);
}

export function AutomationsPage() {
  const locale = useLocale();
  const router = useRouter();
  const {features, runtime, setFeatureSupport} = useHermesWorkspace();
  const api = useMemo<AutomationsApi>(() => ({
    async list(profile, signal) {
      try {
        const result = await defaultAutomationsApi.list(profile, signal);
        setFeatureSupport("automationList", "available");
        setFeatureSupport("automations", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) {
          setFeatureSupport("automationList", "unavailable");
          setFeatureSupport("automations", "unavailable");
        }
        throw error;
      }
    },
    async runs(profile, jobId, signal) {
      try {
        const result = await defaultAutomationsApi.runs(profile, jobId, signal);
        setFeatureSupport("automationRuns", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) setFeatureSupport("automationRuns", "unavailable");
        throw error;
      }
    },
    async outputs(profile, jobId, signal) {
      try {
        const result = await defaultAutomationsApi.outputs(profile, jobId, signal);
        setFeatureSupport("automationOutputs", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) setFeatureSupport("automationOutputs", "unavailable");
        throw error;
      }
    },
    async output(profile, jobId, outputId, signal) {
      try {
        const result = await defaultAutomationsApi.output(profile, jobId, outputId, signal);
        setFeatureSupport("automationOutputs", "available");
        return result;
      } catch (error) {
        if (unsupported(error)) setFeatureSupport("automationOutputs", "unavailable");
        throw error;
      }
    },
    async control(profile, jobId, action) {
      try {
        await defaultAutomationsApi.control(profile, jobId, action);
        setFeatureSupport("automationControl", "available");
      } catch (error) {
        if (unsupported(error)) setFeatureSupport("automationControl", "unavailable");
        throw error;
      }
    },
  }), [setFeatureSupport]);
  const available = features.automations !== "unavailable";
  const canMutate =
    available &&
    features.automationControl !== "unavailable" &&
    runtime.connection === "connected" &&
    runtime.capabilities?.gateway === true;

  return (
    <AutomationsPanel
      api={api}
      available={available}
      canMutate={canMutate}
      onOpenSession={(profile, sessionId) => {
        router.push(`/${locale}/c/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profile)}`);
      }}
      profile={runtime.activeProfile}
    />
  );
}
