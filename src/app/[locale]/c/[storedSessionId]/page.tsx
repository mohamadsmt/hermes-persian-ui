import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import type { AppLocale } from "@/i18n/routing";

type SessionPageProps = { params: Promise<{ locale: AppLocale; storedSessionId: string }> };

export async function generateMetadata({ params }: SessionPageProps): Promise<Metadata> {
  const { locale } = await params;
  const translations = await getTranslations({ locale, namespace: "App" });

  // Give the client-routed session segment its own stable title. Without an
  // explicit segment value, Next can briefly clear the inherited layout title
  // while it swaps `/fa` for `/fa/c/:id`, which is both visible to assistive
  // technology and detectable under concurrent navigation.
  return { title: { absolute: translations("title") } };
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return null;
}
