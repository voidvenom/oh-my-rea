import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { I18n, LocalizedMessage } from "./i18n/index.js";
import { VERSION } from "./version.js";

export const CHANGELOG_FILE = new URL("../CHANGELOG.md", import.meta.url);

export const parseChangelog = (markdown: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, string>();
  const headings = [...markdown.matchAll(/^## \[([^\]\r\n]+)\][^\r\n]*/gm)];
  for (const [i, heading] of headings.entries()) {
    const version = heading[1]!;
    if (sections.has(version)) throw new Error(`Duplicate changelog section: ${version}`);
    sections.set(version, markdown.slice(heading.index, headings[i + 1]?.index).trim());
  }
  return sections;
};

export const changelogText = async (selection = VERSION, file: URL | string = CHANGELOG_FILE): Promise<string | null> => {
  const markdown = await readFile(file, "utf8");
  return selection === "--all" ? markdown.trim() : parseChangelog(markdown).get(selection.replace(/^v(?=\d)/, "")) ?? null;
};

export const releaseSummary = (section: string): string => {
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
  return section.split(/\r?\n/)
    .flatMap((line) => /^- (.+)$/.exec(line)?.[1] ?? [])
    .slice(0, 3)
    .map((line) => `- ${sentences.segment(line)[Symbol.iterator]().next().value?.segment.trim() ?? line}`)
    .join("\n");
};

/** Claim a version only when it has notes. An exclusive create keeps concurrent launches from repeating them. */
export const whatsNewMessage = async (
  env: NodeJS.ProcessEnv = process.env,
  version = VERSION,
  file: URL | string = CHANGELOG_FILE,
): Promise<LocalizedMessage | null> => {
  if (env["CI"] || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return null;
  try {
    const section = await changelogText(version, file);
    const summary = section && releaseSummary(section);
    if (!summary) return null;
    const dir = join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "rea", "omr-release-notes");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, version), "", { flag: "wx", mode: 0o600 });
    return (t) => `${t("changelog.whatsNew", { version })}\n${summary}\n${t("changelog.see", { version })}`;
  } catch {
    return null;
  }
};

export const whatsNew = async (
  env: NodeJS.ProcessEnv = process.env,
  version = VERSION,
  file: URL | string = CHANGELOG_FILE,
  language?: I18n,
): Promise<string | null> => {
  const message = await whatsNewMessage(env, version, file);
  return message ? message((language ?? await (await import("./i18n/index.js")).englishI18n()).t) : null;
};

export const changelogError = (i18n: I18n, error: unknown): string =>
  i18n.t("changelog.readError", { detail: error instanceof Error ? error.message : String(error) });

export const noChangelogSection = (i18n: I18n, selection: string): string =>
  i18n.t("changelog.unknown", { selection });

export const localizeChangelogHeadings = (markdown: string, { t }: I18n): string => {
  const categories = {
    Added: "changelog.added", Changed: "changelog.changed", Deprecated: "changelog.deprecated",
    Removed: "changelog.removed", Fixed: "changelog.fixed", Security: "changelog.security",
  } as const;
  return markdown.replace(/^# Changelog$/m, `# ${t("changelog.title")}`)
    .replace(/^## \[Unreleased\]/m, `## [${t("changelog.unreleased")}]`)
    .replace(/^### (Added|Changed|Deprecated|Removed|Fixed|Security)$/gm,
      (_, category: keyof typeof categories) => `### ${t(categories[category])}`);
};
