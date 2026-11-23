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

/** Plain-language reason a turn ended without a final answer, naming the setting that controls it. */
export const describeIncompleteTurn = (finishReason: string | null): string => {
  switch (finishReason) {
    case "step_budget": return "step limit reached; raise OMR_MAX_STEPS / OMR_AUTO_EXTEND_STEPS, or send `continue`";
    case "length": return "model output hit the max_tokens limit; raise OMR_MAX_TOKENS or send `continue`";
    case "tool_calls": return "provider returned no usable tool call; send `continue` to retry";
    case "content_filter": return "provider content filter stopped the response";
    case "context_window": return "context window is full; run /compaction or start a new session";
    case "budget": return "session token budget reached; raise it with `/budget <tokens>`";
    case "investigation_review": return "open provider questions have no recorded decision";
    case null: return "provider ended the response without a finish reason";
    default: return `provider ended the turn with finish_reason=${finishReason}`;
  }
};
