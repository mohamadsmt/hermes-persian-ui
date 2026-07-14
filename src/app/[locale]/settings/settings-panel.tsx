"use client";

import {Check, Languages, LockKeyhole, Monitor, Moon, Sun, Type} from "lucide-react";
import {useLocale, useTranslations} from "next-intl";
import {useTheme} from "next-themes";
import type {ComponentType, SVGProps} from "react";

import {BidiBlock} from "@/components/chat/bidi-text";
import {Button} from "@/components/ui/button";
import {Separator} from "@/components/ui/separator";
import {Link} from "@/i18n/navigation";
import type {AppLocale} from "@/i18n/routing";

type ThemeName = "dark" | "light" | "system";
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const themeOptions: Array<{icon: Icon; label: "themeDark" | "themeLight" | "themeSystem"; value: ThemeName}> = [
  {icon: Monitor, label: "themeSystem", value: "system"},
  {icon: Sun, label: "themeLight", value: "light"},
  {icon: Moon, label: "themeDark", value: "dark"},
];

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
    <section className="rounded-2xl border border-border bg-surface shadow-surface">
      <div className="flex items-start gap-3 p-5 sm:p-6">
        <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <IconComponent aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>
      <Separator />
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

export function SettingsPanel() {
  const locale = useLocale() as AppLocale;
  const translations = useTranslations("Settings");
  const {setTheme, theme} = useTheme();

  return (
    <div className="grid gap-5">
      <SettingsSection
        description={translations("appearanceDescription")}
        icon={Sun}
        title={translations("appearance")}
      >
        <div aria-label={translations("theme")} className="grid grid-cols-3 gap-2" role="group">
          {themeOptions.map(({icon: ThemeIcon, label, value}) => {
            const selected = theme === value;

            return (
              <Button
                aria-pressed={selected}
                className="relative min-w-0 flex-col gap-2 py-3"
                key={value}
                onClick={() => setTheme(value)}
                variant={selected ? "secondary" : "ghost"}
              >
                <ThemeIcon aria-hidden="true" className="size-5" />
                <span>{translations(label)}</span>
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
        <BidiBlock as="p" className="rounded-xl bg-muted/60 px-4 py-3 leading-8">
          {translations("technicalSample")}
        </BidiBlock>
        <BidiBlock as="p" className="mt-3 rounded-xl bg-muted/60 px-4 py-3 leading-7">
          Hermes keeps identifiers such as gpt-5.6-sol and /v1/responses unchanged.
        </BidiBlock>
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
