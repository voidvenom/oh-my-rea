import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";

export const TARGET_EXTENSIONS = [
  ".apk",
  ".aab",
  ".ipa",
  ".dmg",
  ".asar",
  ".exe",
  ".dll",
  ".sys",
  ".so",
  ".dylib",
  ".elf",
  ".bin",
  ".ko",
  ".o",
  ".wasm",
  ".dex",
  ".jar",
  ".pcap",
  ".pcapng",
  ".fw",
  ".img",
  ".rom",
  ".dmp",
  ".macho",
] as const;

const isTargetFilename = (name: string): boolean => {
  const lower = name.toLowerCase();
  return TARGET_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/** Strip surrounding quotes, expand `~`, and resolve relative paths against `cwd`. */
export const resolveTargetPath = (raw: string, cwd = process.cwd()): string => {
  let text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return join(homedir(), text.slice(2));
  }
  return resolve(cwd, text);
};

/** Shallow scan (<= 256 entries, zero file reads) for candidate artifacts in `cwd`. */
export const listTargetCandidates = async (cwd: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries.slice(0, 256)) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && isTargetFilename(entry.name)) {
      matches.push(resolve(cwd, entry.name));
    } else if (
      entry.isDirectory() &&
      entry.name.toLowerCase().endsWith(".app")
    ) {
      matches.push(resolve(cwd, entry.name));
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
};

export const detectTarget = async (cwd: string): Promise<string | null> => {
  const files = await listTargetCandidates(cwd);
  return files.length === 1 ? files[0]! : null;
};

/**
 * Fast filesystem completion for `/open <Tab>` and `/export <Tab>` in the TUI.
 * Prioritizes recognizable reverse-engineering artifacts first, then directories.
 */
export const completePathInput = (
  partial: string,
  cwd = process.cwd(),
): string[] => {
  const clean = partial.replace(/^["']/, "");
  const expanded =
    clean === "~"
      ? `${homedir()}/`
      : clean.startsWith("~/")
        ? join(homedir(), clean.slice(2))
        : clean;

  const endsWithSlash =
    expanded.endsWith("/") || expanded.endsWith("\\") || expanded.length === 0;
  const searchDir = endsWithSlash
    ? resolve(cwd, expanded || ".")
    : resolve(cwd, dirname(expanded));
  const prefix = endsWithSlash ? "" : basename(expanded).toLowerCase();
  const displayDirPrefix =
    clean.length === 0
      ? ""
      : endsWithSlash
        ? clean
        : clean.includes("/")
          ? clean.slice(0, clean.lastIndexOf("/") + 1)
          : "";

  let entries;
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const scored: Array<{ text: string; rank: number }> = [];
  for (const entry of entries.slice(0, 256)) {
    if (!prefix && entry.name.startsWith(".")) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue;
    const isDir = entry.isDirectory();
    const isTarget = entry.isFile() && isTargetFilename(entry.name);
    const suffix = isDir ? "/" : "";
    const rawCandidate = `${displayDirPrefix}${entry.name}${suffix}`;
    const formatted = rawCandidate.includes(" ")
      ? `"${rawCandidate}"`
      : rawCandidate;
    const rank = isTarget ? 0 : isDir ? 1 : 2;
    scored.push({ text: formatted, rank });
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text))
    .slice(0, 24)
    .map((item) => item.text);
};
