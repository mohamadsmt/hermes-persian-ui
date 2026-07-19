"use client";

import {
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  FileDiff,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {useLocale, useTranslations} from "next-intl";
import {useCallback, useEffect, useState} from "react";

import {BidiBlock, TechnicalInline} from "@/components/chat/bidi-text";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {cn} from "@/components/ui/utils";
import {ConfirmActionDialog} from "@/components/workspace/confirm-action-dialog";

import {
  type LearningApi,
  type LearningDetail,
  type LearningKind,
  type LearningNode,
  type PendingOperation,
  type PendingWrite,
  defaultLearningApi,
} from "./learning-api";

const MAX_SKILL_DIFF_CHARACTERS = 512 * 1024;

interface SkillDiffState {
  content?: string;
  error?: string;
  loading: boolean;
  valid: boolean;
}

interface PendingDecision {
  action: "approve" | "reject";
  item: PendingWrite;
}

export type ExecuteLearningCommand = (
  command: string,
) => Promise<string | {output: string; warning?: string}>;

export interface KnowledgePanelProps {
  activeSessionId?: string | null;
  api?: LearningApi;
  available?: boolean;
  canReview?: boolean;
  className?: string;
  executeCommand?: ExecuteLearningCommand;
  profile: string;
  sessionRunning?: boolean;
}

function safePendingId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id);
}

export function isValidSkillDiff(content: string, id: string): boolean {
  if (!safePendingId(id) || !content || content.length > MAX_SKILL_DIFF_CHARACTERS) return false;
  const header = `# Pending skill write ${id}:`;
  if (!content.startsWith(header)) return false;
  const body = content.slice(content.indexOf("\n") + 1).trim();
  return Boolean(body) && !/^(?:No pending|Usage:|Error:|Failed:)/imu.test(body);
}

export function isSuccessfulPendingDecision(
  output: string,
  kind: LearningKind,
  action: "approve" | "reject",
  id: string,
): boolean {
  const namespace = kind === "skill" ? "skills" : "memory";
  if (/\b(?:No pending|Failed:|Approved 0|Rejected 0|Usage:)\b/iu.test(output)) return false;
  if (action === "approve") {
    return output.trim().startsWith(`Approved 1 ${namespace} write(s).`);
  }
  return output.trim().startsWith(`Rejected pending ${namespace} write '${id}'.`);
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short"}).format(date);
}

function operationTone(action: PendingOperation["action"]): "danger" | "neutral" | "success" | "warning" {
  if (action === "add") return "success";
  if (action === "remove") return "danger";
  if (action === "replace") return "warning";
  return "neutral";
}

function KindBadge({kind}: {kind: LearningKind}) {
  const t = useTranslations("Knowledge");
  return (
    <Badge className="shrink-0" tone={kind === "skill" ? "accent" : "neutral"}>
      {kind === "skill" ? t("skill") : t("memory")}
    </Badge>
  );
}

function PendingOperations({operations}: {operations: PendingOperation[]}) {
  const t = useTranslations("Knowledge");
  if (!operations.length) {
    return <p className="mt-3 text-xs text-muted-foreground">{t("noStructuredChanges")}</p>;
  }
  return (
    <div className="mt-3 divide-y divide-border border-y border-border">
      {operations.map((operation, index) => (
        <article className="py-3" key={`${operation.path ?? "change"}:${index}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={operationTone(operation.action)}>{t(`operation${operation.action === "add" ? "Add" : operation.action === "remove" ? "Remove" : operation.action === "replace" ? "Replace" : "Unknown"}`)}</Badge>
            {operation.path ? <TechnicalInline className="text-xs text-muted-foreground">{operation.path}</TechnicalInline> : null}
          </div>
          {operation.before ? (
            <div className="mt-2">
              <p className="text-xs font-medium text-muted-foreground">{t("before")}</p>
              <BidiBlock className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-destructive/5 px-2 py-1.5 text-xs">
                {operation.before}
              </BidiBlock>
            </div>
          ) : null}
          {operation.after ? (
            <div className="mt-2">
              <p className="text-xs font-medium text-muted-foreground">{t("after")}</p>
              <BidiBlock className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-success/5 px-2 py-1.5 text-xs">
                {operation.after}
              </BidiBlock>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function KnowledgePanel({
  activeSessionId,
  api = defaultLearningApi,
  available = true,
  canReview = false,
  className,
  executeCommand,
  profile,
  sessionRunning = false,
}: KnowledgePanelProps) {
  const t = useTranslations("Knowledge");
  const actions = useTranslations("Actions");
  const locale = useLocale();
  const [timeline, setTimeline] = useState<LearningNode[]>([]);
  const [pending, setPending] = useState<PendingWrite[]>([]);
  const [knowledgeProfile, setKnowledgeProfile] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [kindFilter, setKindFilter] = useState<"all" | LearningKind>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<LearningDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, SkillDiffState>>({});
  const [decision, setDecision] = useState<PendingDecision>();
  const [decisionBusy, setDecisionBusy] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!available || !profile) {
        setTimeline([]);
        setPending([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const [nextTimeline, nextPending] = await Promise.all([
          api.timeline(profile, signal),
          api.pending(profile, signal),
        ]);
        if (signal?.aborted) return;
        setTimeline(nextTimeline);
        setPending(nextPending);
        setKnowledgeProfile(profile);
        setError(undefined);
        setStale(false);
      } catch (requestError) {
        if (signal?.aborted) return;
        setError(requestError instanceof Error ? requestError.message : t("loadFailed"));
        setStale(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [api, available, profile, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSelectedId(undefined);
    setDetail(undefined);
    setDiffs({});
    void refresh(controller.signal);
    return () => controller.abort();
  }, [profile, refresh]);

  async function openDetail(node: LearningNode) {
    if (selectedId === node.id) {
      setSelectedId(undefined);
      setDetail(undefined);
      return;
    }
    setSelectedId(node.id);
    setDetailLoading(true);
    try {
      const nextDetail = await api.detail(profile, node.id);
      setDetail(nextDetail);
      setError(undefined);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("detailFailed"));
      setDetail(undefined);
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadSkillDiff(item: PendingWrite) {
    if (!executeCommand || !safePendingId(item.id)) return;
    setDiffs((current) => ({...current, [item.id]: {loading: true, valid: false}}));
    try {
      const result = await executeCommand(`/skills diff ${item.id}`);
      const content = typeof result === "string" ? result : result.output;
      const warning = typeof result === "string" ? undefined : result.warning;
      if (warning || !isValidSkillDiff(content, item.id)) {
        setDiffs((current) => ({
          ...current,
          [item.id]: {
            error: content.length > MAX_SKILL_DIFF_CHARACTERS
              ? t("diffTooLarge")
              : t("diffUnavailable"),
            loading: false,
            valid: false,
          },
        }));
        return;
      }
      setDiffs((current) => ({
        ...current,
        [item.id]: {content, loading: false, valid: true},
      }));
    } catch (requestError) {
      setDiffs((current) => ({
        ...current,
        [item.id]: {
          error: requestError instanceof Error ? requestError.message : t("diffUnavailable"),
          loading: false,
          valid: false,
        },
      }));
    }
  }

  async function executeDecision() {
    if (!decision || !executeCommand || !reviewAllowed || !safePendingId(decision.item.id)) return;
    setDecisionBusy(true);
    const namespace = decision.item.kind === "skill" ? "skills" : "memory";
    try {
      const result = await executeCommand(`/${namespace} ${decision.action} ${decision.item.id}`);
      const output = typeof result === "string" ? result : result.output;
      const warning = typeof result === "string" ? undefined : result.warning;
      if (warning || !isSuccessfulPendingDecision(
        output,
        decision.item.kind,
        decision.action,
        decision.item.id,
      )) {
        throw new Error(t("decisionFailed"));
      }
      setDecision(undefined);
      setDiffs((current) => {
        const next = {...current};
        delete next[decision.item.id];
        return next;
      });
      setLoading(true);
      await refresh();
    } catch (requestError) {
      // Pending IDs are single-use. Refresh exactly once; do not replay the mutation.
      setError(requestError instanceof Error ? requestError.message : t("decisionFailed"));
      setDecision(undefined);
      await refresh();
    } finally {
      setDecisionBusy(false);
    }
  }

  const reviewAllowed =
    available &&
    canReview &&
    Boolean(activeSessionId) &&
    !sessionRunning &&
    !stale &&
    Boolean(executeCommand);
  const visibleTimeline = knowledgeProfile === profile ? timeline : [];
  const visiblePending = knowledgeProfile === profile ? pending : [];
  const filteredTimeline = visibleTimeline.filter((node) => kindFilter === "all" || node.kind === kindFilter);

  return (
    <main className={cn("product-page min-h-full bg-background px-4 pb-8 sm:px-6", className)} id="main-content">
      <div className="product-page-content mx-auto w-full max-w-[70rem] [container-type:inline-size]">
        <header className="product-page-header flex min-h-12 items-center gap-3 border-b border-border">
          <Brain aria-hidden="true" className="size-5 shrink-0 text-primary" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{t("title")}</h1>
          {stale ? <Badge tone="warning">{t("stale")}</Badge> : null}
          <Button
            disabled={loading || !available}
            onClick={() => void refresh()}
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

        {!available ? (
          <section className="product-surface flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-6 sm:px-5">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t("unavailableTitle")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("unavailableDescription")}</p>
            </div>
          </section>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        ) : null}

        {available ? (
          <div className="product-surface knowledge-layout grid min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
            <section className="knowledge-pane knowledge-timeline-pane min-w-0 overflow-hidden">
              <header className="flex min-h-12 flex-wrap items-center gap-3 border-b border-border px-4 py-2 sm:px-5">
                <BookOpen aria-hidden="true" className="size-4 text-primary" />
                <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("timeline")}</h2>
                <div aria-label={t("filterLabel")} className="flex rounded-lg bg-muted p-1" role="group">
                  {(["all", "memory", "skill"] as const).map((filter) => (
                    <button
                      aria-pressed={kindFilter === filter}
                      className={cn(
                        "min-h-8 rounded-md px-2.5 text-xs font-medium transition-colors",
                        kindFilter === filter ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                      )}
                      key={filter}
                      onClick={() => setKindFilter(filter)}
                      type="button"
                    >
                      {filter === "all" ? t("all") : filter === "memory" ? t("memory") : t("skill")}
                    </button>
                  ))}
                </div>
              </header>

              <div className="p-4 sm:px-5">
                {loading && visibleTimeline.length === 0 ? (
                  <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    {t("loading")}
                  </p>
                ) : null}
                {!loading && filteredTimeline.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t("emptyTimeline")}</p>
                ) : null}
                <ol className="divide-y divide-border border-y border-border">
                  {filteredTimeline.map((node) => {
                    const expanded = selectedId === node.id;
                    return (
                      <li className="min-w-0" key={node.id}>
                        <button
                          aria-expanded={expanded}
                          className="flex min-h-12 w-full items-center gap-3 px-2 py-2 text-start transition-colors hover:bg-muted/35 focus-visible:bg-muted/35"
                          data-testid="knowledge-timeline-row"
                          onClick={() => void openDetail(node)}
                          type="button"
                        >
                          {node.kind === "skill" ? (
                            <Sparkles aria-hidden="true" className="size-4 shrink-0 text-primary" />
                          ) : (
                            <Brain aria-hidden="true" className="size-4 shrink-0 text-primary" />
                          )}
                          <span className="min-w-0 flex-1 overflow-hidden rtl:w-0">
                            <BidiBlock
                              as="span"
                              className="block w-full truncate text-sm font-medium"
                              data-testid="knowledge-timeline-title"
                            >
                              {node.title}
                            </BidiBlock>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {formatDate(node.createdAt ?? node.updatedAt, locale)}
                            </span>
                          </span>
                          <KindBadge kind={node.kind} />
                          {expanded ? <ChevronUp aria-hidden="true" className="size-4 shrink-0" /> : <ChevronDown aria-hidden="true" className="size-4 shrink-0" />}
                        </button>
                        {expanded ? (
                          <div className="border-t border-border bg-background/30 px-3 py-3">
                            {detailLoading ? (
                              <LoaderCircle aria-label={t("loadingDetail")} className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
                            ) : (
                              <>
                                {detail?.summary ?? node.summary ? (
                                  <BidiBlock className="text-sm text-muted-foreground">{detail?.summary ?? node.summary}</BidiBlock>
                                ) : null}
                                {detail?.body ?? node.body ? (
                                  <BidiBlock className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/45 p-3 text-sm">
                                    {detail?.body ?? node.body}
                                  </BidiBlock>
                                ) : null}
                              </>
                            )}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </section>

            <section className="knowledge-pane knowledge-review-pane min-w-0 overflow-hidden border-t border-border">
              <header className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2 sm:px-5">
                <ShieldAlert aria-hidden="true" className="size-4 text-primary" />
                <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("pendingReviews")}</h2>
                <Badge>{visiblePending.length}</Badge>
              </header>
              <div className="p-4 sm:px-5">
                {!reviewAllowed ? (
                  <div className="mb-4 rounded-lg border border-warning/25 bg-warning/10 p-3 text-sm text-warning-foreground">
                    {sessionRunning
                      ? t("readOnlyRunning")
                      : !activeSessionId
                        ? t("readOnlyNoSession")
                        : t("readOnlyConnection")}
                  </div>
                ) : null}
                {!loading && visiblePending.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t("emptyPending")}</p>
                ) : null}
                <ol className="divide-y divide-border border-y border-border">
                  {visiblePending.map((item) => {
                    const diff = diffs[item.id];
                    const safeId = safePendingId(item.id);
                    const approveAllowed =
                      reviewAllowed && safeId && (item.kind === "memory" || diff?.valid === true);
                    return (
                      <li className="py-4" key={`${item.kind}:${item.id}`}>
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <BidiBlock as="h3" className="text-sm font-semibold">{item.title}</BidiBlock>
                            <TechnicalInline className="mt-1 block text-xs text-muted-foreground">{item.id}</TechnicalInline>
                          </div>
                          <KindBadge kind={item.kind} />
                        </div>
                        {item.summary ? <BidiBlock className="mt-3 text-sm text-muted-foreground">{item.summary}</BidiBlock> : null}
                        {item.origin ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t("origin")}: <TechnicalInline>{item.origin}</TechnicalInline>
                          </p>
                        ) : null}
                        {item.kind === "memory" ? <PendingOperations operations={item.operations} /> : null}

                        {item.kind === "skill" ? (
                          <div className="mt-3">
                            <Button
                              disabled={!reviewAllowed || diff?.loading || !safeId}
                              onClick={() => void loadSkillDiff(item)}
                              size="sm"
                              variant="secondary"
                            >
                              {diff?.loading ? (
                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                              ) : (
                                <FileDiff aria-hidden="true" className="size-4" />
                              )}
                              {t("loadSkillDiff")}
                            </Button>
                            {diff?.error ? <p className="mt-2 text-xs text-destructive">{diff.error}</p> : null}
                            {diff?.content ? (
                              <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted/45 p-3 text-xs">
                                <code>{diff.content}</code>
                              </pre>
                            ) : null}
                          </div>
                        ) : null}

                        {!safeId ? <p className="mt-3 text-xs text-destructive">{t("invalidPendingId")}</p> : null}
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            disabled={!approveAllowed}
                            onClick={() => setDecision({action: "approve", item})}
                            size="sm"
                          >
                            <Check aria-hidden="true" className="size-4" />
                            {t("approve")}
                          </Button>
                          <Button
                            disabled={!reviewAllowed || !safeId}
                            onClick={() => setDecision({action: "reject", item})}
                            size="sm"
                            variant="secondary"
                          >
                            <X aria-hidden="true" className="size-4" />
                            {t("reject")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </section>
          </div>
        ) : null}
      </div>

      <ConfirmActionDialog
        cancelLabel={actions("cancel")}
        confirmLabel={decision?.action === "reject" ? t("reject") : t("approve")}
        description={decision ? t(decision.action === "approve" ? "approveDescription" : "rejectDescription", {name: decision.item.title}) : ""}
        destructive={decision?.action === "reject"}
        onConfirm={executeDecision}
        onOpenChange={(open) => {
          if (!open && !decisionBusy) setDecision(undefined);
        }}
        open={Boolean(decision)}
        pending={decisionBusy}
        title={decision ? t(decision.action === "approve" ? "approveTitle" : "rejectTitle") : ""}
      />
    </main>
  );
}
