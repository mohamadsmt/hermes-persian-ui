"use client";

import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Clock3,
  ExternalLink,
  FileText,
  LoaderCircle,
  Play,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {useLocale, useTranslations} from "next-intl";
import {useCallback, useEffect, useRef, useState} from "react";

import {BidiBlock, TechnicalInline} from "@/components/chat/bidi-text";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {cn} from "@/components/ui/utils";
import {ConfirmActionDialog} from "@/components/workspace/confirm-action-dialog";

import {
  type AutomationControl,
  type AutomationJob,
  type AutomationOutput,
  type AutomationRun,
  type AutomationsApi,
  defaultAutomationsApi,
} from "./automations-api";

export const AUTOMATION_POLL_INTERVAL_MS = 2_000;
export const AUTOMATION_MAX_POLLS = 30;

interface JobDetails {
  loading: boolean;
  outputs: AutomationOutput[];
  runs: AutomationRun[];
}

interface PendingControl {
  action: AutomationControl;
  job: AutomationJob;
}

export interface AutomationsPanelProps {
  api?: AutomationsApi;
  available?: boolean;
  canMutate?: boolean;
  className?: string;
  onOpenSession?: (profile: string, sessionId: string) => void;
  profile: string;
}

function statusTone(state: AutomationJob["state"]): "danger" | "neutral" | "success" | "warning" {
  if (state === "idle") return "success";
  if (state === "error") return "danger";
  if (state === "queued" || state === "running") return "warning";
  return "neutral";
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short"}).format(date);
}

function safeDownloadUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("/api/hermes/") ? value : undefined;
}

function JobStateBadge({job}: {job: AutomationJob}) {
  const t = useTranslations("Automations");
  const label = {
    error: t("stateError"),
    idle: t("stateIdle"),
    paused: t("statePaused"),
    queued: t("stateQueued"),
    running: t("stateRunning"),
    unknown: t("stateUnknown"),
  }[job.state];
  return <Badge tone={statusTone(job.state)}>{label}</Badge>;
}

export function AutomationsPanel({
  api = defaultAutomationsApi,
  available = true,
  canMutate = false,
  className,
  onOpenSession,
  profile,
}: AutomationsPanelProps) {
  const t = useTranslations("Automations");
  const actions = useTranslations("Actions");
  const locale = useLocale();
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [jobsProfile, setJobsProfile] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string>();
  const [expandedId, setExpandedId] = useState<string>();
  const [details, setDetails] = useState<Record<string, JobDetails>>({});
  const [pendingControl, setPendingControl] = useState<PendingControl>();
  const [controlBusy, setControlBusy] = useState(false);
  const [queuedJobId, setQueuedJobId] = useState<string>();
  const [outputLoadingKey, setOutputLoadingKey] = useState<string>();
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const loadJobs = useCallback(
    async (signal?: AbortSignal) => {
      if (!available || !profile) {
        setJobs([]);
        setLoading(false);
        return [];
      }
      setLoading(true);
      try {
        const nextJobs = await api.list(profile, signal);
        if (!signal?.aborted) {
          setJobs(nextJobs);
          setJobsProfile(profile);
          setError(undefined);
          setStale(false);
          setLoading(false);
        }
        return nextJobs;
      } catch (requestError) {
        if (!signal?.aborted) {
          setError(requestError instanceof Error ? requestError.message : t("loadFailed"));
          setStale(true);
          setLoading(false);
        }
        return [];
      }
    },
    [api, available, profile, t],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void loadJobs(controller.signal);
    });
    return () => {
      mounted.current = false;
      controller.abort();
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [loadJobs, profile]);

  async function loadDetails(jobId: string) {
    const scopeKey = `${profile}:${jobId}`;
    if (expandedId === scopeKey) {
      setExpandedId(undefined);
      return;
    }
    setExpandedId(scopeKey);
    setDetails((current) => ({
      ...current,
      [scopeKey]: current[scopeKey] ?? {loading: true, outputs: [], runs: []},
    }));
    try {
      const [runs, outputs] = await Promise.all([api.runs(profile, jobId), api.outputs(profile, jobId)]);
      if (!mounted.current) return;
      setDetails((current) => ({...current, [scopeKey]: {loading: false, outputs, runs}}));
    } catch (requestError) {
      if (!mounted.current) return;
      setError(requestError instanceof Error ? requestError.message : t("detailsFailed"));
      setDetails((current) => ({
        ...current,
        [scopeKey]: {...(current[scopeKey] ?? {outputs: [], runs: []}), loading: false},
      }));
    }
  }

  async function loadOutput(jobId: string, outputId: string) {
    const scopeKey = `${profile}:${jobId}`;
    const loadingKey = `${scopeKey}:${outputId}`;
    if (outputLoadingKey) return;
    setOutputLoadingKey(loadingKey);
    try {
      const loaded = await api.output(profile, jobId, outputId);
      if (!mounted.current) return;
      setDetails((current) => {
        const currentDetail = current[scopeKey] ?? {loading: false, outputs: [], runs: []};
        const definedOutput = Object.fromEntries(
          Object.entries(loaded).filter(([, value]) => value !== undefined),
        ) as Partial<AutomationOutput>;
        return {
          ...current,
          [scopeKey]: {
            ...currentDetail,
            outputs: currentDetail.outputs.map((item) => item.id === outputId ? {...item, ...definedOutput} : item),
          },
        };
      });
      setError(undefined);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("detailsFailed"));
    } finally {
      if (mounted.current) setOutputLoadingKey(undefined);
    }
  }

  function startRunPolling(job: AutomationJob) {
    const baseline = job.lastRunAt;
    const scopeKey = `${profile}:${job.id}`;
    let attempts = 0;
    setQueuedJobId(scopeKey);

    const poll = async () => {
      attempts += 1;
      let nextJobs: AutomationJob[] = [];
      try {
        nextJobs = await api.list(profile);
        if (!mounted.current) return;
        setJobs(nextJobs);
        setError(undefined);
        setStale(false);
      } catch (requestError) {
        if (!mounted.current) return;
        setError(requestError instanceof Error ? requestError.message : t("loadFailed"));
        setStale(true);
      }
      const updated = nextJobs.find((candidate) => candidate.id === job.id);
      if (updated?.lastRunAt && updated.lastRunAt !== baseline) {
        setQueuedJobId(undefined);
        if (expandedId === scopeKey) void loadDetails(job.id);
        return;
      }
      if (attempts >= AUTOMATION_MAX_POLLS) return;
      pollTimer.current = setTimeout(() => void poll(), AUTOMATION_POLL_INTERVAL_MS);
    };

    pollTimer.current = setTimeout(() => void poll(), AUTOMATION_POLL_INTERVAL_MS);
  }

  async function executeControl() {
    if (!pendingControl || !canMutate || stale) return;
    setControlBusy(true);
    try {
      await api.control(profile, pendingControl.job.id, pendingControl.action);
      if (pendingControl.action === "run") {
        startRunPolling(pendingControl.job);
      } else {
        await loadJobs();
      }
      setPendingControl(undefined);
      setError(undefined);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("controlFailed"));
      setStale(true);
      setPendingControl(undefined);
    } finally {
      setControlBusy(false);
    }
  }

  const confirmationTitle = pendingControl
    ? t(`confirm${pendingControl.action === "pause" ? "Pause" : pendingControl.action === "resume" ? "Resume" : "Run"}Title`)
    : "";
  const confirmationDescription = pendingControl
    ? t(
        `confirm${pendingControl.action === "pause" ? "Pause" : pendingControl.action === "resume" ? "Resume" : "Run"}Description`,
        {name: pendingControl.job.name},
      )
    : "";
  const visibleJobs = jobsProfile === profile ? jobs : [];

  return (
    <main className={cn("product-page min-h-full bg-background px-4 pb-8 sm:px-6", className)} id="main-content">
      <div className="product-page-content mx-auto w-full max-w-[70rem]">
        <header className="product-page-header flex min-h-12 items-center gap-3 border-b border-border">
          <CalendarClock aria-hidden="true" className="size-5 shrink-0 text-primary" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{t("title")}</h1>
          {stale ? <Badge tone="warning">{t("stale")}</Badge> : null}
          <Button
            disabled={loading || !available}
            onClick={() => void loadJobs()}
            size="sm"
            variant="secondary"
          >
            {loading ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw aria-hidden="true" className="size-4" />
            )}
            {t("refresh")}
          </Button>
        </header>

        <div className="product-page-intro py-4">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("description")}</p>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        ) : null}

        <div aria-live="polite" className="sr-only">
          {queuedJobId?.startsWith(`${profile}:`) ? t("queuedForScheduler") : ""}
        </div>

        <div className="product-surface overflow-hidden rounded-xl border border-border bg-surface">
          {!available ? (
            <section className="flex items-start gap-3 px-4 py-6 sm:px-5">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{t("unavailableTitle")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("unavailableDescription")}</p>
              </div>
            </section>
          ) : null}

          {available && (loading || jobsProfile !== profile) && visibleJobs.length === 0 ? (
            <div className="divide-y divide-border" aria-hidden="true">
              {[0, 1, 2, 3].map((item) => (
                <div
                  className="h-24 animate-pulse bg-muted/35 motion-reduce:animate-none"
                  key={item}
                />
              ))}
            </div>
          ) : null}

          {available && !loading && jobsProfile === profile && visibleJobs.length === 0 ? (
            <section className="flex items-start gap-3 px-4 py-6 sm:px-5">
              <CalendarClock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{t("emptyTitle")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("emptyDescription")}</p>
              </div>
            </section>
          ) : null}

          <div className="automation-list divide-y divide-border">
            {visibleJobs.map((job) => {
            const scopeKey = `${profile}:${job.id}`;
            const isExpanded = expandedId === scopeKey;
            const jobDetails = details[scopeKey];
            const mutationsDisabled = !canMutate || stale;
            const runDisabled =
              mutationsDisabled || job.state === "paused" || job.state === "running" || queuedJobId === scopeKey;
              return (
                <article className="automation-row min-w-0" key={job.id}>
                  <div className="grid min-w-0 gap-4 p-4 sm:px-5 xl:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.45fr)_auto] xl:items-start">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <CalendarClock aria-hidden="true" className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <BidiBlock as="h2" className="text-sm font-semibold text-foreground">
                          {job.name}
                        </BidiBlock>
                        <TechnicalInline className="mt-1 block truncate text-xs text-muted-foreground">
                          {job.id}
                        </TechnicalInline>
                      </div>
                      <JobStateBadge job={job} />
                    </div>

                    <dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-4 xl:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{t("schedule")}</dt>
                        <dd className="mt-0.5 truncate"><TechnicalInline>{job.schedule}</TechnicalInline></dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{t("nextRun")}</dt>
                        <dd className="mt-0.5 truncate">{formatDate(job.nextRunAt, locale)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{t("lastRun")}</dt>
                        <dd className="mt-0.5 truncate">{formatDate(job.lastRunAt, locale)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{t("delivery")}</dt>
                        <dd className="mt-0.5 truncate"><BidiBlock>{job.delivery ?? "—"}</BidiBlock></dd>
                      </div>
                    </dl>

                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      {job.state === "paused" ? (
                        <Button
                          disabled={mutationsDisabled}
                          onClick={() => setPendingControl({action: "resume", job})}
                          size="sm"
                          variant="secondary"
                        >
                          <CirclePlay aria-hidden="true" className="size-4" />
                          {t("resume")}
                        </Button>
                      ) : (
                        <Button
                          disabled={mutationsDisabled || job.state === "running"}
                          onClick={() => setPendingControl({action: "pause", job})}
                          size="sm"
                          variant="secondary"
                        >
                          <CirclePause aria-hidden="true" className="size-4" />
                          {t("pause")}
                        </Button>
                      )}
                      <Button
                        disabled={runDisabled}
                        onClick={() => setPendingControl({action: "run", job})}
                        size="sm"
                      >
                        <Play aria-hidden="true" className="size-4" />
                        {t("run")}
                      </Button>
                      <Button
                        aria-controls={`automation-details-${job.id}`}
                        aria-expanded={isExpanded}
                        onClick={() => void loadDetails(job.id)}
                        size="sm"
                        variant="ghost"
                      >
                        {t("details")}
                        {isExpanded ? (
                          <ChevronUp aria-hidden="true" className="size-4" />
                        ) : (
                          <ChevronDown aria-hidden="true" className="size-4" />
                        )}
                      </Button>
                    </div>

                    {job.lastError || job.lastDeliveryError ? (
                      <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive xl:col-span-3">
                        <BidiBlock>{job.lastError ?? job.lastDeliveryError}</BidiBlock>
                      </div>
                    ) : null}

                    {queuedJobId === scopeKey ? (
                      <p className="flex items-center gap-2 text-sm text-warning-foreground xl:col-span-2">
                        <Clock3 aria-hidden="true" className="size-4" />
                        {t("queuedForScheduler")}
                      </p>
                    ) : null}
                    {!canMutate ? (
                      <p className="text-xs text-muted-foreground xl:col-span-3">{t("readOnly")}</p>
                    ) : null}
                  </div>

                  {isExpanded ? (
                    <div
                      className="automation-details border-t border-border bg-background/30 p-4 sm:px-5"
                      id={`automation-details-${job.id}`}
                    >
                      {jobDetails?.loading ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                          {t("loadingDetails")}
                        </p>
                      ) : (
                        <div className="grid gap-6 lg:grid-cols-2">
                          <section className="min-w-0">
                            <h3 className="text-sm font-semibold">{t("recentRuns")}</h3>
                            {jobDetails?.runs.length ? (
                              <ol className="mt-2 divide-y divide-border border-y border-border">
                                {jobDetails.runs.map((run) => (
                                  <li className="py-3 text-sm" key={run.id}>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <TechnicalInline className="min-w-0 flex-1 truncate">{run.id}</TechnicalInline>
                                      <Badge>{run.status}</Badge>
                                    </div>
                                    {run.summary ? <BidiBlock className="mt-2">{run.summary}</BidiBlock> : null}
                                    {run.error ? <BidiBlock className="mt-2 text-destructive">{run.error}</BidiBlock> : null}
                                    {run.sessionId && onOpenSession ? (
                                      <Button
                                        className="mt-2"
                                        onClick={() => onOpenSession(profile, run.sessionId!)}
                                        size="sm"
                                        variant="ghost"
                                      >
                                        <ExternalLink aria-hidden="true" className="size-4" />
                                        {t("openRunSession")}
                                      </Button>
                                    ) : null}
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p className="mt-2 text-sm text-muted-foreground">{t("noRuns")}</p>
                            )}
                          </section>

                          <section className="min-w-0">
                            <h3 className="text-sm font-semibold">{t("savedOutputs")}</h3>
                            {jobDetails?.outputs.length ? (
                              <ol className="mt-2 divide-y divide-border border-y border-border">
                                {jobDetails.outputs.map((output) => {
                                  const downloadUrl = safeDownloadUrl(output.downloadUrl);
                                  return (
                                    <li className="py-3 text-sm" key={output.id}>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <FileText aria-hidden="true" className="size-4 text-primary" />
                                        <BidiBlock className="min-w-0 flex-1 font-medium">{output.name}</BidiBlock>
                                        {downloadUrl ? (
                                          <a className="text-xs font-medium text-primary hover:underline" href={downloadUrl}>
                                            {t("download")}
                                          </a>
                                        ) : null}
                                      </div>
                                      {output.markdown ? (
                                        <BidiBlock className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/45 p-2 text-xs">
                                          {output.markdown}
                                        </BidiBlock>
                                      ) : (
                                        <Button
                                          className="mt-2"
                                          disabled={Boolean(outputLoadingKey)}
                                          onClick={() => void loadOutput(job.id, output.id)}
                                          size="sm"
                                          variant="ghost"
                                        >
                                          {outputLoadingKey === `${profile}:${job.id}:${output.id}` ? (
                                            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                                          ) : (
                                            <FileText aria-hidden="true" className="size-4" />
                                          )}
                                          {t("viewOutput")}
                                        </Button>
                                      )}
                                    </li>
                                  );
                                })}
                              </ol>
                            ) : (
                              <p className="mt-2 text-sm text-muted-foreground">{t("noOutputs")}</p>
                            )}
                          </section>
                        </div>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>

      <ConfirmActionDialog
        cancelLabel={actions("cancel")}
        confirmLabel={actions("confirm")}
        description={confirmationDescription}
        onConfirm={executeControl}
        onOpenChange={(open) => {
          if (!open && !controlBusy) setPendingControl(undefined);
        }}
        open={Boolean(pendingControl)}
        pending={controlBusy}
        title={confirmationTitle}
      />
    </main>
  );
}
