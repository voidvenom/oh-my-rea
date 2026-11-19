/**
 * First-run setup and update management.
 *
 * omr is a client for REA, which must be installed globally (`rea-agents` on npm,
 * repository `morluto/rea`). This module detects REA, asks for consent before
 * installing it, and keeps both packages current. It never installs anything
 * without an explicit "yes" (or an explicit `omr setup` / `omr update` command)
 * and never sends anything but the public package name to the npm registry.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

export const OMR_PACKAGE = "oh-my-rea";
export const REA_PACKAGE = "rea-agents";
/** `engines.node` of rea-agents; omr refuses to install a REA the running Node cannot start. */
const REA_NODE_RANGES: readonly [number, number, number][] = [[22, 23, 4], [24, 22, 1]];
const REA_NODE_MIN_MAJOR = 26;
const REA_NODE_MIN_MAJOR_RANGE: [number, number, number] = [26, 12, 1];
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 4_000;

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

const siblingCheckout = (): string | undefined =>
  [
    fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
    fileURLToPath(new URL("../../rea/scripts/rea.mjs", import.meta.url)),
  ].find((candidate) => existsSync(candidate));

/** Blocking `rea --version`; ~1 s because REA itself is a large Node app. Never call it on the launch path. */
const readReaVersion = (command: string, args: readonly string[]): string | null | undefined => {
  const run = spawnSync(command, [...args, "--version"], { encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] });
  if (run.error || run.status !== 0) return undefined;
  const parsed = parseVersion(run.stdout);
  return parsed ? parsed.join(".") : null;
};

/** Non-blocking `rea --version` for background refreshes; resolves `undefined` when REA cannot be run. */
const readReaVersionAsync = (command: string): Promise<string | null | undefined> =>
  new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
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

/** Resolves a command on PATH without spawning it (a few `stat` calls instead of a ~1 s process). */
export const findOnPath = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const extensions = process.platform === "win32" ? ["", ...(env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here; keep walking PATH
      }
    }
  }
  return undefined;
};

/**
 * Resolves REA the same way `Rea.connect` launches it: env override, sibling checkout, then PATH.
 * Fast and synchronous: PATH is searched, not executed. The version of a PATH install comes from the
 * update cache (keyed by binary path + mtime) and is `null` until a background refresh has recorded it.
 * A broken-but-present `rea` is therefore reported by the MCP connect error instead of by an upfront probe.
 */
export const detectRea = (env: NodeJS.ProcessEnv = process.env): ReaStatus => {
  const override = env["OMR_REA_COMMAND"];
  if (override) return { state: "ok", version: null, source: "env" };
  if (siblingCheckout()) return { state: "ok", version: null, source: "checkout" };
  const path = findOnPath("rea", env);
  if (!path) return { state: "missing" };
  return { state: "ok", version: cachedReaVersion(env, path), source: "path" };
};

/** Exact detection for `omr setup` / `omr update`: actually runs `rea --version` (blocking, ~1 s). */
export const detectReaExact = (env: NodeJS.ProcessEnv = process.env): ReaStatus => {
  const fast = detectRea(env);
  if (fast.state !== "ok" || fast.source !== "path") return fast;
  const version = readReaVersion("rea", []);
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

const readCache = (env: NodeJS.ProcessEnv): UpdateCache | null => {
  try {
    const raw = JSON.parse(readFileSync(cachePath(env), "utf8")) as Partial<UpdateCache>;
    if (typeof raw.checkedAt !== "number" || typeof raw.latest !== "object" || raw.latest === null) return null;
    const rea = raw.rea;
    const validRea = rea && typeof rea.path === "string" && typeof rea.mtimeMs === "number" && typeof rea.version === "string";
    return { checkedAt: raw.checkedAt, latest: raw.latest, ...(validRea ? { rea } : {}) };
  } catch {
    return null;
  }
};

const writeCache = (env: NodeJS.ProcessEnv, cache: UpdateCache): void => {
  try {
    const path = cachePath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // The cache is an optimization; a read-only config dir must never break startup.
  }
};

const fetchLatest = async (name: string): Promise<string | null> => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
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

const refreshCache = async (env: NodeJS.ProcessEnv): Promise<UpdateCache> => {
  const previous = readCache(env);
  const [omr, rea] = await Promise.all([fetchLatest(OMR_PACKAGE), fetchLatest(REA_PACKAGE)]);
  const latest: UpdateCache["latest"] = { ...previous?.latest };
  if (omr) latest[OMR_PACKAGE] = omr;
  if (rea) latest[REA_PACKAGE] = rea;
  const cache: UpdateCache = { checkedAt: Date.now(), latest, ...(previous?.rea ? { rea: previous.rea } : {}) };
  writeCache(env, cache);
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
  const rea = readCache(env)?.rea;
  return rea && rea.path === path && rea.mtimeMs === mtimeOf(path) ? rea.version : null;
};

/** Records the installed REA version off the launch path so the update notice can compare it next start. */
const refreshReaVersion = async (env: NodeJS.ProcessEnv, path: string): Promise<void> => {
  const mtimeMs = mtimeOf(path);
  const version = await readReaVersionAsync(path);
  if (mtimeMs === null || !version) return;
  const previous = readCache(env) ?? { checkedAt: 0, latest: {} };
  writeCache(env, { ...previous, rea: { path, mtimeMs, version } });
};

const isNewer = (latest: string | undefined, installed: string | null): boolean => {
  const a = latest ? parseVersion(latest) : null;
  const b = installed ? parseVersion(installed) : null;
  return a !== null && b !== null && compareVersions(a, b) > 0;
};

/**
 * One-line notice when the last daily check found newer packages. The registry
 * refresh runs in the background and is picked up on the next start, so startup
 * never waits on the network. Opt out with `OMR_NO_UPDATE_CHECK=1`.
 */
export const updateNotice = (env: NodeJS.ProcessEnv = process.env): string | null => {
  if (env["OMR_NO_UPDATE_CHECK"] === "1" || env["CI"]) return null;
  const cache = readCache(env);
  if (!cache || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) {
    void refreshCache(env).catch(() => {});
  }
  if (!cache) return null;
  const rea = detectRea(env);
  if (rea.state === "ok" && rea.source === "path" && rea.version === null) {
    const path = findOnPath("rea", env);
    if (path) void refreshReaVersion(env, path).catch(() => {});
  }
  const outdated: string[] = [];
  if (isNewer(cache.latest[OMR_PACKAGE], VERSION)) outdated.push(`omr ${cache.latest[OMR_PACKAGE]}`);
  if (rea.state === "ok" && rea.source === "path" && isNewer(cache.latest[REA_PACKAGE], rea.version)) outdated.push(`rea ${cache.latest[REA_PACKAGE]}`);
  return outdated.length ? `update available: ${outdated.join(", ")} — run \`omr update\`` : null;
};

// ── install / update ──────────────────────────────────────────────────────────

const npmInstallGlobal = (spec: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("npm", ["install", "--global", spec], { stdio: "inherit" });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });

const permissionHint = (): string =>
  "If npm reported EACCES, point npm at a user prefix instead of using sudo:\n" +
  "  npm config set prefix ~/.local   # then make sure ~/.local/bin is on PATH";

const nodeVersion = (): Version => parseVersion(process.version) ?? [0, 0, 0];

const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes" || answer === "e" || answer === "evet";
  } finally {
    rl.close();
  }
};

const BANNER = [
  "omr works together with REA (Reverse Engineer Anything).",
  "REA is not installed yet. It will be installed globally from the official npm",
  `package "${REA_PACKAGE}" (github.com/morluto/rea) with:`,
  "",
  `    npm install --global ${REA_PACKAGE}`,
  "",
  "Both omr and REA will then be kept up to date with `omr update`.",
];

const printBox = (lines: readonly string[]): void => {
  const width = Math.max(...lines.map((line) => line.length));
  const bar = "─".repeat(width + 2);
  process.stdout.write(`┌${bar}┐\n${lines.map((line) => `│ ${line.padEnd(width)} │`).join("\n")}\n└${bar}┘\n`);
};

/**
 * Makes sure REA is available before omr starts. Returns an exit code to stop
 * with, or `null` to continue. Prompts only on an interactive terminal.
 */
export const ensureRea = async (env: NodeJS.ProcessEnv = process.env): Promise<number | null> => {
  if (env["OMR_SKIP_SETUP"] === "1") return null;
  if (detectRea(env).state === "ok") return null;

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    process.stderr.write(
      `error: REA is not installed. Run \`omr setup\` in a terminal, or: npm install --global ${REA_PACKAGE}\n`,
    );
    return 1;
  }
  if (!nodeSatisfiesRea(nodeVersion())) {
    process.stderr.write(`error: REA requires ${NODE_REQUIREMENT}; this is ${process.version}. Upgrade Node, then run \`omr setup\`.\n`);
    return 1;
  }
  printBox(BANNER);
  if (!(await confirm("Install REA now? [Y/n] "))) {
    process.stdout.write("Skipped. omr cannot run without REA; run `omr setup` when you are ready.\n");
    return 1;
  }
  const code = await npmInstallGlobal(REA_PACKAGE);
  if (code !== 0 || detectRea(env).state !== "ok") {
    process.stderr.write(`error: REA installation failed (exit ${code}).\n${permissionHint()}\n`);
    return 1;
  }
  process.stdout.write("REA installed.\n\n");
  return null;
};

/** `omr setup`: verify the environment and install REA if needed. */
export const runSetup = async (env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  process.stdout.write(`omr ${VERSION} · node ${process.version}\n`);
  if (!nodeSatisfiesRea(nodeVersion())) {
    process.stderr.write(`error: REA requires ${NODE_REQUIREMENT}; this is ${process.version}.\n`);
    return 1;
  }
  const stop = await ensureRea(env);
  if (stop !== null) return stop;
  const rea = detectReaExact(env);
  const where = rea.state === "ok" ? `${rea.source}${rea.version ? ` ${rea.version}` : ""}` : "missing";
  process.stdout.write(`REA: ${where}\n`);
  return 0;
};

/** `omr update`: bring omr and REA to the latest npm release. */
export const runUpdate = async (env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const cache = await refreshCache(env);
  const rea = detectReaExact(env);
  const targets: { name: string; spec: string; from: string }[] = [];
  const latestOmr = cache.latest[OMR_PACKAGE];
  if (isNewer(latestOmr, VERSION)) targets.push({ name: "omr", spec: `${OMR_PACKAGE}@latest`, from: VERSION });
  const latestRea = cache.latest[REA_PACKAGE];
  if (rea.state === "ok" && rea.source === "path" && isNewer(latestRea, rea.version)) {
    targets.push({ name: "rea", spec: `${REA_PACKAGE}@latest`, from: rea.version ?? "?" });
  }
  if (!cache.latest[OMR_PACKAGE] && !cache.latest[REA_PACKAGE]) {
    process.stderr.write("error: could not reach the npm registry; try again later.\n");
    return 1;
  }
  if (targets.length === 0) {
    process.stdout.write(`omr ${VERSION}${rea.state === "ok" && rea.version ? ` · rea ${rea.version}` : ""} — already up to date.\n`);
    return 0;
  }
  let failed = false;
  for (const target of targets) {
    process.stdout.write(`updating ${target.name} ${target.from} → ${target.name === "omr" ? latestOmr : latestRea}\n`);
    const code = await npmInstallGlobal(target.spec);
    if (code !== 0) {
      failed = true;
      process.stderr.write(`error: ${target.name} update failed (exit ${code}).\n${permissionHint()}\n`);
    }
  }
  return failed ? 1 : 0;
};
