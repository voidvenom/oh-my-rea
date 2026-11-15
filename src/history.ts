import type { ChatImageBlock, ChatMessage, ChatToolCall, ThinkingBlock } from "./model.js";
import { asRecord } from "./values.js";

export interface HistoryRepairReport {
  readonly originalMessages: number;
  readonly restoredMessages: number;
  readonly droppedMessages: number;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Validate external message data without copying unknown protocol fields to a provider. */
export const normalizeChatMessage = (raw: unknown): ChatMessage | null => {
  const record = asRecord(raw);
  if (!record) return null;
  const role = record["role"];
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return null;
  const content = record["content"];
  if (content !== null && typeof content !== "string") return null;
  const message: ChatMessage = { role, content };
  if (role === "tool") {
    if (!nonEmpty(record["tool_call_id"])) return null;
    message.tool_call_id = record["tool_call_id"];
  }
  if (role === "assistant") {
    const rawCalls = record["tool_calls"];
    if (rawCalls !== undefined) {
      if (!Array.isArray(rawCalls)) return null;
      const calls: ChatToolCall[] = [];
      const ids = new Set<string>();
      for (const rawCall of rawCalls) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.["function"]);
        const id = call?.["id"];
        if (!nonEmpty(id) || ids.has(id) || call?.["type"] !== "function" ||
          !nonEmpty(fn?.["name"]) || typeof fn?.["arguments"] !== "string") return null;
        ids.add(id);
        calls.push({ id, type: "function", function: { name: fn["name"], arguments: fn["arguments"] } });
      }
      if (calls.length > 0) message.tool_calls = calls;
    }
    if (typeof record["reasoning_content"] === "string") message.reasoning_content = record["reasoning_content"];
    if (Array.isArray(record["thinking_blocks"])) {
      const blocks: ThinkingBlock[] = [];
      for (const rawBlock of record["thinking_blocks"]) {
        const block = asRecord(rawBlock);
        if (block?.["type"] === "thinking" && typeof block["thinking"] === "string" && nonEmpty(block["signature"])) {
          blocks.push({ type: "thinking", thinking: block["thinking"], signature: block["signature"] });
        } else if (block?.["type"] === "redacted_thinking" && nonEmpty(block["data"])) {
          blocks.push({ type: "redacted_thinking", data: block["data"] });
        }
      }
      if (blocks.length > 0) message.thinking_blocks = blocks;
    }
  }
  if (role === "user" && Array.isArray(record["images"])) {
    const images: ChatImageBlock[] = [];
    for (const rawImage of record["images"]) {
      const image = asRecord(rawImage);
      if (!nonEmpty(image?.["mimeType"]) || !nonEmpty(image["data"])) continue;
      const detail = image["detail"];
      images.push({ mimeType: image["mimeType"], data: image["data"],
        ...(detail === "auto" || detail === "low" || detail === "high" || detail === "original" ? { detail } : {}),
      });
    }
    if (images.length > 0) {
      message.images = images;
      const tokens = record["image_tokens"];
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) message.image_tokens = tokens;
    }
  }
  return message;
};

/** Keep malformed entries as barriers until call/result groups have been checked. */
export const repairChatHistory = (raw: readonly unknown[]): {
  messages: ChatMessage[];
  report: HistoryRepairReport;
} => {
  const normalized = raw.map(normalizeChatMessage).filter((m) => m?.role !== "system");
  const messages: ChatMessage[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const message = normalized[i];
    if (!message || message.role === "tool") continue;
    if (!message.tool_calls?.length) {
      messages.push(message);
      continue;
    }
    const results = new Map<string, ChatMessage>();
    const ids = new Set(message.tool_calls.map((call) => call.id));
    let next = i + 1;
    while (next < normalized.length) {
      const result = normalized[next];
      if (!result || result.role !== "tool") break;
      if (result.tool_call_id && ids.has(result.tool_call_id) && !results.has(result.tool_call_id)) {
        results.set(result.tool_call_id, result);
      }
      next += 1;
    }
    if ([...ids].every((id) => results.has(id))) messages.push(message, ...results.values());
    i = next - 1;
  }
  return { messages, report: { originalMessages: normalized.length, restoredMessages: messages.length,
    droppedMessages: normalized.length - messages.length } };
};
