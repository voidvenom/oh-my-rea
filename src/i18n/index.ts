import { readFile } from "node:fs/promises";
import type { en } from "./en.js";

export type Language = "en" | "tr";
type English = typeof en;
export type MessageKey = keyof English;
export type LocalizedMessage = (t: I18n["t"]) => string;
export type Catalog = { readonly [K in MessageKey]: string };
type Fields<S extends string> = S extends `${string}{${infer Field}}${infer Rest}`
  ? Field | Fields<Rest> : never;
type Value = string | number | boolean | null | undefined;
type Values<K extends MessageKey> = [Fields<English[K]>] extends [never]
  ? [] : [Record<Fields<English[K]>, Value>];

export const parseLanguage = (value: unknown): Language | undefined =>
  value === "en" || value === "tr" ? value : undefined;

const fromLocale = (env: NodeJS.ProcessEnv): Language => {
  const locale = env["LC_ALL"] || env["LC_MESSAGES"] || env["LANG"] || "";
  return /^tr(?:[_@.-]|$)/i.test(locale) ? "tr" : "en";
};

const preferredLanguage = async (flag: Language | undefined, env: NodeJS.ProcessEnv): Promise<Language> => {
  const explicit = flag ?? parseLanguage(env["OMR_LANG"]);
  if (explicit) return explicit;
  try {
    const { modelConfigPath } = await import("../modelConfig.js");
    const config = JSON.parse(await readFile(modelConfigPath(env), "utf8")) as { language?: unknown } | null;
    const saved = parseLanguage(config?.language);
    if (saved) return saved;
  } catch {
    // Model configuration errors are surfaced by the model setup path.
  }
  return fromLocale(env);
};

export class I18n {
  private catalog: Catalog | undefined;
  private initialization: Promise<void> | undefined;
  private machine = false;
  language: Language = "en";

  initialize(flag: Language | undefined, env: NodeJS.ProcessEnv, machine = false): Promise<void> {
    this.machine = machine;
    return this.initialization ??= (async () => {
      await this.switchTo(machine ? "en" : await preferredLanguage(flag, env));
    })();
  }

  async switchTo(language: Language): Promise<void> {
    if (this.catalog && this.language === language) return;
    if (this.machine && language !== "en") return;
    this.catalog = language === "tr" ? (await import("./tr.js")).tr : (await import("./en.js")).en;
    this.language = language;
  }

  get answerLanguage(): "Turkish" | "English" | undefined {
    return this.machine || !this.catalog ? undefined : this.language === "tr" ? "Turkish" : "English";
  }

  t = <K extends MessageKey>(key: K, ...args: Values<K>): string => {
    // The TUI can draw and take input before resolving a saved language from disk.
    const text = this.catalog?.[key] ?? "";
    const [values] = args as [Record<string, Value>?];
    return values ? text.replace(/\{([^{}]+)\}/g, (match, field: string) =>
      Object.hasOwn(values, field) ? String(values[field] ?? "") : match) : text;
  };

  upper(text: string): string {
    return text.toLocaleUpperCase(this.language);
  }

  lower(text: string): string {
    return text.toLocaleLowerCase(this.language);
  }
}

export const englishI18n = async (): Promise<I18n> => {
  const i18n = new I18n();
  await i18n.switchTo("en");
  return i18n;
};
