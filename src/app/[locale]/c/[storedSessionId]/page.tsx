import { setRequestLocale } from "next-intl/server";

import { ChatShell } from "@/components/chat/chat-shell";
import type { AppLocale } from "@/i18n/routing";

type SessionPageProps = {
  params: Promise<{ locale: AppLocale; storedSessionId: string }>;
};

export default async function SessionPage({ params }: SessionPageProps) {
  const { locale, storedSessionId } = await params;
  setRequestLocale(locale);
  return <ChatShell storedSessionId={storedSessionId} />;
}
