/** Stable outcomes shared by model turns, commands, workers, and embedding callers. */
export type ExecutionStatus = "completed" | "partial" | "cancelled" | "budget_exhausted" | "failed";

export interface ExecutionOutcome {
  readonly status: ExecutionStatus;
  readonly finishReason: string | null;
}

export interface CommandOutcome extends ExecutionOutcome {
  readonly keepRunning: boolean;
}

export const OUTCOME_PRIORITY: readonly ExecutionStatus[] = [
  "failed", "cancelled", "budget_exhausted", "partial", "completed",
];

export const exitCodeFor = (status: ExecutionStatus): number =>
  status === "completed" ? 0 : status === "cancelled" ? 130 : status === "failed" ? 1 : 2;
