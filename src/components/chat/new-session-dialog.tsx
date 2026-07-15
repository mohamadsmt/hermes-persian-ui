"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { FolderGit2, LoaderCircle, MessageSquarePlus, X } from "lucide-react";
import { FormEvent, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { ModelOption, SessionCreateInput } from "@/lib/hermes";

export interface NewSessionProject {
  cwd?: string;
  id: string;
  name: string;
}

export interface NewSessionSubmission extends SessionCreateInput {
  projectId?: string;
}

export interface CwdValidationResult {
  canonicalPath?: string;
  error?: string;
  valid: boolean;
}

export interface NewSessionDialogProps {
  defaultCwd?: string;
  defaultProfile?: string;
  defaultProjectId?: string;
  labels?: Partial<NewSessionLabels>;
  locale: string;
  models: ModelOption[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: NewSessionSubmission) => void | Promise<void>;
  onValidateCwd?: (profile: string, cwd: string) => Promise<CwdValidationResult>;
  open: boolean;
  pending?: boolean;
  profiles: string[];
  projects?: NewSessionProject[];
}

export interface NewSessionLabels {
  cancel: string;
  create: string;
  cwd: string;
  cwdHelp: string;
  defaultValue: string;
  description: string;
  fast: string;
  fastOff: string;
  fastOn: string;
  model: string;
  profile: string;
  project: string;
  provider: string;
  reasoning: string;
  title: string;
  validationFailed: string;
}

type FastChoice = "default" | "on" | "off";

export function NewSessionDialog(props: NewSessionDialogProps) {
  return (
    <Dialog.Root onOpenChange={props.onOpenChange} open={props.open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        {props.open ? <NewSessionDialogContent {...props} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewSessionDialogContent({
  defaultCwd,
  defaultProfile,
  defaultProjectId,
  labels: labelOverrides,
  locale,
  models,
  onOpenChange,
  onSubmit,
  onValidateCwd,
  pending = false,
  profiles,
  projects = [],
}: NewSessionDialogProps) {
  const labels = newSessionLabels(locale, labelOverrides);
  const initialProject = projects.find((project) => project.id === defaultProjectId);
  const [profile, setProfile] = useState(defaultProfile || profiles[0] || "");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [cwd, setCwd] = useState(defaultCwd ?? initialProject?.cwd ?? "");
  const [modelKey, setModelKey] = useState("");
  const [provider, setProvider] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [fast, setFast] = useState<FastChoice>("default");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelOptions = useMemo(
    () => models.map((model, index) => ({ key: String(index), model })),
    [models],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || submitting || !profile.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = buildNewSessionSubmission({
        cwd,
        fast,
        model: modelKey ? modelOptions[Number(modelKey)]?.model.id : "",
        profile,
        projectId,
        provider,
        reasoning,
      });

      if (payload.cwd && onValidateCwd) {
        const validation = await onValidateCwd(payload.profile ?? profile.trim(), payload.cwd);
        if (!validation.valid) {
          setError(validation.error || labels.validationFailed);
          return;
        }
        if (validation.canonicalPath?.trim()) payload.cwd = validation.canonicalPath.trim();
      }

      await onSubmit(payload);
      onOpenChange(false);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : labels.validationFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const busy = pending || submitting;

  return (
    <Dialog.Content
      className="fixed left-1/2 top-1/2 z-50 max-h-[min(90dvh,48rem)] w-[min(94vw,38rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
      data-testid="new-session-dialog"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <MessageSquarePlus aria-hidden="true" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-lg font-semibold">{labels.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
            {labels.description}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <Button aria-label={labels.cancel} disabled={busy} size="icon" variant="ghost">
            <X aria-hidden="true" size={19} />
          </Button>
        </Dialog.Close>
      </div>

      <form className="mt-5 grid gap-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={labels.profile}>
            <select
              className={fieldClassName}
              data-testid="new-session-profile"
              disabled={busy}
              onChange={(event) => setProfile(event.target.value)}
              required
              value={profile}
            >
              {profiles.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </Field>

          <Field label={labels.project}>
            <span className="relative">
              <FolderGit2 aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <select
                className={`${fieldClassName} ps-9`}
                data-testid="new-session-project"
                disabled={busy}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setProjectId(nextId);
                  const nextProject = projects.find((project) => project.id === nextId);
                  if (nextProject?.cwd) setCwd(nextProject.cwd);
                }}
                value={projectId}
              >
                <option value="">{labels.defaultValue}</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </span>
          </Field>
        </div>

        <Field help={labels.cwdHelp} label={labels.cwd}>
          <input
            autoComplete="off"
            className={fieldClassName}
            data-testid="new-session-cwd"
            dir="ltr"
            disabled={busy}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="/path/to/workspace"
            spellCheck={false}
            value={cwd}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={labels.model}>
            <select
              className={fieldClassName}
              data-testid="new-session-model"
              disabled={busy}
              onChange={(event) => {
                setModelKey(event.target.value);
                const selected = event.target.value
                  ? modelOptions[Number(event.target.value)]?.model
                  : undefined;
                setProvider(selected?.provider ?? "");
              }}
              value={modelKey}
            >
              <option value="">{labels.defaultValue}</option>
              {modelOptions.map(({ key, model }) => (
                <option key={`${model.provider}:${model.id}`} value={key}>
                  {model.providerName} · {model.id}
                </option>
              ))}
            </select>
          </Field>

          <Field label={labels.provider}>
            <input
              className={fieldClassName}
              data-testid="new-session-provider"
              dir="ltr"
              disabled={busy}
              onChange={(event) => setProvider(event.target.value)}
              placeholder={labels.defaultValue}
              value={provider}
            />
          </Field>

          <Field label={labels.reasoning}>
            <select
              className={fieldClassName}
              data-testid="new-session-reasoning"
              disabled={busy}
              onChange={(event) => setReasoning(event.target.value)}
              value={reasoning}
            >
              <option value="">{labels.defaultValue}</option>
              {["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>

          <Field label={labels.fast}>
            <select
              className={fieldClassName}
              data-testid="new-session-fast"
              disabled={busy}
              onChange={(event) => setFast(event.target.value as FastChoice)}
              value={fast}
            >
              <option value="default">{labels.defaultValue}</option>
              <option value="on">{labels.fastOn}</option>
              <option value="off">{labels.fastOff}</option>
            </select>
          </Field>
        </div>

        {error ? <p className="rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Dialog.Close asChild>
            <Button disabled={busy} variant="ghost">{labels.cancel}</Button>
          </Dialog.Close>
          <Button data-testid="create-session" disabled={busy || !profile.trim()} type="submit">
            {busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={17} /> : null}
            {labels.create}
          </Button>
        </div>
      </form>
    </Dialog.Content>
  );
}

interface DraftInput {
  cwd: string;
  fast: FastChoice;
  model: string;
  profile: string;
  projectId: string;
  provider: string;
  reasoning: string;
}

export function buildNewSessionSubmission(draft: DraftInput): NewSessionSubmission {
  const profile = draft.profile.trim();
  const projectId = draft.projectId.trim();
  const cwd = draft.cwd.trim();
  const model = draft.model.trim();
  const provider = draft.provider.trim();
  const reasoningEffort = draft.reasoning.trim();
  return {
    profile,
    ...(projectId ? { projectId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(draft.fast === "on" ? { fast: true } : {}),
    ...(draft.fast === "off" ? { fast: false } : {}),
  };
}

function Field({ children, help, label }: { children: ReactNode; help?: string; label: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {help ? <span className="text-xs font-normal leading-5 text-muted-foreground">{help}</span> : null}
    </label>
  );
}

const fieldClassName = "min-h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50";

function newSessionLabels(locale: string, overrides: NewSessionDialogProps["labels"]): NewSessionLabels {
  const defaults: NewSessionLabels = locale.startsWith("fa") ? {
    cancel: "انصراف",
    create: "ساخت گفت‌وگو",
    cwd: "پوشه کاری",
    cwdHelp: "این مسیر باید یک پوشه موجود باشد؛ در صورت خطا مسیر دیگری جایگزین نمی‌شود.",
    defaultValue: "پیش‌فرض پروفایل",
    description: "پروژه و تنظیمات فقط برای همین گفت‌وگوی جدید اعمال می‌شوند.",
    fast: "حالت سریع",
    fastOff: "خاموش",
    fastOn: "روشن",
    model: "مدل",
    profile: "پروفایل",
    project: "پروژه",
    provider: "ارائه‌دهنده",
    reasoning: "سطح استدلال",
    title: "گفت‌وگوی جدید",
    validationFailed: "پوشه کاری معتبر نیست.",
  } : {
    cancel: "Cancel",
    create: "Create conversation",
    cwd: "Working directory",
    cwdHelp: "The path must be an existing directory; an invalid path never falls back silently.",
    defaultValue: "Profile default",
    description: "Project and model overrides apply only to this new conversation.",
    fast: "Fast mode",
    fastOff: "Off",
    fastOn: "On",
    model: "Model",
    profile: "Profile",
    project: "Project",
    provider: "Provider",
    reasoning: "Reasoning effort",
    title: "New conversation",
    validationFailed: "The working directory is not valid.",
  };
  return { ...defaults, ...overrides };
}
