import { setRequestLocale } from "next-intl/server";

import type { AppLocale } from "@/i18n/routing";

type LocaleChatPageProps = {
  params: Promise<{ locale: AppLocale }>;
};

export default async function LocaleChatPage({ params }: LocaleChatPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return null;
}
