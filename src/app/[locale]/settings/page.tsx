import {Settings} from "lucide-react";
import type {Metadata} from "next";
import {getTranslations, setRequestLocale} from "next-intl/server";
import {notFound} from "next/navigation";

import {routing, type AppLocale} from "@/i18n/routing";

import {SettingsPanel} from "./settings-panel";

interface SettingsPageProps {
  params: Promise<{locale: string}>;
}

function isAppLocale(locale: string): locale is AppLocale {
  return routing.locales.includes(locale as AppLocale);
}

export async function generateMetadata({params}: SettingsPageProps): Promise<Metadata> {
  const {locale} = await params;

  if (!isAppLocale(locale)) {
    return {};
  }

  const translations = await getTranslations({locale, namespace: "Settings"});
  return {title: translations("title")};
}

export default async function SettingsPage({params}: SettingsPageProps) {
  const {locale: requestedLocale} = await params;

  if (!isAppLocale(requestedLocale)) {
    notFound();
  }

  setRequestLocale(requestedLocale);
  const translations = await getTranslations("Settings");
  return (
    <main
      className="product-page min-h-full bg-background px-4 pb-8 text-foreground sm:px-6"
      id="main-content"
    >
      <div className="product-page-content mx-auto w-full max-w-[70rem]">
        <header className="product-page-header flex min-h-12 items-center gap-3 border-b border-border">
          <Settings aria-hidden="true" className="size-5 shrink-0 text-primary" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
            {translations("title")}
          </h1>
        </header>

        <div className="product-page-intro py-4">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            {translations("description")}
          </p>
        </div>

        <SettingsPanel />
      </div>
    </main>
  );
}
