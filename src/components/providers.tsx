"use client";

import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {AbstractIntlMessages} from "next-intl";
import {NextIntlClientProvider} from "next-intl";
import {ThemeProvider} from "next-themes";
import type {ReactNode} from "react";
import {useState} from "react";

import type {AppLocale} from "@/i18n/routing";

import {TooltipProvider} from "./ui/tooltip";

interface ProvidersProps {
  children: ReactNode;
  locale: AppLocale;
  messages: AbstractIntlMessages;
}

export function Providers({children, locale, messages}: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Tehran">
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        disableTransitionOnChange
        enableSystem
        storageKey="hermes-ui-theme"
      >
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={450}>{children}</TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}
