"use client";

import { Activity, Bot, BrainCircuit, MessageSquare, Settings } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { ChatShell } from "@/components/chat/chat-shell";
import { useWorkspaceLayoutStore } from "@/store/workspace-layout-store";
import { WorkspaceNavigation } from "./workspace-navigation";
import { useHermesWorkspace } from "./workspace-provider";

type WorkspaceShellProps = {
  children: ReactNode;
};

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function chatTarget(pathname: string, locale: string): string | undefined {
  const prefix = `/${locale}/c/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const raw = pathname.slice(prefix.length).split("/", 1)[0];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function WorkspaceShell({ children }: WorkspaceShellProps) {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tNav = useTranslations("Nav");
  const { runtime } = useHermesWorkspace();

  useEffect(() => {
    void useWorkspaceLayoutStore.persist.rehydrate();
  }, []);

  const storedSessionId = chatTarget(pathname, locale);
  const profileValues = searchParams.getAll("profile");
  const requestedProfile = profileValues.length === 1 ? profileValues[0]?.trim() : undefined;
  const initialProfile =
    requestedProfile && requestedProfile !== "all" && PROFILE_PATTERN.test(requestedProfile)
      ? requestedProfile
      : undefined;
  const chatRoot = pathname === `/${locale}` || pathname === `/${locale}/`;
  const isChat = chatRoot || storedSessionId !== undefined;
  const chatHref = runtime.identity
    ? `/${locale}/c/${encodeURIComponent(runtime.identity.storedId)}?profile=${encodeURIComponent(runtime.activeProfile)}`
    : `/${locale}`;
  const items = [
    { href: chatHref, key: "chat", icon: MessageSquare, label: tNav("chat") },
    { href: `/${locale}/activity`, key: "activity", icon: Activity, label: tNav("activity") },
    { href: `/${locale}/automations`, key: "automations", icon: Bot, label: tNav("automations") },
    { href: `/${locale}/knowledge`, key: "knowledge", icon: BrainCircuit, label: tNav("knowledge") },
    { href: `/${locale}/settings`, key: "settings", icon: Settings, label: tNav("settings") },
  ].map((item) => ({
    ...item,
    active: item.key === "chat"
      ? isChat
      : pathname === item.href || pathname.startsWith(`${item.href}/`),
  }));

  return (
    <div className="workspace-shell">
      <WorkspaceNavigation
        closeLabel={tNav("closeNavigation")}
        items={items}
        menuLabel={tNav("navigationMenu")}
        openLabel={tNav("openNavigation")}
        workspaceLabel={tNav("workspace")}
      />

      <div className="workspace-shell__body">
        <div className="workspace-shell__chat" hidden={!isChat} aria-hidden={!isChat}>
          <ChatShell
            active={isChat}
            storedSessionId={isChat ? storedSessionId : runtime.activeStoredId}
            initialProfile={isChat ? initialProfile : runtime.activeProfile}
            profileRequiredError={isChat && Boolean(storedSessionId) && !initialProfile}
          />
        </div>
        {!isChat ? <div className="workspace-shell__module">{children}</div> : null}
      </div>
    </div>
  );
}
