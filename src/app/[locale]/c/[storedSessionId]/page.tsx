import { setRequestLocale } from "next-intl/server";

import type { AppLocale } from "@/i18n/routing";

type SessionPageProps = { params: Promise<{ locale: AppLocale; storedSessionId: string }> };

export default async function SessionPage({ params }: SessionPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return null;
}
