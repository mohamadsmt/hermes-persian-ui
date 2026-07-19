"use client";

import {
  Activity,
  Bot,
  Brain,
  CheckCircle2,
  Clock3,
  FileDiff,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import {useLocale, useTranslations} from "next-intl";
import type {ComponentType, SVGProps} from "react";

import {BidiBlock, TechnicalInline} from "@/components/chat/bidi-text";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {cn} from "@/components/ui/utils";

import {
  type ActivityScopeState,
  type ActivityState,
  type ActivityStatus,
  selectActivityScope,
} from "./activity-reducer";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export interface ActivityCenterProps {
  activity: ActivityState;
  activeSessionId?: string | null;
  activeSessionTitle?: string;
  className?: string;
  loading?: boolean;
  onRefresh?: () => void | Promise<void>;
  stale?: boolean;
}

function toneForStatus(status: ActivityStatus): "danger" | "neutral" | "success" | "warning" {
  if (status === "complete") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "running" || status === "queued") return "warning";
  return "neutral";
}

function ActivityStatusBadge({status}: {status: ActivityStatus}) {
  const t = useTranslations("Activity");
  const label = {
    cancelled: t("statusCancelled"),
    complete: t("statusComplete"),
    failed: t("statusFailed"),
    queued: t("statusQueued"),
    running: t("statusRunning"),
    unknown: t("statusUnknown"),
  }[status];
  return <Badge tone={toneForStatus(status)}>{label}</Badge>;
}

function Section({
  children,
  count,
  icon: IconComponent,
  title,
}: {
  children: React.ReactNode;
  count?: number;
  icon: Icon;
  title: string;
}) {
  return (
    <section className="product-section grid min-w-0 gap-0 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <header className="flex min-h-12 items-center gap-2.5 px-4 py-3 lg:items-start lg:border-e lg:border-border lg:py-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <IconComponent aria-hidden="true" className="size-4" />
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{title}</h2>
        {typeof count === "number" ? <Badge>{count.toLocaleString()}</Badge> : null}
      </header>
      <div className="min-w-0 border-t border-border p-4 lg:border-t-0">{children}</div>
    </section>
  );
}

function EmptySection() {
  const t = useTranslations("Activity");
  return <p className="py-3 text-sm text-muted-foreground">{t("emptySection")}</p>;
}

function ToolList({scope}: {scope: ActivityScopeState}) {
  const t = useTranslations("Activity");
  if (!scope.tools.length) return <EmptySection />;

  return (
    <ol className="divide-y divide-border">
      {scope.tools.map((tool) => (
        <li className="py-3 first:pt-0 last:pb-0" key={tool.id}>
          <div className="flex flex-wrap items-center gap-2">
            <TechnicalInline className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
              {tool.name}
            </TechnicalInline>
            <ActivityStatusBadge status={tool.status} />
          </div>
          {tool.progressText ? (
            <BidiBlock className="mt-2 text-sm text-muted-foreground">{tool.progressText}</BidiBlock>
          ) : null}
          {tool.summary ? <BidiBlock className="mt-2 text-sm">{tool.summary}</BidiBlock> : null}
          {typeof tool.durationSeconds === "number" ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 aria-hidden="true" className="size-3.5" />
              {t("duration", {seconds: tool.durationSeconds.toLocaleString()})}
            </p>
          ) : null}
          {tool.inlineDiff ? (
            <details className="mt-3 rounded-lg bg-muted/45">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                {t("inlineDiff")}
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-border p-3 text-xs">
                <code>{tool.inlineDiff}</code>
              </pre>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function SubagentList({scope}: {scope: ActivityScopeState}) {
  const t = useTranslations("Activity");
  if (!scope.subagents.length && !scope.delegation) return <EmptySection />;
  const byId = new Map(scope.subagents.map((agent) => [agent.id, agent]));
  const depthFor = (id: string) => {
    let depth = 0;
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current?.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      depth += 1;
      current = byId.get(current.parentId);
      if (depth === 5) break;
    }
    return depth;
  };

  return (
    <ol className="divide-y divide-border">
      {scope.delegation ? (
        <li className="border-s-2 border-primary py-3 ps-3 first:pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm font-medium">{t("delegation")}</span>
            <ActivityStatusBadge status={scope.delegation.status} />
          </div>
          {typeof scope.delegation.activeCount === "number" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("activeSubagents", {count: scope.delegation.activeCount})}
            </p>
          ) : null}
          {scope.delegation.summary ? (
            <BidiBlock className="mt-2 text-sm">{scope.delegation.summary}</BidiBlock>
          ) : null}
        </li>
      ) : null}
      {scope.subagents.map((agent) => (
        <li
          className="py-3 last:pb-0"
          key={agent.id}
          style={{marginInlineStart: `${depthFor(agent.id) * 12}px`}}
        >
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch aria-hidden="true" className="size-4 shrink-0 text-primary" />
            <BidiBlock as="h3" className="min-w-0 flex-1 text-sm font-medium">
              {agent.label}
            </BidiBlock>
            <ActivityStatusBadge status={agent.status} />
          </div>
          {agent.summary ? (
            <BidiBlock className="mt-2 text-sm text-muted-foreground">{agent.summary}</BidiBlock>
          ) : null}
          {agent.entries.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {t("streamEntries", {count: agent.entries.length})}
              </summary>
              <div className="mt-2 grid max-h-52 gap-1.5 overflow-y-auto rounded-lg bg-muted/45 p-2.5">
                {agent.entries.map((entry, index) => (
                  <BidiBlock className="text-xs" key={`${agent.id}:${index}`}>
                    {entry}
                  </BidiBlock>
                ))}
              </div>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function RuntimeScope({scope}: {scope: ActivityScopeState}) {
  const t = useTranslations("Activity");
  const locale = useLocale();
  const hasContent =
    scope.backgroundCompletions.length > 0 ||
    scope.processes.length > 0 ||
    Boolean(scope.delegation);
  if (!hasContent) return <EmptySection />;

  return (
    <div className="divide-y divide-border">
      {scope.delegation ? (
        <article className="border-s-2 border-primary py-3 ps-3 first:pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm font-medium">{t("delegation")}</span>
            <ActivityStatusBadge status={scope.delegation.status} />
          </div>
          {typeof scope.delegation.activeCount === "number" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("activeSubagents", {count: scope.delegation.activeCount})}
            </p>
          ) : null}
          {scope.delegation.summary ? (
            <BidiBlock className="mt-2 text-sm">{scope.delegation.summary}</BidiBlock>
          ) : null}
        </article>
      ) : null}

      {scope.processes.map((process) => (
        <article className="py-3 last:pb-0" key={process.id}>
          <div className="flex flex-wrap items-center gap-2">
            <TerminalSquare aria-hidden="true" className="size-4 text-primary" />
            <BidiBlock className="min-w-0 flex-1 text-sm font-medium">{process.label}</BidiBlock>
            <ActivityStatusBadge status={process.status} />
          </div>
          {process.command ? (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 text-xs">
              <code>{process.command}</code>
            </pre>
          ) : null}
        </article>
      ))}

      {scope.backgroundCompletions.map((completion) => (
        <article
          className="py-3 last:pb-0"
          key={completion.id}
        >
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
            <BidiBlock className="min-w-0 flex-1 text-sm font-medium">{completion.label}</BidiBlock>
            <ActivityStatusBadge status={completion.status} />
          </div>
          {completion.summary ? (
            <BidiBlock className="mt-2 text-sm text-muted-foreground">
              {completion.summary}
            </BidiBlock>
          ) : null}
          <time
            className="mt-2 block text-xs text-muted-foreground"
            dateTime={new Date(completion.completedAt).toISOString()}
          >
            {new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short"}).format(
              completion.completedAt,
            )}
          </time>
        </article>
      ))}
    </div>
  );
}

function VerificationCard({scope}: {scope: ActivityScopeState}) {
  const t = useTranslations("Activity");
  if (!scope.verification) return <EmptySection />;
  return (
    <article className="py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t("bestRecordedEvidence")}</Badge>
        <ActivityStatusBadge status={scope.verification.status} />
      </div>
      {scope.verification.summary ? (
        <BidiBlock className="mt-3 text-sm">{scope.verification.summary}</BidiBlock>
      ) : null}
      {scope.verification.command ? (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 text-xs">
          <code>{scope.verification.command}</code>
        </pre>
      ) : null}
      {scope.verification.details ? (
        <BidiBlock className="mt-3 text-xs text-muted-foreground">
          {scope.verification.details}
        </BidiBlock>
      ) : null}
    </article>
  );
}

export function ActivityCenter({
  activity,
  activeSessionId,
  activeSessionTitle,
  className,
  loading = false,
  onRefresh,
  stale = false,
}: ActivityCenterProps) {
  const t = useTranslations("Activity");
  const scope = selectActivityScope(activity, activeSessionId);
  const noSession = !activeSessionId;

  return (
    <main className={cn("product-page min-h-full bg-background px-4 pb-8 sm:px-6", className)} id="main-content">
      <div className="product-page-content mx-auto w-full max-w-[70rem]">
        <header className="product-page-header flex min-h-12 items-center gap-3 border-b border-border">
          <Activity aria-hidden="true" className="size-5 shrink-0 text-primary" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{t("title")}</h1>
          {stale ? <Badge tone="warning">{t("stale")}</Badge> : null}
          {onRefresh ? (
            <Button disabled={loading} onClick={() => void onRefresh()} size="sm" variant="secondary">
              {loading ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <RefreshCw aria-hidden="true" className="size-4" />
              )}
              {t("refresh")}
            </Button>
          ) : null}
        </header>

        <div className="product-page-intro py-4">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("description")}</p>
          {activeSessionTitle ? (
            <BidiBlock className="mt-1.5 text-sm font-medium">{activeSessionTitle}</BidiBlock>
          ) : null}
        </div>

        <div className="product-surface overflow-hidden rounded-xl border border-border bg-surface divide-y divide-border">
          {noSession ? (
            <section className="flex items-start gap-3 px-4 py-4">
              <Bot aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{t("noSessionTitle")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("noSessionDescription")}</p>
              </div>
            </section>
          ) : null}

          <Section icon={Brain} title={t("reasoning")}>
            {scope.reasoning ? (
              <BidiBlock className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/45 p-3 text-sm">
                {scope.reasoning}
              </BidiBlock>
            ) : (
              <EmptySection />
            )}
          </Section>
          <Section count={scope.subagents.length} icon={Bot} title={t("subagents")}>
            <SubagentList scope={scope} />
          </Section>
          <Section count={scope.tools.length} icon={FileDiff} title={t("tools")}>
            <ToolList scope={scope} />
          </Section>
          <Section icon={ShieldCheck} title={t("verification")}>
            <VerificationCard scope={scope} />
          </Section>
          <Section
            count={scope.processes.length + scope.backgroundCompletions.length}
            icon={TerminalSquare}
            title={t("sessionActivity")}
          >
            <RuntimeScope scope={scope} />
          </Section>
          <Section
            count={activity.runtime.processes.length + activity.runtime.backgroundCompletions.length}
            icon={TerminalSquare}
            title={t("runtimeWide")}
          >
            <RuntimeScope scope={activity.runtime} />
          </Section>
        </div>
      </div>
    </main>
  );
}
