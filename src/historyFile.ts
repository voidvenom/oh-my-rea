import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { asRecord } from "./values.js";

const WINDOW_BYTES = 128 * 1024;
const ACTIVE_HISTORY_CHARS = 2 * 1024 * 1024;
const ACTIVE_HISTORY_ENTRIES = 512;
const messagesStart = /(?:^|[,{])\s*"messages"\s*:\s*\[/;

export const LARGE_HISTORY_BYTES = 4 * 1024 * 1024;

const decodeHeader = (head: string): { fields: Record<string, unknown>; end: number } | null => {
  const match = messagesStart.exec(head);
  if (!match) return null;
  try {
    const fields = asRecord(JSON.parse(head.slice(0, match.index + (match[0].startsWith("{") ? 1 : 0)) + "}"));
    return fields && { fields, end: match.index + match[0].length };
  } catch {
    return null;
  }
};

/** Read only the object fields before the writer's messages array. */
export const readHistoryHeader = async (path: string) => {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(WINDOW_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return decodeHeader(head.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
};

/** Walk backward over complete JSON records in a bounded suffix of the messages array. */
export const readHistoryTail = async (path: string): Promise<unknown[]> => {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, WINDOW_BYTES);
    const tail = Buffer.alloc(length);
    const { bytesRead } = await handle.read(tail, 0, length, size - length);
    const raw = tail.toString("utf8", 0, bytesRead).trimEnd();
    const records: unknown[] = [];
    if (!raw.endsWith("}")) return records;
    let cursor = raw.length - 2;
    while (cursor >= 0 && /\s/.test(raw[cursor]!)) cursor -= 1;
    if (raw[cursor--] !== "]") return records;

    while (cursor >= 0 && records.length < 40) {
      while (cursor >= 0 && /[\s,]/.test(raw[cursor]!)) cursor -= 1;
      if (raw[cursor] !== "}") break;
      const end = cursor + 1;
      let depth = 0;
      let inString = false;
      for (; cursor >= 0; cursor -= 1) {
        const char = raw[cursor];
        if (char === '"') {
          let before = cursor - 1;
          while (raw[before] === "\\") before -= 1;
          if ((cursor - before) % 2 === 1) inString = !inString;
        } else if (!inString) {
          if (char === "}" || char === "]") depth += 1;
          if (char === "{" || char === "[") depth -= 1;
          if (depth === 0) break;
        }
      }
      if (cursor < 0) break;
      try { records.push(JSON.parse(raw.slice(cursor, end))); } catch { break; }
      cursor -= 1;
    }
    return records.reverse();
  } finally {
    await handle.close();
  }
};

/** Keep a recent working history for exceptionally large old checkpoints. */
export const readLargeHistory = async (path: string) => {
  const header = await readHistoryHeader(path);
  if (!header) return null;
  // Byte offsets differ from JS character positions. Locate the same boundary in the stream.
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: WINDOW_BYTES });
  const recent: Array<{ value: unknown; chars: number }> = [];
  let recentChars = 0;
  let count = 0;
  let firstUser: string | undefined;
  let prefix: string | null = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pieces: string[] = [];
  let chars = 0;
  const structural = /["\\[\]{}]/g;
  const insideString = /["\\]/g;

  const keep = (chunk: string): void => {
    chars += chunk.length;
    if (chars <= ACTIVE_HISTORY_CHARS) pieces.push(chunk);
    else pieces.length = 0;
  };
  const finishRecord = (): void => {
    count += 1;
    try {
      if (pieces.length === 0) return;
      const value: unknown = JSON.parse(pieces.join(""));
      const entry = asRecord(value);
      if (firstUser === undefined && entry?.["role"] === "user" && typeof entry["content"] === "string") {
        firstUser = entry["content"].slice(0, 16_000);
      }
      recent.push({ value, chars });
      recentChars += chars;
      while (recent.length > ACTIVE_HISTORY_ENTRIES || recentChars > ACTIVE_HISTORY_CHARS) {
        recentChars -= recent.shift()!.chars;
      }
    } catch {
      // The existing history repair boundary discards malformed records.
    } finally {
      chars = 0;
      pieces = [];
    }
  };

  for await (const raw of stream) {
    let chunk: string = raw;
    if (prefix !== null) {
      prefix += chunk;
      const start = decodeHeader(prefix);
      if (!start) {
        if (prefix.length > WINDOW_BYTES) return null;
        continue;
      }
      chunk = prefix.slice(start.end);
      prefix = null;
    }
    let offset = 0;
    let recordStart = depth > 0 ? 0 : -1;
    while (offset < chunk.length) {
      if (escaped) { escaped = false; offset += 1; continue; }
      const matcher = inString ? insideString : structural;
      matcher.lastIndex = offset;
      const hit = matcher.exec(chunk);
      if (!hit) break;
      offset = hit.index + 1;
      const char = hit[0];
      if (inString) {
        if (char === "\\") escaped = true;
        else inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        if (depth === 0) recordStart = hit.index;
        depth += 1;
      } else if (char === "}" || char === "]") {
        if (depth === 0) {
          return { fields: header.fields, entries: recent.map((entry) => entry.value), count, firstUser };
        }
        depth -= 1;
        if (depth === 0) {
          keep(chunk.slice(recordStart, offset));
          finishRecord();
          recordStart = -1;
        }
      }
    }
    if (recordStart >= 0) keep(chunk.slice(recordStart));
  }
  return null;
};
