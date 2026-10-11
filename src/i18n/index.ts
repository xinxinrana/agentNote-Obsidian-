import { en } from "./en";

export type Language = "zh" | "en";
let currentLanguage: Language = "zh";

export function languageFor(code: string | null | undefined): Language {
  return !code || code.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLanguage(code: string | null | undefined): void {
  currentLanguage = languageFor(code);
}

export function language(): Language { return currentLanguage; }
export function locale(): string { return currentLanguage === "zh" ? "zh-CN" : "en-US"; }

/** Substitute only the template, never user titles, paths, or instructions. */
export function t(source: string, ...values: unknown[]): string {
  const template = currentLanguage === "en" ? en[source] ?? source : source;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
