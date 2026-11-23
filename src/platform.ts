import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const hostPath = (platform: NodeJS.Platform = process.platform) => platform === "win32" ? win32 : posix;

export const envValue = (env: NodeJS.ProcessEnv, key: string, platform = process.platform): string | undefined => {
  if (env[key] !== undefined || platform !== "win32") return env[key];
  const match = Object.keys(env).find(name => name.toUpperCase() === key.toUpperCase());
  return match === undefined ? undefined : env[match];
};

export const normalizeEnv = (env: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv =>
  platform === "win32" ? Object.fromEntries(Object.entries(env).sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0)
    .map(([key, value]) => [key.toUpperCase(), value])) : env;

export const localFilePath = (input: string, platform = process.platform): string =>
  /^file:/i.test(input) ? fileURLToPath(input, { windows: platform === "win32" }) : input;

export const hostHome = (env = process.env, platform = process.platform, fallback = homedir()): string =>
  (platform === "win32" ? envValue(env, "USERPROFILE", platform) || envValue(env, "HOME", platform) : env.HOME) || fallback;

/** Keep an existing legacy file/directory, not an unrelated legacy tree. Explicit XDG config wins. */
export const reaConfigPath = (env: NodeJS.ProcessEnv, parts: readonly string[], platform = process.platform,
  home = hostHome(env, platform), exists = existsSync): string => {
  const { join } = hostPath(platform);
  const xdg = envValue(env, "XDG_CONFIG_HOME", platform);
  if (xdg) return join(xdg, "rea", ...parts);
  const legacy = join(home, ".config", "rea", ...parts);
  if (platform !== "win32" && platform !== "darwin" || exists(legacy)) return legacy;
  const config = platform === "darwin" ? join(home, "Library", "Application Support")
    : envValue(env, "APPDATA", platform) || join(home, "AppData", "Roaming");
  return join(config, "rea", ...parts);
};

/** Linux preserves the old cache unless the caller explicitly sets XDG_CACHE_HOME. */
export const reaCachePath = (env: NodeJS.ProcessEnv, name: string, platform = process.platform,
  home = hostHome(env, platform), exists = existsSync): string => {
  const { join } = hostPath(platform);
  const xdg = envValue(env, "XDG_CACHE_HOME", platform);
  if (xdg) return join(xdg, "rea", name);
  const legacy = reaConfigPath(env, [name], platform, home, exists);
  if ((platform !== "win32" && platform !== "darwin") || exists(legacy) || envValue(env, "XDG_CONFIG_HOME", platform)) return legacy;
  const cache = platform === "darwin" ? join(home, "Library", "Caches")
    : join(envValue(env, "LOCALAPPDATA", platform) || join(home, "AppData", "Local"), "rea");
  return platform === "darwin" ? join(cache, "rea", name) : join(cache, "cache", name);
};

export const completionPath = (input: string, cwd: string, platform = process.platform, home = homedir()) => {
  const path = hostPath(platform);
  const clean = input === "~" ? `~${path.sep}` : input;
  const split = Math.max(clean.lastIndexOf("/"), platform === "win32" ? clean.lastIndexOf("\\") : -1) + 1;
  const displayDirPrefix = split ? clean.slice(0, split) : path.parse(clean).root;
  const dir = /^~[/\\]/.test(displayDirPrefix) ? path.join(home, displayDirPrefix.slice(2)) : displayDirPrefix;
  return { displayDirPrefix, searchDir: path.resolve(cwd, dir || "."), prefix: clean.slice(displayDirPrefix.length).toLowerCase() };
};

/** Rebase stored absolute artifacts only when they are descendants of the source session. */
export const rebaseSessionArtifact = (value: unknown, from: string, to: string, platform = process.platform): unknown => {
  const path = hostPath(platform);
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  const relative = path.relative(from, value);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value;
  return path.join(to, relative);
};

export const invalidWindowsFilename = (name: string): boolean =>
  /[<>:"/\\|?*\x00-\x1f]|[ .]$|^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(name);

export const defaultSessionsPath = (env: NodeJS.ProcessEnv, platform = process.platform,
  home = hostHome(env, platform), exists = existsSync): string => {
  const { join } = hostPath(platform);
  const legacy = join(home, ".rea", "sessions");
  const xdg = envValue(env, "XDG_STATE_HOME", platform);
  if (exists(legacy) || (!xdg && platform !== "win32" && platform !== "darwin")) return legacy;
  const state = xdg || (platform === "darwin" ? join(home, "Library", "Application Support")
    : envValue(env, "LOCALAPPDATA", platform) || join(home, "AppData", "Local"));
  return join(state, "rea", "sessions");
};

const executable = (candidate: string): boolean => {
  try { if (!statSync(candidate).isFile()) return false; accessSync(candidate, constants.X_OK); return true; }
  catch { return false; }
};

/** Search PATH without executing a candidate. npm ships both .cmd and a POSIX wrapper on Windows. */
export const findOnPath = (name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform,
  isExecutable = executable, nativeOnly = false): string | undefined => {
  const path = hostPath(platform);
  const windows = platform === "win32";
  const extensions = !windows || path.extname(name) ? [""]
    : (envValue(env, "PATHEXT", platform) || ".EXE;.CMD;.BAT;.COM").split(";")
      .filter(ext => nativeOnly ? /^\.(exe|com)$/i.test(ext) : /^\.(exe|com|cmd|bat)$/i.test(ext));
  for (const raw of (envValue(env, "PATH", platform) ?? "").split(path.delimiter)) {
    const dir = windows ? raw.replace(/^"(.*)"$/, "$1") : raw;
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.resolve(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
};

export interface Invocation { readonly command: string; readonly args: string[] }

/** Call npm's JS entry directly on Windows; never interpret a batch file or interpolate its arguments. */
export const npmInvocation = (args: readonly string[], env = process.env, platform = process.platform,
  node = process.execPath, exists = existsSync, lookup = findOnPath): Invocation | undefined => {
  if (platform !== "win32") return { command: "npm", args: [...args] };
  const { dirname, join, isAbsolute } = win32;
  const entry = envValue(env, "npm_execpath", platform);
  const shim = lookup("npm", env, platform);
  const candidates = [entry && isAbsolute(entry) && /[\\/]npm-cli\.js$/i.test(entry) ? entry : undefined,
    shim && join(dirname(shim), "node_modules", "npm", "bin", "npm-cli.js"),
    shim && join(dirname(shim), "..", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js")];
  const cli = candidates.find(candidate => candidate && exists(candidate));
  return cli ? { command: node, args: [cli, ...args] } : undefined;
};
