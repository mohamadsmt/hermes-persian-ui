"use client";

import {Check, Languages, LockKeyhole, Monitor, Moon, Sun, Type} from "lucide-react";
import {useLocale, useTranslations} from "next-intl";
import {useTheme} from "next-themes";
import {useSyncExternalStore, type ComponentType, type SVGProps} from "react";

import {BidiBlock} from "@/components/chat/bidi-text";
import {Button} from "@/components/ui/button";
import {Link} from "@/i18n/navigation";
import type {AppLocale} from "@/i18n/routing";

type ThemeName = "dark" | "light" | "system";
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const themeOptions: Array<{icon: Icon; label: "themeDark" | "themeLight" | "themeSystem"; value: ThemeName}> = [
  {icon: Monitor, label: "themeSystem", value: "system"},
  {icon: Sun, label: "themeLight", value: "light"},
  {icon: Moon, label: "themeDark", value: "dark"},
];

const subscribeToHydration = () => () => undefined;

function SettingsSection({
  children,
  description,
  icon: IconComponent,
  title,
}: {
  children: React.ReactNode;
  description: string;
  icon: Icon;
  title: string;
}) {
  return (
    <section className="settings-section grid min-w-0 sm:grid-cols-[minmax(12rem,0.75fr)_minmax(0,1.25fr)]">
      <header className="flex items-start gap-3 p-4 sm:border-e sm:border-border sm:p-5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <IconComponent aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
        </div>
      </header>
      <div className="min-w-0 border-t border-border p-4 sm:border-t-0 sm:p-5">{children}</div>
    </section>
  );
}

export function SettingsPanel() {
  const locale = useLocale() as AppLocale;
  const translations = useTranslations("Settings");
  const {setTheme, theme} = useTheme();
  const themeReady = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );

  return (
    <div className="product-surface overflow-hidden rounded-xl border border-border bg-surface divide-y divide-border">
      <SettingsSection
        description={translations("appearanceDescription")}
        icon={Sun}
        title={translations("appearance")}
      >
        <div
          aria-label={translations("theme")}
          className="settings-theme-options grid grid-cols-3 gap-1.5"
          role="group"
        >
          {themeOptions.map(({icon: ThemeIcon, label, value}) => {
            const selected = themeReady && theme === value;

            return (
              <Button
                aria-pressed={selected}
                className="relative min-w-0 justify-start gap-2 ps-2.5 pe-8"
                key={value}
                onClick={() => setTheme(value)}
                variant={selected ? "secondary" : "ghost"}
              >
                <ThemeIcon aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{translations(label)}</span>
                {selected ? (
                  <Check aria-hidden="true" className="absolute end-2 top-2 size-3.5 text-primary" />
                ) : null}
              </Button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        description={translations("languageDescription")}
        icon={Languages}
        title={translations("language")}
      >
        <div className="grid grid-cols-2 gap-2">
          <Button asChild variant={locale === "fa" ? "secondary" : "ghost"}>
            <Link href="/settings" locale="fa">
              <span lang="fa">{translations("persian")}</span>
              {locale === "fa" ? <Check aria-hidden="true" className="size-4 text-primary" /> : null}
            </Link>
          </Button>
          <Button asChild variant={locale === "en" ? "secondary" : "ghost"}>
            <Link href="/settings" locale="en">
              <span lang="en">{translations("english")}</span>
              {locale === "en" ? <Check aria-hidden="true" className="size-4 text-primary" /> : null}
            </Link>
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        description={translations("typographyDescription")}
        icon={Type}
        title={translations("typography")}
      >
        <div className="divide-y divide-border border-y border-border">
          <BidiBlock as="p" className="py-3 leading-7">
            {translations("technicalSample")}
          </BidiBlock>
          <BidiBlock as="p" className="py-3 leading-6 text-muted-foreground">
            Hermes keeps identifiers such as gpt-5.6-sol and /v1/responses unchanged.
          </BidiBlock>
        </div>
      </SettingsSection>

      <SettingsSection
        description={translations("privacyDescription")}
        icon={LockKeyhole}
        title={translations("privacy")}
      >
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-4 shrink-0 text-success" />
          {translations("localPreferences")}
        </p>
      </SettingsSection>
    </div>
  );
}
