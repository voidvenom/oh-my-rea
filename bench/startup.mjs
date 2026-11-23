#!/usr/bin/env node
/**
 * Startup / resume latency benchmark for the interactive TUI.
 *
 * Each sample spawns omr on a real pseudo-terminal (bench/pty-probe.py, Python 3 stdlib only) and
 * timestamps what it prints. Scenarios:
 *
 *   first-paint          spawn -> alternate screen entered (the UI is on screen)
 *   interactive          spawn -> output of `/help` (a local command), typed at spawn, Enter pressed the moment the UI shows
 *   typed-ahead-enter    `/help<Enter>` typed at spawn; does the command run at all, and when
 *   stale-limits-paint   first-paint when the 24 h model-limits cache is stale and the provider never answers
 *   resume-tail          `omr --resume` of a large session: spawn -> last messages visible
 *   resume-complete      same run: spawn -> "resumed session" banner (REA connected, evidence restored)
 *
 * The fixture uses a temporary home, cwd, XDG config, and session store. English is pinned for the PTY
 * output markers, including when --entry points at an older release. The update cache starts fresh.
 * A real `rea` on PATH is used (override with OMR_REA_COMMAND)
 * because REA process start-up is part of what the user experiences.
 *
 *   node bench/startup.mjs [--samples 10] [--entry bin/omr.js] [--label name] [--out file.json]
 *                          [--scenarios first-paint,resume] [--large-messages 2400]
 *
 * Use --entry to measure another build (e.g. a checkout of an older commit) with the same harness.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";
import { writeSessionStore } from "./startup-fixture.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
if (process.platform === "win32") {
  process.stderr.write("bench:startup requires Python's POSIX PTY (Linux/macOS or WSL); the probe does not use Windows ConPTY.\n");
  process.exit(2);
}
const get = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : process.argv[index + 1];
};
const samples = Number(get("--samples", "10"));
if (!Number.isInteger(samples) || samples < 3 || samples > 100) throw new Error("--samples must be 3-100");
const entry = resolve(get("--entry", join(here, "..", "bin", "omr.js")));
const label = get("--label", "current");
const out = get("--out", null);
const largeMessages = Number(get("--large-messages", "2400"));
const wanted = new Set((get("--scenarios", "first-paint,interactive,typed-ahead-enter,stale-limits-paint,resume") ?? "").split(","));
const probe = join(here, "pty-probe.py");

const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const pick = (q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
  return { n: sorted.length, of: values.length, min: sorted[0] ?? null, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? null };
};
const round = (value) => (value === null ? null : Math.round(value));

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
if (python.status !== 0) throw new Error("python3 is required for the pty probe");
const { resolveReaLauncher } = await import("../dist/reaLauncher.js");
const rea = resolveReaLauncher(process.env)?.path;
if (!rea) throw new Error("`rea` is not on PATH (install rea-agents or set OMR_REA_COMMAND); REA start-up is part of the measurement");

const root = await mkdtemp(join(tmpdir(), "omr-startup-bench-"));
const cwd = join(root, "cwd");
const sessions = join(root, "sessions");
const xdg = join(root, "config");
const slowXdg = join(root, "config-slow");
await mkdir(cwd, { recursive: true });
const { largeId } = await writeSessionStore(sessions, { sessions: 60, messages: 280, largeMessages });

const hanging = createServer((socket) => socket.on("error", () => {})); // accepts, never answers
await new Promise((ready) => hanging.listen(0, "127.0.0.1", ready));
const hangingPort = hanging.address().port;

const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
const writeConfig = async (dir, model, withCache) => {
  await mkdir(join(dir, "rea"), { recursive: true });
  await writeFile(join(dir, "rea", "omr-model.json"), `${JSON.stringify(model)}\n`);
  if (withCache) await writeFile(join(dir, "rea", "omr-update.json"), `${JSON.stringify({ checkedAt: Date.now(), latest: { "oh-my-rea": pkg.version, "rea-agents": "0.0.1" } })}\n`);
};
// Pinned context window and a fresh update cache: no network is needed to start.
await writeConfig(xdg, { base_url: "http://127.0.0.1:9/v1", model: "bench-model", api_key_env: "BENCH_KEY", context_window: 128000 }, true);
// No pinned window, no limits cache: the limits lookup must ask a provider that never answers.
await writeConfig(slowXdg, { base_url: `http://127.0.0.1:${hangingPort}/v1`, model: "bench-slow", api_key_env: "BENCH_KEY" }, true);

const baseEnv = {
  ...fixtureEnvironment(),
  HOME: root,
  USERPROFILE: root,
  OMR_SESSIONS_DIR: sessions,
  XDG_CONFIG_HOME: xdg,
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  BENCH_KEY: "bench",
  ...(process.env.OMR_REA_COMMAND ? { OMR_REA_COMMAND: process.env.OMR_REA_COMMAND } : {}),
};

/** One sample: omr on a pty via the probe; `probeArgs` are probe options, `omrArgs` go to omr. */
const sample = async (probeArgs, omrArgs, env, timeoutS) => {
  return new Promise((resolveRun, reject) => {
    const child = spawn("python3", [probe, ...probeArgs, "--timeout", String(timeoutS), "--", process.execPath, entry, ...omrArgs], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", () => {
      try { resolveRun(JSON.parse(stdout.trim().split("\n").at(-1))); } catch { reject(new Error(`probe failed: ${stdout}\n${stderr}`)); }
    });
  });
};

const report = {
  schema: "omr-startup-benchmark/v1",
  generatedAt: new Date().toISOString(),
  label,
  entry,
  environment: { node: process.version, platform: process.platform, arch: arch(), logicalCpus: cpus().length, rea, uiLanguage: baseEnv.OMR_LANG },
  method: {
    samples,
    percentile: "nearest-rank",
    process: "fresh node process per sample on a pty; OS file cache warm, no V8 compile cache; first sample reported separately",
    fixture: { sessions: 60, largeSessionId: largeId, largeSessionMessages: largeMessages },
  },
  scenarios: {},
};

const scenario = async (name, run) => {
  const rows = [];
  for (let index = 0; index < samples; index += 1) rows.push(await run());
  report.scenarios[name] = rows;
  console.error(`measured ${name}`);
};
const summarize = (rows, pick) => {
  const values = rows.map(pick);
  return { ...stats(values), first: round(values[0] ?? null) };
};

try {
  if (wanted.has("first-paint")) {
    await scenario("first-paint", () => sample(["--after-alt", "--type", "x", "--mark", "typed=x", "--stop-on", "typed"], [], baseEnv, 20));
  }
  if (wanted.has("interactive")) {
    await scenario("interactive", () => sample(["--after-alt", "--type", "/help", "--send-after-alt", "\r", "--mark", "result=GUIDED WORKFLOWS", "--stop-on", "result"], [], baseEnv, 30));
  }
  if (wanted.has("typed-ahead-enter")) {
    await scenario("typed-ahead-enter", () => sample(["--after-alt", "--type", "/help\r", "--mark", "result=GUIDED WORKFLOWS", "--stop-on", "result"], [], baseEnv, 12));
  }
  if (wanted.has("stale-limits-paint")) {
    await scenario("stale-limits-paint", () => sample(["--after-alt", "--type", "x", "--mark", "typed=x", "--stop-on", "typed"], [], { ...baseEnv, XDG_CONFIG_HOME: slowXdg }, 30));
  }
  if (wanted.has("resume")) {
    await scenario("resume", () => sample(["--after-alt", "--mark", `tail=Finding ${largeMessages - 1}`, "--mark", "banner=resumed session", "--stop-on", "banner"], ["--resume"], baseEnv, 60));
  }

  const s = report.scenarios;
  report.summary = {};
  if (s["first-paint"]) report.summary["first-paint (cold start -> UI on screen)"] = summarize(s["first-paint"], (row) => row.altScreenMs);
  if (s["interactive"]) report.summary["interactive (typed at spawn -> /help output)"] = summarize(s["interactive"], (row) => row.marks.result);
  if (s["typed-ahead-enter"]) {
    report.summary["typed-ahead-enter (/help⏎ typed at spawn -> output; null = never ran)"] = summarize(s["typed-ahead-enter"], (row) => row.marks.result ?? Number.NaN);
  }
  if (s["stale-limits-paint"]) report.summary["stale-limits-paint (unreachable provider, no limits cache)"] = summarize(s["stale-limits-paint"], (row) => row.altScreenMs);
  if (s["resume"]) {
    report.summary["resume-first-paint (--resume -> UI on screen)"] = summarize(s["resume"], (row) => row.altScreenMs);
    report.summary["resume-tail (--resume large session -> transcript tail visible)"] = summarize(s["resume"], (row) => row.marks.tail);
    report.summary["resume-complete (--resume -> restore finished, banner)"] = summarize(s["resume"], (row) => row.marks.banner);
  }

  if (out) await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const pad = (value, width) => String(value ?? "-").padStart(width);
  console.log(`\nomr startup benchmark · ${label} · node ${process.version} · ${samples} samples · times in ms`);
  console.log(`${"scenario".padEnd(78)}${pad("n/of", 7)}${pad("first", 7)}${pad("min", 7)}${pad("p50", 7)}${pad("p95", 7)}${pad("max", 7)}`);
  for (const [name, row] of Object.entries(report.summary)) {
    console.log(`${name.padEnd(78)}${pad(`${row.n}/${row.of}`, 7)}${pad(row.first, 7)}${pad(round(row.min), 7)}${pad(round(row.p50), 7)}${pad(round(row.p95), 7)}${pad(round(row.max), 7)}`);
  }
} finally {
  hanging.close();
  await rm(root, { recursive: true, force: true });
}
