"use client";

import { FolderGit2, GitBranch, MessageSquare } from "lucide-react";
import { useMemo } from "react";

import type { ProjectTreePayload } from "@/lib/hermes";
import type { ProjectSessionNode } from "@/lib/hermes/types";

import type { SessionSummary } from "./ui-types";

export interface ProjectBrowserSession extends SessionSummary {
  cwd?: string;
  gitRepoRoot?: string;
  lane?: string;
  projectId?: string;
}

export interface ProjectBrowserLane {
  id: string;
  name: string;
  sessions: ProjectSessionNode[];
}

export interface ProjectBrowserRepository {
  id: string;
  name: string;
  path?: string;
  lanes: ProjectBrowserLane[];
}

export interface ProjectBrowserGroup {
  id: string;
  name: string;
  path?: string;
  repositories: ProjectBrowserRepository[];
}

export interface ProjectSessionBrowserProps {
  activeSessionId?: string;
  fallbackSessions?: ProjectBrowserSession[];
  locale: string;
  onSelectProject?: (project: ProjectBrowserGroup) => void;
  onSelectSession: (sessionId: string) => void;
  payload?: ProjectTreePayload | null;
  labels?: Partial<{
    empty: string;
    project: string;
    projects: string;
    repository: string;
    sessions: string;
    ungrouped: string;
  }>;
}

export function buildProjectBrowserGroups(
  payload: ProjectTreePayload | null | undefined,
  fallbackSessions: ProjectBrowserSession[] = [],
): ProjectBrowserGroup[] {
  if (payload?.projects.length) {
    return payload.projects.map((project) => {
      const directSessions = uniqueProjectSessions(project.sessions ?? []);
      const repositories = (project.repositories ?? []).map((repository, repositoryIndex) => ({
        id: repository.id || `${project.id}:repo:${repositoryIndex}`,
        name: repository.name,
        path: repository.path,
        lanes: (repository.lanes?.length ? repository.lanes : [{ name: "Sessions", sessions: [] }])
          .map((lane, laneIndex) => ({
            id: lane.id || `${project.id}:repo:${repositoryIndex}:lane:${laneIndex}`,
            name: lane.name,
            sessions: uniqueProjectSessions(lane.sessions),
          })),
      }));

      if (directSessions.length) {
        repositories.push({
          id: `${project.id}:direct`,
          name: project.name,
          path: project.primaryPath ?? project.paths[0],
          lanes: [{ id: `${project.id}:direct:sessions`, name: "Sessions", sessions: directSessions }],
        });
      }

      return {
        id: project.id,
        name: project.name,
        path: project.primaryPath ?? project.paths[0],
        repositories,
      };
    });
  }

  const grouped = new Map<string, ProjectBrowserSession[]>();
  fallbackSessions.forEach((session) => {
    const root = session.gitRepoRoot?.trim() || session.cwd?.trim() || "__ungrouped__";
    const current = grouped.get(root) ?? [];
    current.push(session);
    grouped.set(root, current);
  });

  return Array.from(grouped.entries()).map(([root, sessions], groupIndex) => {
    const projectName = root === "__ungrouped__" ? "Ungrouped" : basename(root);
    const lanes = new Map<string, ProjectBrowserSession[]>();
    sessions.forEach((session) => {
      const lane = session.lane?.trim() || "Sessions";
      lanes.set(lane, [...(lanes.get(lane) ?? []), session]);
    });
    return {
      id: sessions[0]?.projectId || `fallback:${groupIndex}:${root}`,
      name: projectName,
      path: root === "__ungrouped__" ? undefined : root,
      repositories: [{
        id: `fallback:${groupIndex}:repository`,
        name: projectName,
        path: root === "__ungrouped__" ? undefined : root,
        lanes: Array.from(lanes.entries()).map(([name, laneSessions], laneIndex) => ({
          id: `fallback:${groupIndex}:lane:${laneIndex}`,
          name,
          sessions: uniqueProjectSessions(laneSessions.map(toProjectSessionNode)),
        })),
      }],
    };
  });
}

export function ProjectSessionBrowser({
  activeSessionId,
  fallbackSessions = [],
  locale,
  onSelectProject,
  onSelectSession,
  payload,
  labels,
}: ProjectSessionBrowserProps) {
  const copy = projectLabels(locale, labels);
  const groups = useMemo(
    () => buildProjectBrowserGroups(payload, fallbackSessions),
    [fallbackSessions, payload],
  );

  if (!groups.length) {
    return (
      <div className="rail-empty" data-testid="projects-empty">
        <FolderGit2 aria-hidden="true" size={24} />
        <p>{copy.empty}</p>
      </div>
    );
  }

  return (
    <nav aria-label={copy.projects} className="grid gap-2" data-testid="project-browser">
      {groups.map((project) => (
        <details className="rounded-xl border border-border bg-surface" key={project.id} open>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden">
            <FolderGit2 aria-hidden="true" className="text-primary" size={17} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" dir="auto">
              {project.name === "Ungrouped" ? copy.ungrouped : project.name}
            </span>
            {onSelectProject ? (
              <button
                className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  onSelectProject(project);
                }}
                type="button"
              >
                {copy.project}
              </button>
            ) : null}
          </summary>
          {project.path ? (
            <bdi className="block truncate border-t border-border px-3 py-1.5 text-[0.6875rem] text-muted-foreground" dir="ltr">
              {project.path}
            </bdi>
          ) : null}

          <div className="grid gap-3 border-t border-border p-2">
            {project.repositories.map((repository) => (
              <section aria-label={`${copy.repository}: ${repository.name}`} key={repository.id}>
                {project.repositories.length > 1 ? (
                  <p className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                    <FolderGit2 aria-hidden="true" size={13} />
                    <span className="truncate" dir="auto">{repository.name}</span>
                  </p>
                ) : null}
                {repository.lanes.map((lane) => (
                  <div className="mt-1" key={lane.id}>
                    <p className="flex items-center gap-1.5 px-2 py-1 text-[0.6875rem] text-muted-foreground">
                      <GitBranch aria-hidden="true" size={12} />
                      <span dir="auto">{lane.name === "Sessions" ? copy.sessions : lane.name}</span>
                    </p>
                    <div className="grid gap-0.5">
                      {lane.sessions.map((session) => {
                        const active = session.id === activeSessionId;
                        return (
                          <button
                            aria-current={active ? "page" : undefined}
                            className={`flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-muted ${active ? "bg-primary/10 text-primary" : ""}`}
                            data-session-id={session.id}
                            key={session.id}
                            onClick={() => onSelectSession(session.id)}
                            type="button"
                          >
                            <MessageSquare aria-hidden="true" className="shrink-0" size={14} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" dir="auto">{session.title || session.id}</span>
                              {session.preview ? (
                                <span className="line-clamp-1 block text-xs text-muted-foreground" dir="auto">
                                  {session.preview}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </details>
      ))}
    </nav>
  );
}

function uniqueProjectSessions(sessions: ProjectSessionNode[]): ProjectSessionNode[] {
  const seen = new Set<string>();
  return sessions
    .filter((session) => {
      if (!session.id || seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function toProjectSessionNode(session: ProjectBrowserSession): ProjectSessionNode {
  const updated = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  return {
    id: session.storedId,
    title: session.title,
    cwd: session.cwd,
    model: session.model,
    updatedAt: Number.isFinite(updated) ? updated : undefined,
  };
}

function basename(value: string): string {
  const normalized = value.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || value;
}

function projectLabels(
  locale: string,
  overrides: ProjectSessionBrowserProps["labels"],
): Required<NonNullable<ProjectSessionBrowserProps["labels"]>> {
  const defaults = locale.startsWith("fa") ? {
    empty: "هنوز پروژه یا گفت‌وگویی وجود ندارد.",
    project: "انتخاب پروژه",
    projects: "پروژه‌ها و گفت‌وگوها",
    repository: "مخزن",
    sessions: "گفت‌وگوها",
    ungrouped: "بدون پروژه",
  } : {
    empty: "No projects or conversations yet.",
    project: "Select project",
    projects: "Projects and conversations",
    repository: "Repository",
    sessions: "Conversations",
    ungrouped: "No project",
  };
  return { ...defaults, ...overrides };
}
