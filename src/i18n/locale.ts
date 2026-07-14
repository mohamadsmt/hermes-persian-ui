import type {AppLocale} from "./routing";

export type LocaleDirection = "ltr" | "rtl";

export function getLocaleDirection(locale: AppLocale): LocaleDirection {
  return locale === "fa" ? "rtl" : "ltr";
}

export function isRtlLocale(locale: AppLocale): boolean {
  return getLocaleDirection(locale) === "rtl";
}

