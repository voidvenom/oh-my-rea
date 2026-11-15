/** Runtime narrowing shared by every boundary in omr. Fields stay unknown until checked. */
export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value === null || typeof value !== "object") return null;
  // Values here are JSON documents from JSON.parse, the MCP SDK or omp RPC frames.
  return value as Record<string, unknown>;
};

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
