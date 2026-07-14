import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/vazirmatn";
import "streamdown/styles.css";
import "../globals.css";

import type {Metadata, Viewport} from "next";
import {hasLocale} from "next-intl";
import {getMessages, getTranslations, setRequestLocale} from "next-intl/server";
import {notFound} from "next/navigation";
import type {ReactNode} from "react";

import {Providers} from "@/components/providers";
import {getLocaleDirection} from "@/i18n/locale";
import {routing, type AppLocale} from "@/i18n/routing";

interface LocaleLayoutProps {
  children: ReactNode;
  params: Promise<{locale: string}>;
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({locale}));
}

export async function generateMetadata({params}: LocaleLayoutProps): Promise<Metadata> {
  const {locale: requestedLocale} = await params;

  if (!hasLocale(routing.locales, requestedLocale)) {
    return {};
  }

  const translations = await getTranslations({
    locale: requestedLocale,
    namespace: "App",
  });

  return {
    applicationName: translations("name"),
    description: translations("description"),
    title: {
      default: translations("title"),
      template: `%s — ${translations("name")}`,
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    {media: "(prefers-color-scheme: light)", color: "#f7f7f8"},
    {media: "(prefers-color-scheme: dark)", color: "#111216"},
  ],
  viewportFit: "cover",
};

export default async function LocaleLayout({children, params}: LocaleLayoutProps) {
  const {locale: requestedLocale} = await params;

  if (!hasLocale(routing.locales, requestedLocale)) {
    notFound();
  }

  const locale: AppLocale = requestedLocale;
  setRequestLocale(locale);
  const messages = await getMessages();
  const translations = await getTranslations("App");

  return (
    <html dir={getLocaleDirection(locale)} lang={locale} suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">
          {translations("skipToContent")}
        </a>
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}

