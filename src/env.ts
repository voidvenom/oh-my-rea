import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXPORT_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export interface ResolvedEnv {
  env: NodeJS.ProcessEnv;
  sources: string[];
}

const unquoteShellValue = (raw: string, home: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    if (end >= 1) return trimmed.slice(1, end);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"')) {
    let out = "";
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i]!;
      if (ch === "\\" && i + 1 < trimmed.length) {
        out += trimmed[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out.replace(/\$\{HOME\}|\$HOME\b/g, home);
  }
  const commentCut = trimmed.search(/\s+#/);
  const bare = (
    commentCut >= 0 ? trimmed.slice(0, commentCut) : trimmed
  ).trim();
  const expanded = bare.replace(/\$\{HOME\}|\$HOME\b/g, home);
  if (expanded === "~") return home;
  if (expanded.startsWith("~/")) return join(home, expanded.slice(2));
  return expanded;
};

export const parseExports = (
  text: string,
  into: NodeJS.ProcessEnv,
  home = homedir(),
): void => {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = EXPORT_LINE.exec(line);
    if (!match) continue;
    into[match[1]!] = unquoteShellValue(match[2] ?? "", home);
  }
};

const readIfExists = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * REA provider configuration lives in environment variables. `rea setup`
 * writes them to `~/.config/rea/rea-env.sh`; a shell that has not sourced that
 * file would leave omr without jadx/ghidra/unblob. Resolve the file here so
 * omr works from any shell. Explicit process environment wins over the file.
 */
export const resolveReaEnv = (
  base: NodeJS.ProcessEnv = process.env,
): ResolvedEnv => {
  const env: NodeJS.ProcessEnv = {};
  const sources: string[] = [];
  const home = base["HOME"] ?? homedir();
  const candidates = [
    base["REA_ENV_FILE"],
    join(base["XDG_CONFIG_HOME"] ?? join(home, ".config"), "rea", "rea-env.sh"),
    join(home, ".rea", "rea-env.sh"),
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const path of candidates) {
    const text = readIfExists(path);
    if (text === null) continue;
    parseExports(text, env, home);
    sources.push(path);
    break;
  }

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  return { env, sources };
};
