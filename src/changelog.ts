import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const releaseSummary = (section: string): string =>
  section.split(/\r?\n/)
    .flatMap((line) => /^- (.+)$/.exec(line)?.[1] ?? [])
    .slice(0, 3)
    .map((line) => `- ${line}`)
    .join("\n");

/** Claim a version only when it has notes. An exclusive create keeps concurrent launches from repeating them. */
export const whatsNew = async (
  env: NodeJS.ProcessEnv = process.env,
  version = VERSION,
  file: URL | string = CHANGELOG_FILE,
): Promise<string | null> => {
  if (env["CI"] || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return null;
  try {
    const section = await changelogText(version, file);
    const summary = section && releaseSummary(section);
    if (!summary) return null;
    const dir = join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "rea", "omr-release-notes");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, version), "", { flag: "wx", mode: 0o600 });
    return `What's new in ${version}\n${summary}\nSee /changelog or \`omr changelog ${version}\`.`;
  } catch {
    return null;
  }
};

export const changelogError = (error: unknown): string =>
  `Could not read CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`;

export const noChangelogSection = (selection: string): string =>
  `No changelog section for ${selection}. Run \`omr changelog --all\` to see available versions.`;
