/**
 * First-run setup and update management.
 *
 * omr is a client for REA, which must be installed globally (`rea-agents` on npm,
 * repository `morluto/rea`). This module detects REA, asks for consent before
 * installing it, and keeps both packages current. It never installs anything
 * without an explicit "yes" (or an explicit `omr setup` / `omr update` command)
 * and never sends anything but the public package name to the npm registry.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { padEndAnsi, visibleWidth } from "./ansi.js";
import { resolveReaEnv } from "./env.js";
import type { I18n, LocalizedMessage } from "./i18n/index.js";
import { resolveReaLauncher } from "./reaLauncher.js";
import { VERSION } from "./version.js";

export { findOnPath } from "./reaLauncher.js";

export const OMR_PACKAGE = "oh-my-rea";
export const REA_PACKAGE = "rea-agents";
/** `engines.node` of rea-agents; omr refuses to install a REA the running Node cannot start. */
const REA_NODE_RANGES: readonly [number, number, number][] = [[22, 23, 4], [24, 22, 1]];
const REA_NODE_MIN_MAJOR = 26;
const REA_NODE_MIN_MAJOR_RANGE: [number, number, number] = [26, 12, 1];
/**
 * Every interactive launch checks the registry in the background. This guard only stops a burst
 * of launches (scripts, tmux layouts, crash loops) from hammering the registry: a check that ran
 * less than a minute ago is reused instead of repeated.
 */
export const MIN_CHECK_INTERVAL_MS = 60 * 1000;
/** Short registry timeout; a slow or offline registry silently yields no notice. */
const REGISTRY_TIMEOUT_MS = 3_000;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export type Version = readonly [number, number, number];

export const parseVersion = (raw: string): Version | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

export const compareVersions = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** `^22.23.4 || ^24.22.1 || >=26.12.1` */
export const nodeSatisfiesRea = (node: Version): boolean => {
  if (node[0] >= REA_NODE_MIN_MAJOR) return node[0] > REA_NODE_MIN_MAJOR || compareVersions(node, REA_NODE_MIN_MAJOR_RANGE) >= 0;
  return REA_NODE_RANGES.some((floor) => node[0] === floor[0] && compareVersions(node, floor) >= 0);
};

export const NODE_REQUIREMENT = "Node ^22.23.4, ^24.22.1 or >=26.12.1";

export type ReaStatus =
  | { readonly state: "ok"; readonly version: string | null; readonly source: "env" | "checkout" | "path" }
  | { readonly state: "missing" };

/** Blocking `rea --version`; ~1 s because REA itself is a large Node app. Never call it on the launch path. */
const readReaVersion = (command: string, env: NodeJS.ProcessEnv): string | null | undefined => {
  const run = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] });
  if (run.error || run.status !== 0) return undefined;
  const parsed = parseVersion(run.stdout);
  return parsed ? parsed.join(".") : null;
};

/** Non-blocking `rea --version` for background refreshes; resolves `undefined` when REA cannot be run. */
const readReaVersionAsync = (command: string, env: NodeJS.ProcessEnv): Promise<string | null | undefined> =>
  new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, 15_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0 ? (parseVersion(out)?.join(".") ?? null) : undefined));
  });

/**
 * Resolves REA the same way `Rea.connect` launches it: env override, sibling checkout, then PATH.
 * Fast and synchronous: PATH is searched, not executed. The version of a PATH install comes from the
 * update cache (keyed by binary path + mtime) and is `null` until a background refresh has recorded it.
 * A broken-but-present `rea` is therefore reported by the MCP connect error instead of by an upfront probe.
 */
export const detectRea = (env: NodeJS.ProcessEnv = process.env): ReaStatus => {
  const launcher = resolveReaLauncher(env);
  if (!launcher) return { state: "missing" };
  const version = launcher.source === "path" ? cachedReaVersion(env, launcher.path) : null;
  return { state: "ok", version, source: launcher.source };
};

/** Exact detection for `omr setup` / `omr update`: actually runs `rea --version` (blocking, ~1 s). */
export const detectReaExact = (env: NodeJS.ProcessEnv = process.env): ReaStatus => {
  const launcher = resolveReaLauncher(env);
  if (!launcher) return { state: "missing" };
  if (launcher.source !== "path") return { state: "ok", version: null, source: launcher.source };
  const version = readReaVersion(launcher.path, env);
  return version === undefined ? { state: "missing" } : { state: "ok", version, source: "path" };
};

// ── update cache ──────────────────────────────────────────────────────────────

interface UpdateCache {
  checkedAt: number;
  latest: Partial<Record<typeof OMR_PACKAGE | typeof REA_PACKAGE, string>>;
  /** Installed REA version, valid while the binary at `path` still has this `mtimeMs`. */
  rea?: { path: string; mtimeMs: number; version: string };
}

const cachePath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "rea", "omr-update.json");

const parseCache = (text: string): UpdateCache | null => {
  try {
    const raw = JSON.parse(text) as Partial<UpdateCache>;
    if (typeof raw.checkedAt !== "number" || typeof raw.latest !== "object" || raw.latest === null) return null;
    const rea = raw.rea;
    const validRea = rea && typeof rea.path === "string" && typeof rea.mtimeMs === "number" && typeof rea.version === "string";
    return { checkedAt: raw.checkedAt, latest: raw.latest, ...(validRea ? { rea } : {}) };
  } catch {
    return null;
  }
};

const readCache = (env: NodeJS.ProcessEnv): Promise<UpdateCache | null> =>
  readFile(cachePath(env), "utf8").then(parseCache, () => null);

let cacheWriteSequence = 0;
const writeCache = async (env: NodeJS.ProcessEnv, cache: UpdateCache): Promise<void> => {
  try {
    const path = cachePath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${cacheWriteSequence++}.tmp`;
    await writeFile(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch {
    // The cache is an optimization; a read-only config dir must never break startup.
  }
};

/** npm's own `npm_config_registry` override (mirrors, private registries), else the public registry. */
const registryBase = (env: NodeJS.ProcessEnv): string => {
  const configured = env["npm_config_registry"]?.trim();
  if (!configured) return DEFAULT_REGISTRY;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href.replace(/\/+$/, "") : DEFAULT_REGISTRY;
  } catch {
    return DEFAULT_REGISTRY;
  }
};

const fetchLatest = async (env: NodeJS.ProcessEnv, name: string): Promise<string | null> => {
  try {
    const response = await fetch(`${registryBase(env)}/${name}/latest`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
};

const refreshCache = async (
  env: NodeJS.ProcessEnv,
  previous: UpdateCache | null = null,
  refreshRegistry = true,
  reaProbe?: { path: string; mtimeMs: number },
): Promise<UpdateCache> => {
  const [[omr, rea], installed] = await Promise.all([
    refreshRegistry ? Promise.all([fetchLatest(env, OMR_PACKAGE), fetchLatest(env, REA_PACKAGE)]) : [null, null],
    reaProbe ? readReaVersionAsync(reaProbe.path, env) : null,
  ]);
  const latest: UpdateCache["latest"] = { ...previous?.latest };
  if (omr) latest[OMR_PACKAGE] = omr;
  if (rea) latest[REA_PACKAGE] = rea;
  const installedRea = reaProbe && installed ? { ...reaProbe, version: installed } : previous?.rea;
  const cache: UpdateCache = {
    checkedAt: refreshRegistry ? Date.now() : previous?.checkedAt ?? 0,
    latest,
    ...(installedRea ? { rea: installedRea } : {}),
  };
  await writeCache(env, cache);
  return cache;
};

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

const cachedReaVersion = (env: NodeJS.ProcessEnv, path: string): string | null => {
  try {
    const rea = parseCache(readFileSync(cachePath(env), "utf8"))?.rea;
    return rea && rea.path === path && rea.mtimeMs === mtimeOf(path) ? rea.version : null;
  } catch {
    return null;
  }
};

const isNewer = (latest: string | undefined, installed: string | null): boolean => {
  const a = latest ? parseVersion(latest) : null;
  const b = installed ? parseVersion(installed) : null;
  return a !== null && b !== null && compareVersions(a, b) > 0;
};

/** One outdated package: what is installed and what the registry offers. */
export interface OutdatedPackage {
  readonly name: "omr" | "rea";
  readonly installed: string;
  readonly latest: string;
}

/** Packages with a newer registry release; shown as a boxed notice in the TUI and one line elsewhere. */
export interface UpdateInfo {
  readonly packages: readonly OutdatedPackage[];
}

const pendingRefreshes = new Map<string, Promise<UpdateCache>>();

const english = async (): Promise<I18n> => (await import("./i18n/index.js")).englishI18n();

const outdatedPackages = (cache: UpdateCache | null, installedRea: string | null): UpdateInfo | null => {
  if (!cache) return null;
  const packages: OutdatedPackage[] = [];
  const omr = cache.latest[OMR_PACKAGE];
  if (omr && isNewer(omr, VERSION)) packages.push({ name: "omr", installed: VERSION, latest: omr });
  const rea = cache.latest[REA_PACKAGE];
  if (rea && installedRea && isNewer(rea, installedRea)) packages.push({ name: "rea", installed: installedRea, latest: rea });
  return packages.length > 0 ? { packages } : null;
};

const sameUpdate = (a: UpdateInfo | null, b: UpdateInfo | null): boolean =>
  JSON.stringify(a?.packages ?? []) === JSON.stringify(b?.packages ?? []);

export const updateNoticeText = (info: UpdateInfo, t: I18n["t"]): string =>
  t("setup.updateAvailable", {
    packages: info.packages.map((pkg) => `${pkg.name} ${pkg.installed} → ${pkg.latest}`).join(", "),
  });

/**
 * Starts an update check without waiting on the network. `cached` is what the last check
 * recorded; `refreshed` settles with the result of this launch's registry check (or the cached
 * result again when the min-interval guard skipped it). Neither ever rejects.
 * Opt out with `OMR_NO_UPDATE_CHECK=1`; CI never checks.
 */
const startUpdateCheck = async (
  env: NodeJS.ProcessEnv,
): Promise<{ cached: UpdateInfo | null; refreshed: Promise<UpdateInfo | null> } | null> => {
  if (env["OMR_NO_UPDATE_CHECK"] === "1" || env["CI"]) return null;
  const cache = await readCache(env);
  // A future timestamp (clock moved back) counts as stale, so it cannot suppress checks.
  const age = cache ? Date.now() - cache.checkedAt : Number.POSITIVE_INFINITY;
  const needsRegistry = age < 0 || age >= MIN_CHECK_INTERVAL_MS;
  // A registry update can only update the active PATH install.
  const launcher = resolveReaLauncher(env);
  const path = launcher?.source === "path" ? launcher.path : undefined;
  const mtimeMs = path ? await stat(path).then((info) => info.mtimeMs, () => null) : null;
  const installedFrom = (next: UpdateCache | null): string | null => {
    const rea = next?.rea;
    return rea && rea.path === path && rea.mtimeMs === mtimeMs ? rea.version : null;
  };
  const installed = installedFrom(cache);
  const cached = outdatedPackages(cache, installed);
  const probe = path && mtimeMs !== null && !installed ? { path, mtimeMs } : undefined;
  const key = cachePath(env);
  let refresh = pendingRefreshes.get(key);
  if (!refresh && (needsRegistry || probe)) {
    refresh = refreshCache(env, cache, needsRegistry, probe);
    pendingRefreshes.set(key, refresh);
    void refresh.finally(() => pendingRefreshes.delete(key)).catch(() => {});
  }
  const refreshed = refresh
    ? refresh.then((next) => outdatedPackages(next, installedFrom(next)), () => cached)
    : Promise.resolve(cached);
  return { cached, refreshed };
};

/**
 * Live update notices for the TUI: reports the cached result at once (when it already shows a newer
 * release), then reports again as soon as this launch's background registry check finds a newer
 * or different release, in the same session.
 */
export const watchUpdates = async (
  env: NodeJS.ProcessEnv,
  onUpdate: (info: UpdateInfo) => void,
): Promise<void> => {
  const check = await startUpdateCheck(env);
  if (!check) return;
  if (check.cached) onUpdate(check.cached);
  const fresh = await check.refreshed;
  if (fresh && !sameUpdate(fresh, check.cached)) onUpdate(fresh);
};

/** One-line notice from the cached result; the registry refresh continues in the background. */
const updateNoticeMessage = async (env: NodeJS.ProcessEnv): Promise<LocalizedMessage | null> => {
  const cached = (await startUpdateCheck(env))?.cached;
  return cached ? (t) => updateNoticeText(cached, t) : null;
};

export const updateNotice = async (env: NodeJS.ProcessEnv = process.env, language?: I18n): Promise<string | null> => {
  const message = await updateNoticeMessage(env);
  return message ? message((language ?? await english()).t) : null;
};

/**
 * Startup notices. With `onUpdate` (the TUI) update notices are live; without it (plain CLI output)
 * only the cached result is printed, so a one-shot command never waits for the registry.
 */
export const announceRelease = async (
  env: NodeJS.ProcessEnv,
  display: (message: LocalizedMessage) => void,
  onUpdate?: (info: UpdateInfo) => void,
): Promise<void> => {
  await Promise.all([
    onUpdate
      ? watchUpdates(env, onUpdate)
      : updateNoticeMessage(env).then((notice) => { if (notice) display(notice); }),
    import("./changelog.js").then(({ whatsNewMessage }) => whatsNewMessage(env)).then((notes) => { if (notes) display(notes); }),
  ]);
};

// ── install / update ──────────────────────────────────────────────────────────

const npmInstallGlobal = (spec: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("npm", ["install", "--global", spec], { stdio: "inherit" });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });

const nodeVersion = (): Version => parseVersion(process.version) ?? [0, 0, 0];

const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLocaleLowerCase("tr");
    return answer === "" || answer === "y" || answer === "yes" || answer === "e" || answer === "evet";
  } finally {
    rl.close();
  }
};

const printBox = (lines: readonly string[]): void => {
  const width = Math.max(...lines.map(visibleWidth));
  const bar = "─".repeat(width + 2);
  process.stdout.write(`┌${bar}┐\n${lines.map((line) => `│ ${padEndAnsi(line, width)} │`).join("\n")}\n└${bar}┘\n`);
};

/**
 * Makes sure REA is available before omr starts. Returns an exit code to stop
 * with, or `null` to continue. Prompts only on an interactive terminal.
 */
export const ensureRea = async (env: NodeJS.ProcessEnv = process.env, language = english): Promise<number | null> => {
  if (env["OMR_SKIP_SETUP"] === "1") return null;
  if (resolveReaLauncher(env) || resolveReaLauncher(resolveReaEnv(env).env)) return null;
  const { t } = await language();
  const error = (message: string): void => { process.stderr.write(`${t("common.error", { message })}\n`); };

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    error(t("setup.missing", { package: REA_PACKAGE }));
    return 1;
  }
  if (!nodeSatisfiesRea(nodeVersion())) {
    error(`${t("setup.node", { requirement: NODE_REQUIREMENT, version: process.version })} ${t("setup.upgradeNode")}`);
    return 1;
  }
  printBox(t("setup.banner", { package: REA_PACKAGE }).split("\n"));
  if (!(await confirm(t("setup.confirm")))) {
    process.stdout.write(`${t("setup.skipped")}\n`);
    return 1;
  }
  const code = await npmInstallGlobal(REA_PACKAGE);
  if (code !== 0 || detectRea(env).state !== "ok") {
    error(`${t("setup.installFailed", { code })}\n${t("setup.permission")}`);
    return 1;
  }
  process.stdout.write(`${t("setup.installed")}\n\n`);
  return null;
};

/** `omr setup`: verify the environment and install REA if needed. */
export const runSetup = async (env: NodeJS.ProcessEnv = process.env, language?: I18n): Promise<number> => {
  const i18n = language ?? await english();
  const { t } = i18n;
  process.stdout.write(`omr ${VERSION} · node ${process.version}\n`);
  if (!nodeSatisfiesRea(nodeVersion())) {
    const message = t("setup.node", { requirement: NODE_REQUIREMENT, version: process.version });
    process.stderr.write(`${t("common.error", { message })}\n`);
    return 1;
  }
  const stop = await ensureRea(env, async () => i18n);
  if (stop !== null) return stop;
  const rea = detectReaExact(env);
  const sources = { env: "setup.sourceEnv", checkout: "setup.sourceCheckout", path: "setup.sourcePath" } as const;
  const where = rea.state === "ok" ? `${t(sources[rea.source])}${rea.version ? ` ${rea.version}` : ""}` : t("setup.sourceMissing");
  process.stdout.write(`REA: ${where}\n`);
  return 0;
};

/** `omr update`: bring omr and REA to the latest npm release. */
export const runUpdate = async (env: NodeJS.ProcessEnv = process.env, language?: I18n): Promise<number> => {
  const i18n = language ?? await english();
  const { t } = i18n;
  const cache = await refreshCache(env, await readCache(env));
  const rea = detectReaExact(env);
  const targets: { name: string; spec: string; from: string }[] = [];
  const latestOmr = cache.latest[OMR_PACKAGE];
  if (isNewer(latestOmr, VERSION)) targets.push({ name: "omr", spec: `${OMR_PACKAGE}@latest`, from: VERSION });
  const latestRea = cache.latest[REA_PACKAGE];
  if (rea.state === "ok" && rea.source === "path" && isNewer(latestRea, rea.version)) {
    targets.push({ name: "rea", spec: `${REA_PACKAGE}@latest`, from: rea.version ?? "?" });
  }
  if (!cache.latest[OMR_PACKAGE] && !cache.latest[REA_PACKAGE]) {
    process.stderr.write(`${t("common.error", { message: t("setup.registryError") })}\n`);
    return 1;
  }
  if (targets.length === 0) {
    const packages = `omr ${VERSION}${rea.state === "ok" && rea.version ? ` · rea ${rea.version}` : ""}`;
    process.stdout.write(`${t("setup.upToDate", { packages })}\n`);
    return 0;
  }
  let failed = false;
  for (const target of targets) {
    process.stdout.write(`${t("setup.updating", { package: target.name, from: target.from, to: target.name === "omr" ? latestOmr : latestRea })}\n`);
    const code = await npmInstallGlobal(target.spec);
    if (code !== 0) {
      failed = true;
      const message = t("setup.updateFailed", { package: target.name, code });
      process.stderr.write(`${t("common.error", { message })}\n${t("setup.permission")}\n`);
    } else if (target.name === "omr") {
      await printInstalledReleaseNotes(env, i18n);
    }
  }
  return failed ? 1 : 0;
};

const printInstalledReleaseNotes = async (env: NodeJS.ProcessEnv, language: I18n): Promise<void> => {
  try {
    const { stdout } = await promisify(execFile)("npm", ["root", "--global"], { encoding: "utf8" });
    const root = join(stdout.trim(), OMR_PACKAGE);
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const { whatsNew } = await import("./changelog.js");
    const notes = await whatsNew(env, version, join(root, "CHANGELOG.md"), language);
    if (notes) process.stdout.write(`${notes}\n`);
  } catch {
    // The next interactive start can still display notes from the installed package.
  }
};
