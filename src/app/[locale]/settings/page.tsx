import {ArrowLeft} from "lucide-react";
import type {Metadata} from "next";
import {getTranslations, setRequestLocale} from "next-intl/server";
import {notFound} from "next/navigation";

import {Button} from "@/components/ui/button";
import {Link} from "@/i18n/navigation";
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
  const navTranslations = await getTranslations("Nav");
  return (
    <main
      className="min-h-dvh bg-background px-4 py-6 text-foreground sm:px-8 sm:py-10"
      id="main-content"
    >
      <div className="mx-auto w-full max-w-3xl">
        <Button asChild className="mb-8 -ms-2" size="sm" variant="ghost">
          <Link href="/">
            <ArrowLeft aria-hidden="true" className="size-4 rtl-mirror" />
            {navTranslations("backToChat")}
          </Link>
        </Button>

        <header className="mb-8 max-w-2xl">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            {translations("title")}
          </h1>
          <p className="mt-3 text-pretty text-base leading-8 text-muted-foreground">
            {translations("description")}
          </p>
        </header>

        <SettingsPanel />
      </div>
    </main>
  );
}
