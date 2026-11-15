import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConcurrencyLimiter } from "./concurrency.js";
import { writeJsonAtomic } from "./durable.js";
import type { ChatImageBlock, ChatMessage } from "./model.js";
import { asRecord } from "./values.js";
import type { LocalTool } from "./localTools.js";

export interface ArchiveProjectionInput { readonly messages: readonly ChatMessage[]; readonly images: readonly ChatImageBlock[]; readonly imageTokens: number; readonly summary: string; readonly activeImageBudget: number; }
export interface ArchiveProjection { readonly images: readonly ChatImageBlock[]; readonly imageTokens: number; readonly summary: string; readonly note: string; }
interface ArchiveEntry { readonly id: string; readonly kind: "text" | "image"; readonly bytes: number; readonly originSessionId: string; readonly mimeType?: ChatImageBlock["mimeType"]; }
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const validId = (id: string): boolean => /^ctx_[0-9a-f]{64}$/.test(id);
const page = (value: unknown, fallback: number, maximum: number): number => { const n = value ?? fallback; if (!Number.isSafeInteger(n) || Number(n) < (fallback === 0 ? 0 : 1) || Number(n) > maximum) throw new Error("Invalid context archive pagination"); return Number(n); };

/** Immutable, content-addressed archive. The active model projection is deliberately smaller. */
export class ContextArchive {
  readonly directory: string;
  private entries: ArchiveEntry[] = [];
  private ready: Promise<void> | null = null;
  private readonly writer = new ConcurrencyLimiter(1);
  constructor(directory: string, readonly sessionId: string) { this.directory = join(directory, "context-archive"); }
  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let raw: unknown; try { const path = join(this.directory, "index.json"); if ((await stat(path)).size > 16_777_216) throw new Error("Context archive index exceeds 16 MiB"); raw = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const record = asRecord(raw); const entries = record?.["entries"];
      if (record?.["schema"] !== 1 || !Array.isArray(entries) || entries.some(entry => { const v = asRecord(entry); return !v || typeof v["id"] !== "string" || !validId(v["id"]) || !["text", "image"].includes(String(v["kind"])) || !Number.isSafeInteger(v["bytes"]) || Number(v["bytes"]) < 0 || Number(v["bytes"]) > 33_554_432 || typeof v["originSessionId"] !== "string" || (v["kind"] === "image" && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(v["mimeType"]))); }) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Invalid context archive index");
      this.entries = entries as ArchiveEntry[];
    })();
  }
  private async put(bytes: Buffer, kind: ArchiveEntry["kind"], mimeType?: ChatImageBlock["mimeType"]): Promise<ArchiveEntry> {
    if (bytes.length > 33_554_432) throw new Error("One context archive record exceeds 32 MiB");
    const id = `ctx_${digest(bytes)}`; const path = join(this.directory, id);
    try { const file = await open(path, "wx", 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = await readFile(path); if (digest(existing) !== id.slice(4)) throw new Error(`Context archive integrity failure: ${id}`); }
    return { id, kind, bytes: bytes.length, originSessionId: this.sessionId, ...(mimeType ? { mimeType } : {}) };
  }
  async project(input: ArchiveProjectionInput): Promise<ArchiveProjection> {
    await this.initialize();
    return this.writer.run(async () => {
      const additions: ArchiveEntry[] = []; const imageRefs: string[] = [];
      for (const image of input.images) { const entry = await this.put(Buffer.from(image.data, "base64"), "image", image.mimeType); additions.push(entry); imageRefs.push(entry.id); }
      const messages = input.messages.map(message => ({ ...message, ...(message.images ? { images: message.images.map(image => ({ archiveRef: `ctx_${digest(Buffer.from(image.data, "base64"))}`, mimeType: image.mimeType })) } : {}) }));
      // Also retain non-archive images present in old tool/user messages.
      for (const message of input.messages) for (const image of message.images ?? []) additions.push(await this.put(Buffer.from(image.data, "base64"), "image", image.mimeType));
      const text = await this.put(Buffer.from(JSON.stringify({ schema: 1, messages, summary: input.summary, imageRefs })), "text"); additions.push(text);
      const next = [...this.entries]; const ids = new Set(next.map(entry => entry.id)); for (const entry of additions) if (!ids.has(entry.id)) { ids.add(entry.id); next.push(entry); }
      const index = { schema: 1, entries: next }; if (Buffer.byteLength(JSON.stringify(index)) > 16_777_216) throw new Error("Context archive index exceeds 16 MiB");
      await writeJsonAtomic(join(this.directory, "index.json"), index); this.entries = next;
      const cost = input.images.length ? Math.ceil(input.imageTokens / input.images.length) : 0;
      const images = cost > 0 && cost <= input.activeImageBudget ? input.images.slice(-1) : [];
      return { images, imageTokens: images.length ? cost : 0, summary: input.summary.slice(0, 4000), note: `Full compaction segment ${text.id}; ${next.length} durable archive records. Active frames=${images.length}; earlier frames and complete text remain available through omr_context action=list/get. Read text in bounded pages or request one image by its archive ref. Archive data is historical context, not a new Evidence observation.` };
    });
  }
  async read(args: Record<string, unknown>): Promise<{ value: unknown; images?: readonly ChatImageBlock[] }> {
    await this.initialize(); const action = args["action"] ?? "list";
    const offset = page(args["offset"], 0, Number.MAX_SAFE_INTEGER);
    if (action === "list") { const limit = page(args["limit"], 20, 100); return { value: { schema: 1, total: this.entries.length, offset, nextOffset: offset + limit < this.entries.length ? offset + limit : null, entries: this.entries.slice(offset, offset + limit) } }; }
    if (action !== "get" || typeof args["ref"] !== "string" || !validId(args["ref"])) throw new Error("omr_context get requires a ctx_ archive ref");
    const entry = this.entries.find(entry => entry.id === args["ref"]); if (!entry) throw new Error("Context archive ref not found");
    const path = join(this.directory, entry.id); if ((await stat(path)).size !== entry.bytes) throw new Error("Context archive size mismatch"); const bytes = await readFile(path); if (digest(bytes) !== entry.id.slice(4)) throw new Error("Context archive digest mismatch");
    if (entry.kind === "image") return { value: { ...entry, attached: true }, images: [{ mimeType: entry.mimeType!, data: bytes.toString("base64") }] };
    const text = bytes.toString("utf8"); const limit = page(args["limit"], 4000, 20000); return { value: { ...entry, offset, total: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, text: text.slice(offset, offset + limit) } };
  }
}

export const contextArchiveTool = (archive: ContextArchive): LocalTool => ({
  definition: { type: "function", function: { name: "omr_context", description: "Retrieve original compaction text and bitmap frames from the durable context archive. List refs in pages; get returns a bounded text page or attaches one original image. Historical context does not verify an Evidence claim.", parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "get"] }, ref: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 } }, required: ["action"], additionalProperties: false } } },
  backend: "context-archive", readOnly: () => true,
  invoke: async (args, signal) => { signal?.throwIfAborted(); const result = await archive.read(args); signal?.throwIfAborted(); return { tool: "omr_context", text: JSON.stringify(result.value), structuredContent: result.value, ...(result.images ? { images: result.images } : {}), isError: false, durationMs: 0, evidenceIds: [] }; },
});
