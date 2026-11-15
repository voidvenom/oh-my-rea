import { spawn } from "node:child_process";
import { resources } from "./resources.js";
import { terminateOwnedProcess } from "./ownedProcess.js";

export const BANG_TIMEOUT_MS = 30_000;
export const BANG_MAX_OUTPUT_BYTES = 64 * 1024;
export const STAGED_BANG_MAX_BLOCKS = 4;
export const STAGED_BANG_BLOCK_CHARS = 12_000;

export type ParsedBangInput =
  | { readonly kind: "exec"; readonly command: string; readonly attachToContext: boolean }
  | { readonly kind: "inspect" }
  | { readonly kind: "clear" };

export interface BangRunOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface StagedBangEntry {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

/**
 * Parse operator bang shell syntax (`!<cmd>` for zero-token local shell execution,
 * `!!<cmd>` to run and stage output into the next agent turn's context, `!!` to inspect, `!!clear` to clear).
 */
export const parseBangLine = (line: string): ParsedBangInput | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("!")) return null;
  if (trimmed.startsWith("!!")) {
    const rest = trimmed.slice(2).trim();
    if (!rest) return { kind: "inspect" };
    if (rest.toLowerCase() === "clear") return { kind: "clear" };
    return { kind: "exec", command: rest, attachToContext: true };
  }
  const rest = trimmed.slice(1).trim();
  if (!rest) return { kind: "inspect" };
  return { kind: "exec", command: rest, attachToContext: false };
};

/** Run an operator-initiated local shell command in `cwd` with bounded output and timeout. */
export const runBangCommand = (
  command: string,
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<BangRunOutcome> =>
  resources.run("shell", () => new Promise<BangRunOutcome>((resolve) => {
    const started = performance.now();
    const timeoutMs = Math.max(500, options.timeoutMs ?? BANG_TIMEOUT_MS);
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Fall through to direct child kill.
        }
      }
      try {
        child.kill(sig);
      } catch {
        // Process already exited.
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes >= BANG_MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = BANG_MAX_OUTPUT_BYTES - outBytes;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      if (slice.length < chunk.length) truncated = true;
      outChunks.push(slice);
      outBytes += slice.length;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes >= BANG_MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = BANG_MAX_OUTPUT_BYTES - errBytes;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      if (slice.length < chunk.length) truncated = true;
      errChunks.push(slice);
      errBytes += slice.length;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      escalationTimer = setTimeout(() => killGroup("SIGKILL"), 250);escalationTimer.unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      killGroup("SIGTERM");
      escalationTimer = setTimeout(() => killGroup("SIGKILL"), 250);escalationTimer.unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    let finished = false;
    const finish = async (exitCode: number | null, sig: NodeJS.Signals | null): Promise<void> => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {await terminateOwnedProcess(child.pid, process.platform !== "win32", child, 100);}
      catch (error) {errChunks.push(Buffer.from(`Process cleanup failed: ${String(error)}`));exitCode=127;}
      clearTimeout(escalationTimer);
      resolve({
        command,
        exitCode,
        signal: sig,
        timedOut,
        truncated,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        durationMs: Math.round(performance.now() - started),
      });
    };

    child.on("error", (error) => {
      errChunks.push(Buffer.from(error.message, "utf8"));
      void finish(127, null);
    });
    child.on("close", (code, sig) => {void finish(code, sig);});
  }), options.signal);

export const formatBangDisplay = (
  outcome: BangRunOutcome,
  staged: boolean,
): string => {
  const status = outcome.timedOut
    ? "timed out"
    : `exit ${outcome.exitCode ?? outcome.signal ?? "?"}`;
  const header = `$ ${outcome.command}  (${status} · ${outcome.durationMs}ms${staged ? " · attached to next turn" : ""})`;
  const parts = [header];
  if (outcome.stdout.trim()) parts.push(outcome.stdout.trimEnd());
  if (outcome.stderr.trim()) parts.push(`[stderr]\n${outcome.stderr.trimEnd()}`);
  if (!outcome.stdout.trim() && !outcome.stderr.trim()) parts.push("(no output)");
  if (outcome.truncated) parts.push("… [output truncated at 64 KiB]");
  return parts.join("\n");
};

export const toStagedBangEntry = (outcome: BangRunOutcome): StagedBangEntry => {
  const combined = [
    outcome.stdout.trimEnd(),
    outcome.stderr.trim() ? `[stderr]\n${outcome.stderr.trimEnd()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const clipped =
    combined.length <= STAGED_BANG_BLOCK_CHARS
      ? combined || "(no output)"
      : `${combined.slice(0, STAGED_BANG_BLOCK_CHARS)}\n… [truncated]`;
  return {
    command: outcome.command,
    exitCode: outcome.exitCode,
    output: clipped,
  };
};

export const formatStagedBangContext = (
  entries: readonly StagedBangEntry[],
): string | null => {
  if (entries.length === 0) return null;
  const blocks = entries.map(
    (entry) =>
      `$ ${entry.command} (exit ${entry.exitCode ?? "?"})\n\`\`\`text\n${entry.output}\n\`\`\``,
  );
  return `[omr operator-attached local command output:\n${blocks.join("\n\n")}\n]`;
};
