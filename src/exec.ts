import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resources } from "./resources.js";
import { terminateOwnedProcess } from "./ownedProcess.js";
import {
  lstatSync,
  mkdirSync,
  createReadStream,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  extname,
  join,
  relative,
  resolve,
  isAbsolute,
} from "node:path";

/**
 * `omr_run` per-call timeout. The default only bounds a script that did not ask for more; hitting it returns
 * an error result to the model (never ends the turn). The ceiling is opt-in via OMR_RUN_MAX_TIMEOUT_SEC.
 */
export const RUN_DEFAULT_TIMEOUT_SEC = 30;
export const runMaxTimeoutSec = (env: NodeJS.ProcessEnv = process.env): number => {
  const parsed = Number(env["OMR_RUN_MAX_TIMEOUT_SEC"]);
  // 2^31-1 ms is the largest delay a Node timer accepts; used as "no ceiling".
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2_147_483;
};
const STREAM_HEAD_BYTES = 32_768;
const STREAM_TAIL_BYTES = 16_384;
const RECORD_PREVIEW_CHARS = 4_000;

export type NetworkIsolation = "isolated" | "host" | "unavailable";

export interface RunRequest {
  /** Session `scripts/` directory: the only place scripts are resolved from and executed in. */
  readonly scriptsDir: string;
  /** Script file name (or relative path) inside {@link RunRequest.scriptsDir}. */
  readonly script: string;
  /** When set, written to {@link RunRequest.script} (replacing it) before running, so one call can write and test. */
  readonly code?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly stdin?: string | undefined;
  readonly timeoutSec?: number | undefined;
  /** Allow host networking. Default `false`: the script runs in an empty network namespace when available. */
  readonly network?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RunOutcome {
  readonly ok: boolean;
  readonly script: string;
  readonly interpreter: string;
  readonly sha256: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly networkIsolation: NetworkIsolation;
  readonly stdout: string;
  readonly stderr: string;
  readonly droppedBytes: number;
  readonly recordPath: string | null;
}

export type RunFailure = { readonly ok: false; readonly error: string };

interface Interpreter {
  readonly command: string;
  readonly leadingArgs: readonly string[];
}

/** Extension → interpreter. `.js` is deliberately absent: omr's `.js` artifacts are Frida scripts. */
const interpreterFor = (file: string): Interpreter | RunFailure => {
  switch (extname(file).toLowerCase()) {
    case ".py":
      return { command: "python3", leadingArgs: ["-B", "-u"] };
    case ".sh":
      return { command: "bash", leadingArgs: [] };
    case ".mjs":
    case ".cjs":
      return { command: "node", leadingArgs: [] };
    case ".yar":
    case ".yara":
      return { command: "yara", leadingArgs: ["-w"] };
    case ".js":
      return {
        ok: false,
        error:
          "`.js` files in the session are Frida scripts, which need a Frida runtime rather than Node. " +
          "Load them with instrument_with_frida / load_frida_script, or save plain Node code as `.mjs`/`.cjs` to run it here.",
      };
    default:
      return {
        ok: false,
        error: `No interpreter mapped for "${extname(file) || file}". Supported: .py (python3), .sh (bash), .mjs/.cjs (node), .yar/.yara (yara).`,
      };
  }
};

/**
 * Resolve `script` strictly inside `scriptsDir` (symlinks included). The model names the file, so a
 * path that leaves the session scripts directory is rejected rather than followed.
 */
export const resolveSessionScript = (
  scriptsDir: string,
  script: string,
): string | RunFailure => {
  const name = script.trim();
  if (!name)
    return {
      ok: false,
      error:
        "omr_run requires `script` (a file name inside the session scripts directory).",
    };
  let root: string;
  try {
    root = realpathSync(scriptsDir);
  } catch {
    return {
      ok: false,
      error: `Session scripts directory is not available: ${scriptsDir}`,
    };
  }
  const candidate = resolve(root, name);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return {
      ok: false,
      error: `Script not found in the session scripts directory: ${name}`,
    };
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Script must live inside the session scripts directory (${root}): ${name}`,
    };
  }
  return real;
};

const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MAX_SCRIPT_BYTES = 512 * 1024;

/** Write model-supplied code into the session scripts directory under a plain file name. */
const saveSessionScript = (
  scriptsDir: string,
  name: string,
  code: string,
): RunFailure | null => {
  const clean = name.trim();
  if (!SCRIPT_NAME_RE.test(clean)) {
    return {
      ok: false,
      error: `With \`code\`, \`script\` must be a plain file name such as decrypt.py (got "${name}").`,
    };
  }
  const mapped = interpreterFor(clean);
  if ("error" in mapped) return mapped;
  if (Buffer.byteLength(code, "utf8") > MAX_SCRIPT_BYTES) {
    return { ok: false, error: `Script exceeds ${MAX_SCRIPT_BYTES} bytes.` };
  }
  let staging: string | null = null;
  try {
    mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });
    const root = realpathSync(scriptsDir);
    const destination = join(root, clean);
    try {
      const existing = lstatSync(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        return {
          ok: false,
          error: `Script destination must be a regular file, not a symlink or directory: ${clean}`,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Publish a new inode instead of truncating the destination. This never follows a
    // destination symlink (even one swapped in after lstat) or modifies another hardlink.
    staging = join(root, `.omr-write-${randomUUID()}.tmp`);
    writeFileSync(staging, code, { flag: "wx", mode: 0o600 });
    renameSync(staging, destination);
    staging = null;
  } catch (error) {
    return {
      ok: false,
      error: `Unable to write ${clean}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (staging) {
      try {
        unlinkSync(staging);
      } catch {
        // The primary write error is returned above; cleanup must not mask it.
      }
    }
  }
  return null;
};

let netnsProbe: Promise<boolean> | undefined;

/** Whether an unprivileged empty network namespace (`unshare -rn`) is available on this host. */
export const networkIsolationAvailable = (): Promise<boolean> =>
  netnsProbe ??= new Promise((resolve) => {
    const probe = spawn("unshare", ["-rn", "true"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      resolve(false);
    }, 5_000);
    const finish = (available: boolean): void => {
      clearTimeout(timer);
      resolve(available);
    };
    probe.once("error", () => finish(false));
    probe.once("close", (code) => finish(code === 0));
  });

/** Test hook: forget the cached namespace probe. */
export const resetNetworkIsolationProbe = (): void => {
  netnsProbe = undefined;
};

/**
 * Minimal child environment. The ambient environment (provider API keys, tokens, proxy credentials)
 * is never inherited: a script written from target-derived content must not be able to read or
 * forward it.
 */
export const scrubbedEnv = (scriptsDir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env["LANG"] ?? "C.UTF-8",
    TERM: "dumb",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    OMR_SESSION_SCRIPTS: scriptsDir,
  };
  const home = process.env["HOME"];
  if (home) env["HOME"] = home;
  return env;
};

/** Keeps the first and last bytes of a stream and counts what was dropped in between. */
class BoundedCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);
  dropped = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < STREAM_HEAD_BYTES) {
      const take = Math.min(STREAM_HEAD_BYTES - this.headBytes, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    const merged = Buffer.concat([this.tail, rest]);
    if (merged.length > STREAM_TAIL_BYTES) {
      this.dropped += merged.length - STREAM_TAIL_BYTES;
      this.tail = merged.subarray(merged.length - STREAM_TAIL_BYTES);
    } else {
      this.tail = merged;
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = this.tail.toString("utf8");
    return this.dropped > 0
      ? `${head}\n… [omr dropped ${this.dropped} bytes from the middle of this stream] …\n${tail}`
      : head + tail;
  }
}

const preview = (text: string): string =>
  text.length <= RECORD_PREVIEW_CHARS
    ? text
    : `${text.slice(0, RECORD_PREVIEW_CHARS)}…`;

const writeRunRecord = (
  scriptsDir: string,
  outcome: Omit<RunOutcome, "recordPath">,
  args: readonly string[],
): string | null => {
  try {
    const dir = join(scriptsDir, ".runs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${basename(outcome.script)}.${stamp}.json`);
    const record = {
      script: outcome.script,
      sha256: outcome.sha256,
      interpreter: outcome.interpreter,
      args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      durationMs: outcome.durationMs,
      networkIsolation: outcome.networkIsolation,
      stdout: preview(outcome.stdout),
      stderr: preview(outcome.stderr),
    };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    return path;
  } catch {
    return null;
  }
};

/**
 * Run a script from the session `scripts/` directory under a timeout, with a scrubbed environment,
 * bounded output, and (by default) no network. The target binary is never executed here; running a
 * target stays with REA's own tools.
 */
export const runSessionScript = async (
  request: RunRequest,
): Promise<RunOutcome | RunFailure> => {
  if (request.code !== undefined) {
    const saved = saveSessionScript(
      request.scriptsDir,
      request.script,
      request.code,
    );
    if (saved) return saved;
  }
  const resolved = resolveSessionScript(request.scriptsDir, request.script);
  if (typeof resolved !== "string") return resolved;
  const interpreter = interpreterFor(resolved);
  if ("error" in interpreter) return interpreter;

  const timeoutSec = Math.min(
    Math.max(request.timeoutSec ?? RUN_DEFAULT_TIMEOUT_SEC, 1),
    runMaxTimeoutSec(),
  );
  const args = (request.args ?? []).map(String);
  const wantNetwork = request.network === true;
  const canIsolate = !wantNetwork && await networkIsolationAvailable();
  request.signal?.throwIfAborted();
  const networkIsolation: NetworkIsolation = wantNetwork
    ? "host"
    : canIsolate
      ? "isolated"
      : "unavailable";

  const inner = [
    interpreter.command,
    ...interpreter.leadingArgs,
    resolved,
    ...args,
  ];
  const [command, ...commandArgs] =
    !wantNetwork && canIsolate ? ["unshare", "-rn", "--", ...inner] : inner;

  let sha256: string;
  try {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(resolved, { signal: request.signal })) digest.update(chunk);
    sha256 = digest.digest("hex");
  } catch {
    return { ok: false, error: `Unable to read script: ${request.script}` };
  }

  const started = performance.now();
  const stdout = new BoundedCapture();
  const stderr = new BoundedCapture();
  let timedOut = false;
  let aborted = false;

  return await resources.run("script", () => new Promise<RunOutcome | RunFailure>((settle) => {
    const child = spawn(command!, commandArgs, {
      cwd: request.scriptsDir,
      env: scrubbedEnv(request.scriptsDir),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutSec * 1_000);
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin ?? "");

    child.once("error", (error) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      settle({
        ok: false,
        error: `Unable to start ${interpreter.command}: ${error.message}${
          interpreter.command === "yara"
            ? " (install the `yara` CLI to compile or scan rules)"
            : ""
        }`,
      });
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      try { await terminateOwnedProcess(child.pid, process.platform !== "win32", child, 100); }
      catch (error) { settle({ok:false,error:`Script process cleanup failed: ${error instanceof Error ? error.message : String(error)}`});return; }
      const base = {
        ok: exitCode === 0 && !timedOut && !aborted,
        script: resolved,
        interpreter: interpreter.command,
        sha256,
        exitCode,
        signal,
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - started),
        networkIsolation,
        stdout: stdout.text(),
        stderr: stderr.text(),
        droppedBytes: stdout.dropped + stderr.dropped,
      };
      settle({
        ...base,
        recordPath: writeRunRecord(request.scriptsDir, base, args),
      });
    });
  }), request.signal);
};

/** Render a run for the model: facts first, streams verbatim. */
export const renderRunOutcome = (outcome: RunOutcome): string => {
  const status = outcome.timedOut
    ? "TIMED OUT"
    : outcome.aborted
      ? "ABORTED"
      : outcome.exitCode === 0
        ? "exit 0"
        : `exit ${String(outcome.exitCode ?? outcome.signal ?? "unknown")}`;
  const network =
    outcome.networkIsolation === "isolated"
      ? "network: isolated (empty namespace; loopback is down)"
      : outcome.networkIsolation === "host"
        ? "network: host"
        : "network: NOT isolated (unprivileged network namespaces are unavailable on this host)";
  return [
    `omr_run ${basename(outcome.script)} (${outcome.interpreter}) → ${status} in ${outcome.durationMs} ms`,
    `sha256: ${outcome.sha256}`,
    network,
    outcome.recordPath
      ? `run record: ${outcome.recordPath}`
      : "run record: not written",
    `--- stdout ---\n${outcome.stdout || "(empty)"}`,
    `--- stderr ---\n${outcome.stderr || "(empty)"}`,
  ].join("\n");
};
