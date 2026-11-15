import { open, stat } from "node:fs/promises";
import { asArray, asNumber, asRecord, asString } from "./values.js";

export interface JournalToolEntry {
  seq: number;
  tool: string;
  at: string;
  ok: boolean | null;
  duration_ms: number | null;
  evidence_ids: string[];
  error_code: string | null;
}

export interface JournalUnknownHead {
  unknown_id: string;
  revision: number | null;
  status: string;
  severity: string;
  domain: string;
  at: string;
}

export interface JournalCheckpointEntry {
  through_seq: number | null;
  path: string;
  records: number | null;
  unknowns: number | null;
  bytes: number | null;
  at: string;
}

export interface JournalState {
  readonly phase: "unstarted" | "running" | "ended";
  readonly outcome: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly elapsed_ms: number | null;
  readonly journal_bytes: number;
  readonly source: "missing" | "live" | "unavailable";
  readonly read_error: string | null;
  readonly malformed_records: number;
  readonly counts: {
    readonly records: number;
    readonly tool_calls: number;
    readonly tool_failures: number;
    readonly evidence: number;
    readonly unknowns: number;
    readonly open_unknowns: number;
    readonly checkpoints: number;
  };
  readonly tools: JournalToolEntry[];
  readonly evidence_ids: string[];
  readonly unknowns: JournalUnknownHead[];
  readonly checkpoints: JournalCheckpointEntry[];
}

const CHUNK_BYTES = 64 * 1024;
const MAX_PENDING_CALLS = 512;
const MAX_RECENT_TOOLS = 60;
const MAX_RECENT_EVIDENCE = 80;
const MAX_EVIDENCE_SET = 50_000;
const MAX_RECENT_CHECKPOINTS = 20;

/**
 * Read at most the trailing `maxBytes` of a UTF-8 file without loading the full
 * file into memory. Skips any partial leading line when seeking into the middle.
 */
export const readFileTail = async (
  path: string,
  maxBytes = 32_768,
): Promise<string> => {
  let info;
  try {
    info = await stat(path);
  } catch {
    return "";
  }
  if (!info.isFile() || info.size <= 0) return "";

  const start = Math.max(0, info.size - maxBytes);
  const length = info.size - start;
  const handle = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let readTotal = 0;
    while (readTotal < length) {
      const { bytesRead } = await handle.read(
        buf,
        readTotal,
        length - readTotal,
        start + readTotal,
      );
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    const text = buf.subarray(0, readTotal).toString("utf8");
    if (start === 0) return text;
    const firstNl = text.indexOf("\n");
    return firstNl >= 0 && firstNl + 1 < text.length
      ? text.slice(firstNl + 1)
      : text;
  } finally {
    await handle.close();
  }
};

/**
 * Incremental O(new bytes) S1 `journal.jsonl` tail reader.
 * Advances byte offset strictly up to the last `\n` so concurrent half-written
 * JSONL records are never corrupted or skipped, and bounds retained collections.
 */
export class JournalTailer {
  private syncing: Promise<JournalState> | null = null;
  private offset = 0;
  private journalBytes = 0;
  private records = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private checkpointsCount = 0;
  private startedAt: string | null = null;
  private endedAt: string | null = null;
  private outcome: string | null = null;
  private elapsedMs: number | null = null;
  private hasStarted = false;
  private hasEnded = false;
  private identity: string | null = null;
  private source: JournalState["source"] = "missing";
  private readError: string | null = null;
  private malformedRecords = 0;
  private prefixFence = Buffer.alloc(0);
  private tailFence = Buffer.alloc(0);

  private readonly pendingCalls = new Map<
    string,
    { tool: string; at: string; seq: number }
  >();
  private readonly recentTools: JournalToolEntry[] = [];
  private readonly evidenceSet = new Set<string>();
  private readonly recentEvidenceIds: string[] = [];
  private readonly unknowns = new Map<string, JournalUnknownHead>();
  private readonly recentCheckpoints: JournalCheckpointEntry[] = [];

  constructor(private readonly journalPath: string) {}

  private reset(): void {
    this.offset = 0;
    this.journalBytes = 0;
    this.records = 0;
    this.toolCalls = 0;
    this.toolFailures = 0;
    this.checkpointsCount = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.outcome = null;
    this.elapsedMs = null;
    this.hasStarted = false;
    this.hasEnded = false;
    this.identity = null;
    this.malformedRecords = 0;
    this.prefixFence = Buffer.alloc(0);
    this.tailFence = Buffer.alloc(0);
    this.pendingCalls.clear();
    this.recentTools.length = 0;
    this.evidenceSet.clear();
    this.recentEvidenceIds.length = 0;
    this.unknowns.clear();
    this.recentCheckpoints.length = 0;
  }

  private ingestLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.malformedRecords += 1;
      return;
    }
    const record = asRecord(parsed);
    if (!record || typeof record["type"] !== "string") {this.malformedRecords += 1;return;}

    this.records += 1;
    const seq = asNumber(record["seq"]) ?? this.records;
    const at = asString(record["at"]);
    const type = record["type"];

    if (type === "session.start") {
      this.hasStarted = true;
      this.startedAt = at || this.startedAt;
    } else if (type === "session.end") {
      this.hasEnded = true;
      this.endedAt = at || this.endedAt;
      this.outcome = asString(record["outcome"]) || null;
      this.elapsedMs = asNumber(record["elapsed_ms"]);
    } else if (type === "tool.call") {
      this.toolCalls += 1;
      const callId = asString(record["call_id"]);
      if (callId) {
        if (this.pendingCalls.size >= MAX_PENDING_CALLS) {
          const oldest = this.pendingCalls.keys().next().value;
          if (oldest !== undefined) this.pendingCalls.delete(oldest);
        }
        this.pendingCalls.set(callId, {
          tool: asString(record["tool"]),
          at,
          seq,
        });
      }
    } else if (type === "tool.result") {
      const callId = asString(record["call_id"]);
      const call = callId ? this.pendingCalls.get(callId) : undefined;
      if (callId) this.pendingCalls.delete(callId);

      const ok = record["ok"] === true;
      if (!ok) this.toolFailures += 1;

      const ids = asArray(record["evidence_ids"]).filter(
        (id): id is string => typeof id === "string",
      );
      for (const id of ids) {
        if (!this.evidenceSet.has(id)) {
          if (this.evidenceSet.size < MAX_EVIDENCE_SET)
            this.evidenceSet.add(id);
          this.recentEvidenceIds.push(id);
          if (this.recentEvidenceIds.length > MAX_RECENT_EVIDENCE)
            this.recentEvidenceIds.shift();
        }
      }

      this.recentTools.push({
        seq: call?.seq ?? seq,
        tool: asString(record["tool"], call?.tool ?? "?"),
        at: call?.at ?? at,
        ok,
        duration_ms: asNumber(record["duration_ms"]),
        evidence_ids: ids,
        error_code:
          typeof record["error_code"] === "string"
            ? record["error_code"]
            : null,
      });
      if (this.recentTools.length > MAX_RECENT_TOOLS) this.recentTools.shift();
    } else if (type === "unknown.changed") {
      const unknownId = asString(record["unknown_id"]);
      if (unknownId) {
        this.unknowns.set(unknownId, {
          unknown_id: unknownId,
          revision: asNumber(record["revision"]),
          status: asString(record["status"], "?"),
          severity: asString(record["severity"], "?"),
          domain: asString(record["domain"], "?"),
          at,
        });
      }
    } else if (type === "checkpoint") {
      this.checkpointsCount += 1;
      this.recentCheckpoints.push({
        through_seq: asNumber(record["through_seq"]),
        path: asString(record["path"]),
        records: asNumber(record["records"]),
        unknowns: asNumber(record["unknowns"]),
        bytes: asNumber(record["bytes"]),
        at,
      });
      if (this.recentCheckpoints.length > MAX_RECENT_CHECKPOINTS)
        this.recentCheckpoints.shift();
    }
  }

  sync(): Promise<JournalState> {
    if (!this.syncing) {
      this.syncing = this.readIncremental().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async readIncremental(): Promise<JournalState> {
    let info;
    try {
      info = await stat(this.journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {if (this.offset > 0) this.reset();this.source="missing";this.readError=null;}
      else {this.source="unavailable";this.readError=error instanceof Error?error.message:String(error);}
      return this.snapshot();
    }

    if (!info.isFile()) {this.source="unavailable";this.readError="Journal path is not a regular file";return this.snapshot();}
    const identity=`${info.dev}:${info.ino}`;
    if(this.identity!==null&&this.identity!==identity)this.reset();
    this.identity=identity;this.source="live";this.readError=null;
    this.journalBytes = info.size;

    if (info.size < this.offset) {
      this.reset();
      this.identity=identity;
      this.journalBytes = info.size;
    }

    if (info.size > this.offset || this.offset > 0) {
      let handle;
      try {
        handle = await open(this.journalPath, "r");
        if (this.offset > 0 && this.tailFence.length) {
          const prefix=Buffer.alloc(this.prefixFence.length),tail=Buffer.alloc(this.tailFence.length);
          const [p,t]=await Promise.all([handle.read(prefix,0,prefix.length,0),handle.read(tail,0,tail.length,this.offset-tail.length)]);
          if(p.bytesRead!==prefix.length||t.bytesRead!==tail.length||!prefix.equals(this.prefixFence)||!tail.equals(this.tailFence)) {
            // Truncate+rewrite can regrow past the old offset between polls without changing inode.
            this.reset();this.identity=identity;this.journalBytes=info.size;
          }
        }
        const chunk = Buffer.allocUnsafe(
          Math.min(CHUNK_BYTES, info.size - this.offset),
        );
        let carry = Buffer.alloc(0);
        let pos = this.offset;

        while (pos < info.size) {
          const toRead = Math.min(chunk.length, info.size - pos);
          const { bytesRead } = await handle.read(chunk, 0, toRead, pos);
          if (bytesRead === 0) break;
          pos += bytesRead;

          const slice = chunk.subarray(0, bytesRead);
          const combined =
            carry.length > 0 ? Buffer.concat([carry, slice]) : slice;
          const lastNl = combined.lastIndexOf(0x0a);
          if (lastNl < 0) {
            carry = Buffer.from(combined);
            continue;
          }

          const completeBytes = combined.subarray(0, lastNl + 1);
          this.offset += completeBytes.length;
          const text = completeBytes.toString("utf8");
          let start = 0;
          let nl = text.indexOf("\n");
          while (nl >= 0) {
            this.ingestLine(text.slice(start, nl));
            start = nl + 1;
            nl = text.indexOf("\n", start);
          }

          carry =
            lastNl + 1 < combined.length
              ? Buffer.from(combined.subarray(lastNl + 1))
              : Buffer.alloc(0);
        }
        if(this.offset>0){const length=Math.min(64,this.offset);const prefix=Buffer.alloc(length),tail=Buffer.alloc(length);await Promise.all([handle.read(prefix,0,length,0),handle.read(tail,0,length,this.offset-length)]);this.prefixFence=prefix;this.tailFence=tail;}
      } catch(error) {
        this.source="unavailable";this.readError=error instanceof Error?error.message:String(error);
      } finally {
        await handle?.close();
      }
    }

    return this.snapshot();
  }

  snapshot(): JournalState {
    let openUnknowns = 0;
    for (const head of this.unknowns.values()) {
      if (head.status !== "resolved") openUnknowns += 1;
    }
    return {
      phase: this.hasEnded
        ? "ended"
        : this.hasStarted
          ? "running"
          : "unstarted",
      outcome: this.outcome,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      elapsed_ms: this.elapsedMs,
      journal_bytes: this.journalBytes,
      source: this.source,
      read_error: this.readError,
      malformed_records: this.malformedRecords,
      counts: {
        records: this.records,
        tool_calls: this.toolCalls,
        tool_failures: this.toolFailures,
        evidence: this.evidenceSet.size,
        unknowns: this.unknowns.size,
        open_unknowns: openUnknowns,
        checkpoints: this.checkpointsCount,
      },
      tools: [...this.recentTools],
      evidence_ids: [...this.recentEvidenceIds],
      unknowns: [...this.unknowns.values()],
      checkpoints: [...this.recentCheckpoints],
    };
  }
}
