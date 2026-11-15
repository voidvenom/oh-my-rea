import { SCHEMA_VERSION } from "../render.js";
import type { TerminalUi } from "../tui.js";
import { errorMessageOf } from "./utils.js";
import { OUTCOME_PRIORITY, exitCodeFor, type ExecutionOutcome, type ExecutionStatus } from "../outcome.js";

export interface OutputSinkOptions {
  readonly json: boolean;
  readonly writeStdout?: ((text: string) => void) | undefined;
  readonly writeStderr?: ((text: string) => void) | undefined;
}

/**
 * Single owner for all operator-facing output across TUI, `--plain`, and `--json`,
 * including once-per-session persistence warnings so disk failures are never silently swallowed.
 */
export class OutputSink {
  private uiInstance: TerminalUi | null = null;
  private readonly warnedPersistenceScopes = new Set<string>();
  private readonly stdoutWriter: (text: string) => void;
  private readonly stderrWriter: (text: string) => void;
  private readonly outcomeCounts = { completed: 0, partial: 0, cancelled: 0, budget_exhausted: 0, failed: 0 };
  private aggregate: ExecutionOutcome = { status: "completed", finishReason: null };
  private readonly finishReasons = new Map<ExecutionStatus, string | null>();

  get outcome(): ExecutionOutcome { return this.aggregate; }
  get exitCode(): number { return exitCodeFor(this.aggregate.status); }

  outcomeCheckpoint(): Readonly<Record<ExecutionStatus, number>> { return { ...this.outcomeCounts }; }

  outcomeSince(checkpoint: Readonly<Record<ExecutionStatus, number>>): ExecutionOutcome {
    const status = OUTCOME_PRIORITY.find((s) => this.outcomeCounts[s] > checkpoint[s]) ?? "completed";
    return { status, finishReason: this.finishReasons.get(status) ?? null };
  }

  recordOutcome(outcome: ExecutionOutcome): void {
    this.outcomeCounts[outcome.status] += 1;
    this.finishReasons.set(outcome.status, outcome.finishReason);
    if (OUTCOME_PRIORITY.indexOf(outcome.status) <= OUTCOME_PRIORITY.indexOf(this.aggregate.status)) {
      this.aggregate = { status: outcome.status, finishReason: outcome.finishReason };
    }
  }

  constructor(private readonly options: OutputSinkOptions) {
    this.stdoutWriter =
      options.writeStdout ?? ((text: string) => process.stdout.write(text));
    this.stderrWriter =
      options.writeStderr ?? ((text: string) => process.stderr.write(text));
  }

  get ui(): TerminalUi | null {
    return this.uiInstance;
  }

  setUi(ui: TerminalUi | null): void {
    this.uiInstance = ui;
  }

  get isJson(): boolean {
    return this.options.json;
  }

  writeRaw(text: string): void {
    this.stdoutWriter(text);
  }

  write(text: string): void {
    this.stdoutWriter(text.endsWith("\n") ? text : `${text}\n`);
  }

  writeError(text: string): void {
    this.stderrWriter(`error: ${text}\n`);
  }

  emit(type: string, data: Record<string, unknown>): void {
    if (!this.options.json) return;
    this.stdoutWriter(
      `${JSON.stringify({ schema: SCHEMA_VERSION, type, ...data })}\n`,
    );
  }

  fail(message: string): void {
    this.recordOutcome({ status: "failed", finishReason: null });
    if (this.options.json) this.emit("error", { message });
    else if (this.uiInstance) this.uiInstance.showOutput("error", message);
    else this.writeError(message);
  }

  commandResult(command: string, payload: unknown, rendered: string): void {
    if (this.options.json) {
      this.emit("command.result", { command, payload });
    } else if (this.uiInstance) {
      this.uiInstance.showOutput(`/${command}`, rendered);
    } else {
      this.write(rendered);
    }
  }

  systemNotice(text: string): void {
    if (this.uiInstance) this.uiInstance.addSystem(text);
    else if (this.options.json) this.emit("system.notice", { message: text });
    else this.write(`  ${text}`);
  }

  /**
   * Surface session persistence failures (`saveSessionHistory`, `writeOmrMeta`, `appendReport`)
   * once per scope per session instead of silently swallowing disk errors.
   */
  warnPersistenceOnce(scope: string, error: unknown): void {
    if (this.warnedPersistenceScopes.has(scope)) return;
    this.warnedPersistenceScopes.add(scope);
    const detail = errorMessageOf(error);
    const message = `session persistence warning (${scope}): ${detail}`;
    if (this.options.json) {
      this.emit("persistence.warning", { scope, message: detail });
    } else if (this.uiInstance) {
      this.uiInstance.addSystem(`⚠ ${message}`);
    } else {
      this.writeError(message);
    }
  }
}
