import type { Client } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { reaInvocation, resolveReaLauncher } from "./reaLauncher.js";
import { asRecord } from "./values.js";
import { VERSION } from "./version.js";
import type { ChatImageBlock } from "./model.js";
import { InvocationNotDispatchedError } from "./execution.js";
import { resources } from "./resources.js";
import { ownsProcessGroup, sessionLauncher, terminateOwnedProcess } from "./ownedProcess.js";

export class ReaLauncherMissingError extends Error {
  constructor() {
    super("REA launcher not found. Install rea-agents and add its npm bin directory to PATH, or set OMR_REA_COMMAND to a REA executable or Node entry point.");
  }
}

export interface ReaTool {
  name: string;
  description: string;
  summaryLine: string;
  searchKey: string;
  /** Lower-cased name tokens (`inspect_android_package` → inspect, android, package) for ranked search. */
  nameTokens: readonly string[];
  inputSchema: Record<string, unknown>;
  /**
   * REA's own MCP `readOnlyHint` for this tool. `true` means the call cannot mutate the session or
   * execute the target; `false`/`null` (hint absent) must be treated as not safe to run concurrently.
   */
  readOnly: boolean | null;
}

export interface ReaPromptInfo {
  readonly name: string;
  readonly description: string;
  readonly arguments: ReadonlyArray<{
    name: string;
    required: boolean;
    description: string;
  }>;
}

export interface ReaCallResult {
  isError: boolean;
  text: string;
  payload: unknown;
  durationMs: number;
  /** Original MCP blocks, including binary resources and annotations. */
  content?: readonly unknown[] | undefined;
  structuredContent?: unknown;
  images?: readonly ChatImageBlock[] | undefined;
}

export interface ReaCallOptions {
  readonly catalogRevision?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Live REA `notifications/progress` messages (e.g. `decompile: running ghidra`). */
  readonly onProgress?: ((message: string) => void) | undefined;
}

export interface ReaConnectOptions {
  /** Cancels startup (including catalog discovery), closing the owned child. */
  readonly signal?: AbortSignal | undefined;
  /** Inactivity timeout per tool call; REA progress notifications reset it. */
  readonly toolTimeoutMs?: number;
  /** Fired once when the REA child exits without omr asking it to. */
  readonly onLost?: (detail: string) => void;
}

export interface ReaPort {
  readonly sessionDir: string;
  readonly envSources: readonly string[];
  readonly isClosed: boolean;
  readonly processId?: number | null | undefined;
  readonly catalogRevision?: number | undefined;
  refreshTools?(): Promise<void>;
  tools(): readonly ReaTool[];
  find(name: string): ReaTool | undefined;
  diagnostics(): string;
  prompts(): Promise<readonly ReaPromptInfo[]>;
  getPrompt(name: string, args: Record<string, string>): Promise<string>;
  call(
    name: string,
    args: Record<string, unknown>,
    options?: ReaCallOptions,
  ): Promise<ReaCallResult>;
  close(): Promise<void>;
}

/**
 * The MCP SDK aborts any request after 60s by default. Heavy REA work (whole-program
 * graphs, Ghidra decompiles, large APKs) legitimately runs longer, so omr uses an
 * inactivity window that REA progress notifications keep extending.
 */
/** Default inactivity window for a single native tool. Progress resets the window. */
export const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
export const MAX_TOOL_TIMEOUT_MS = 2_147_483_647;
const STDERR_TAIL_BYTES = 8_192;

export const parseEnvelope = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record) return parsed;
    if ("error" in record) return { __error: record["error"] };
    if ("result" in record) return record["result"];
    return parsed;
  } catch {
    return null;
  }
};

export const errorMessage = (payload: unknown): string | null => {
  const envelope = asRecord(payload);
  if (!envelope || !("__error" in envelope)) return null;
  const error = envelope["__error"];
  const record = asRecord(error);
  if (!record) return String(error);
  const message =
    typeof record["message"] === "string" ? record["message"] : null;
  const remediation = asRecord(record["remediation"]);
  const action =
    typeof remediation?.["action"] === "string" ? remediation["action"] : null;
  const code = typeof record["code"] === "string" ? record["code"] : null;
  return (
    [code, message, action]
      .filter((part): part is string => Boolean(part))
      .join(" — ") || "REA error"
  );
};

/** MCP result data and model presentation are separate: raw binary blocks remain available. */
export const normalizeMcpResult = (raw: unknown, durationMs = 0): ReaCallResult => {
  const result = asRecord(raw);
  const content: readonly unknown[] = Array.isArray(result?.["content"]) ? result["content"] : [];
  const texts: string[] = [];
  const rendered: string[] = [];
  const images: ChatImageBlock[] = [];
  for (const block of content) {
    const part = asRecord(block);
    if (!part) continue;
    const type = part["type"];
    if (type === "text" && typeof part["text"] === "string") {
      texts.push(part["text"]);
      rendered.push(part["text"]);
    } else if (type === "image" && typeof part["mimeType"] === "string" && typeof part["data"] === "string") {
      images.push({ mimeType: part["mimeType"], data: part["data"] });
      rendered.push(`[image: ${part["mimeType"]}]`);
    } else if (type === "resource_link") {
      rendered.push(`[resource link: ${String(part["name"] ?? "resource")} — ${String(part["uri"] ?? "")}]`);
    } else if (type === "resource") {
      const resource = asRecord(part["resource"]);
      rendered.push(`[resource: ${String(resource?.["uri"] ?? "")} (${String(resource?.["mimeType"] ?? "unknown")})]`);
      if (typeof resource?.["text"] === "string") rendered.push(resource["text"]);
      if (typeof resource?.["mimeType"] === "string" && resource["mimeType"].startsWith("image/") && typeof resource["blob"] === "string") {
        images.push({ mimeType: resource["mimeType"], data: resource["blob"] });
      }
    } else {
      rendered.push(`[MCP ${String(type ?? "unknown")} content: ${String(part["mimeType"] ?? "binary")}]`);
    }
  }
  const structured = asRecord(result?.["structuredContent"]);
  const plain = texts.join("\n");
  const payload = structured ? parseEnvelope(JSON.stringify(structured)) : parseEnvelope(plain);
  if (structured && JSON.stringify(parseEnvelope(plain)) !== JSON.stringify(payload)) {
    rendered.push(JSON.stringify(structured));
  }
  return {
    text: rendered.join("\n"), payload, content, images, durationMs,
    isError: result?.["isError"] === true || errorMessage(payload) !== null,
    ...(structured ? { structuredContent: structured } : {}),
  };
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const toolOf = (tool: {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean | undefined } | undefined;
}): ReaTool => {
  const description = tool.description ?? "";
  const firstNl = description.indexOf("\n");
  const firstLine = firstNl >= 0 ? description.slice(0, firstNl) : description;
  const summaryLine =
    firstLine.length <= 150 ? firstLine : `${firstLine.slice(0, 149)}…`;
  return {
    name: tool.name,
    description,
    summaryLine,
    searchKey: `${tool.name}\n${description}`.toLowerCase(),
    nameTokens: tool.name
      .toLowerCase()
      .split(/[_\W]+/)
      .filter(Boolean),
    inputSchema: asRecord(tool.inputSchema) ?? {
      type: "object",
      properties: {},
    },
    readOnly:
      typeof tool.annotations?.readOnlyHint === "boolean"
        ? tool.annotations.readOnlyHint
        : null,
  };
};

const catalogOf = (tools: Parameters<typeof toolOf>[0][]): ReaTool[] => {
  const catalog = tools.map(toolOf);
  if (new Set(catalog.map(tool => tool.name)).size !== catalog.length) throw new Error("MCP catalog contains duplicate tool names");
  return catalog;
};

export class Rea implements ReaPort {
  private closed = false;
  private promptCache: readonly ReaPromptInfo[] | null = null;
  private byName: ReadonlyMap<string, ReaTool>;
  private revision = 1;
  private catalogGeneration = 0;
  private catalogReady = true;
  private catalogError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly lifetime = new AbortController();
  private promptGeneration = 0;
  private loadingPrompts: Promise<readonly ReaPromptInfo[]> | null = null;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    private catalog: ReaTool[],
    private readonly toolTimeoutMs: number,
    private readonly stderrTail: () => string,
    readonly sessionDir: string,
    readonly envSources: string[],
    private readonly releaseProcessResources: () => Promise<void>,
  ) {
    this.byName = new Map(catalog.map((tool) => [tool.name, tool]));
  }

  static async connect(
    sessionDir: string,
    env: NodeJS.ProcessEnv,
    envSources: string[],
    options: ReaConnectOptions = {},
  ): Promise<Rea> {
    const release = await resources.acquire("mcpProcess", options.signal);
    try { return await Rea.connectAdmitted(sessionDir, env, envSources, options, release); }
    catch (error) { release(); throw error; }
  }

  private static async connectAdmitted(sessionDir: string, env: NodeJS.ProcessEnv, envSources: string[], options: ReaConnectOptions, release: () => void): Promise<Rea> {
    options.signal?.throwIfAborted();
    mkdirSync(join(sessionDir, "checkpoints"), {
      recursive: true,
      mode: 0o700,
    });
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") childEnv[key] = value;
    }
    childEnv["REA_SESSION_DIR"] = sessionDir;
    const [{ Client }, { StdioClientTransport }, { AjvJsonSchemaValidator }, { createLazyValidatorProvider }] = await Promise.all([
      import("@modelcontextprotocol/client"),
      import("@modelcontextprotocol/client/stdio"),
      import("@modelcontextprotocol/client/validators/ajv"),
      import("./lazyValidator.js"),
    ]);
    const resolved = resolveReaLauncher(childEnv);
    if (!resolved) throw new ReaLauncherMissingError();
    const invocation = reaInvocation(resolved.path, ["mcp"]);
    if (!invocation) throw new Error(`Cannot start REA from ${resolved.path}. On Windows, use the npm-installed rea-agents shim, a native .exe, or set OMR_REA_COMMAND to scripts/rea.mjs.`);
    // stderr is piped (never inherited) so REA diagnostics cannot corrupt the TUI's
    // alternate screen; a bounded tail is retained to explain unexpected exits.
    const { command, args } = invocation;
    const launcher = sessionLauncher();
    const transport = new StdioClientTransport({ command: launcher ?? command, args: launcher ? ["--", command, ...args] : args, env: childEnv, stderr: "pipe" });
    let ownedPid: number | null = null, ownedGroup = false, releasing: Promise<void> | null = null;
    const captureProcess = (): void => { if (!ownedPid && transport.pid) { ownedPid = transport.pid; ownedGroup = Boolean(launcher && ownsProcessGroup(ownedPid)); } };
    const releaseOwned = (): Promise<void> => {
      captureProcess();
      return releasing ??= (async () => { try { await terminateOwnedProcess(ownedPid, ownedGroup); } finally { release(); } })();
    };

    let tail = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    const stderrTail = (): string => tail.trim();

    let rea: Rea | null = null;
    let earlyCatalogChange = false;
    const client = new Client({ name: "omr", version: VERSION }, { jsonSchemaValidator: createLazyValidatorProvider(new AjvJsonSchemaValidator()), listChanged: {
      tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
        if (rea) rea.invalidateCatalog(); else earlyCatalogChange = true;
      } },
      prompts: { autoRefresh: false, debounceMs: 0, onChanged: () => {
        if (rea) { rea.promptCache = null; rea.promptGeneration++; }
      } },
    } });
    const abortStartup = (): void => {
      void releaseOwned().catch(() => {});
      void client.close().catch(() => {});
      void transport.close().catch(() => {});
    };
    options.signal?.addEventListener("abort", abortStartup, { once: true });
    let catalog: ReaTool[];
    try {
      options.signal?.throwIfAborted();
      await client.connect(transport);
      captureProcess();
      options.signal?.throwIfAborted();
      const listed = await client.listTools();
      options.signal?.throwIfAborted();
      catalog = catalogOf(listed.tools);
    } catch (error) {
      await releaseOwned().catch(() => {});
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      options.signal?.throwIfAborted();
      const detail = stderrTail();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        detail
          ? `${message}\n${detail.split("\n").slice(-6).join("\n")}`
          : message,
      );
    } finally {
      options.signal?.removeEventListener("abort", abortStartup);
    }
    rea = new Rea(
      client,
      transport,
      catalog,
      options.toolTimeoutMs === 0 ? MAX_TOOL_TIMEOUT_MS : Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(1_000, options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)),
      stderrTail,
      sessionDir,
      envSources,
      releaseOwned,
    );
    const connected = rea;
    client.onclose = () => {
      if (connected.closed) return;
      connected.closed = true; connected.lifetime.abort();
      void releaseOwned().catch(() => {});
      const last = stderrTail().split("\n").slice(-4).join("\n");
      options.onLost?.(
        last
          ? `REA process exited unexpectedly:\n${last}`
          : "REA process exited unexpectedly",
      );
    };
    if (earlyCatalogChange) {
      connected.invalidateCatalog();
      try { await connected.refreshTools(); } catch (error) { await connected.close(); throw error; }
    }
    return rea;
  }

  private invalidateCatalog(): void {
    if (this.closed) return;
    this.catalogGeneration++; this.catalogReady = false;
    void this.refreshTools().catch(() => {});
  }

  /** Atomic, single-flight replacement. A failed/unfinished refresh never serves stale schemas. */
  refreshTools(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.catalogReady = false;
    this.refreshing = (async () => {
      while (true) {
        if (this.closed) throw new Error("REA is closed");
        const generation = this.catalogGeneration;
        const listed = await this.client.listTools(undefined, { cacheMode: "refresh", timeout: 30_000, signal: this.lifetime.signal });
        const catalog = catalogOf(listed.tools);
        if (generation !== this.catalogGeneration) continue;
        this.catalog = catalog; this.byName = new Map(catalog.map(tool => [tool.name, tool]));
        this.revision++; this.catalogReady = true; this.catalogError = null;
        return;
      }
    })().catch(error => { this.catalogError = error instanceof Error ? error.message : String(error); throw error; })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  get catalogRevision(): number { return this.revision; }
  private assertCatalogReady(): void {
    if (!this.catalogReady) throw new Error(this.catalogError ? `MCP catalog refresh failed: ${this.catalogError}. Retry /tools reload.` : "MCP tool catalog is refreshing; retry after refresh completes.");
  }

  /** REA guided MCP prompts, invalidated by advertised list_changed notifications. */
  async prompts(): Promise<readonly ReaPromptInfo[]> {
    if (this.promptCache) return this.promptCache;
    if (this.loadingPrompts) return this.loadingPrompts;
    this.loadingPrompts = (async () => {
      while (true) {
        const generation = this.promptGeneration;
        const listed = await this.client.listPrompts(undefined, { cacheMode: "refresh" });
        if (generation !== this.promptGeneration) continue;
        this.promptCache = listed.prompts.map(prompt => ({ name: prompt.name, description: prompt.description ?? "", arguments: (prompt.arguments ?? []).map(arg => ({ name: arg.name, required: arg.required === true, description: arg.description ?? "" })) }));
        return this.promptCache;
      }
    })().finally(() => { this.loadingPrompts = null; });
    return this.loadingPrompts;
  }

  /** Render one guided MCP prompt to its instruction text. */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = await this.client.getPrompt({ name, arguments: args });
    const parts: string[] = [];
    for (const message of result.messages) {
      const content = asRecord(message.content);
      if (content?.["type"] === "text" && typeof content["text"] === "string")
        parts.push(content["text"]);
    }
    return parts.join("\n\n");
  }

  /** True once the child exited or was closed; a lost connection must be replaced, not reused. */
  get isClosed(): boolean {
    return this.closed;
  }
  get processId(): number | null { return this.closed ? null : this.transport.pid ?? null; }

  tools(): readonly ReaTool[] {
    this.assertCatalogReady();
    return this.catalog;
  }

  find(name: string): ReaTool | undefined {
    this.assertCatalogReady();
    return this.byName.get(name);
  }

  /** Recent REA stderr output (bounded), for diagnostics only. */
  diagnostics(): string {
    return [this.stderrTail(), this.catalogError ? `catalog refresh: ${this.catalogError}` : ""].filter(Boolean).join("\n");
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    options: ReaCallOptions = {},
  ): Promise<ReaCallResult> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    let release: () => void;
    try { release = await resources.acquire("rea", signal); }
    catch (error) { throw new InvocationNotDispatchedError(`REA admission failed before dispatch: ${error instanceof Error ? error.message : String(error)}`); }
    try {
    if (this.closed)
      throw new InvocationNotDispatchedError(
        "REA is not running (the MCP child exited); retry to restart it",
      );
    try { this.assertCatalogReady(); }
    catch (error) { throw new InvocationNotDispatchedError(error instanceof Error ? error.message : String(error)); }
    if (options.catalogRevision !== undefined && options.catalogRevision !== this.revision) throw new InvocationNotDispatchedError("MCP catalog changed before dispatch; inspect the updated schema and retry.");
    const started = performance.now();
    const onProgress = options.onProgress;
    const result = await this.client.callTool(
      { name, arguments: args },
      {
        signal,
        timeout: this.toolTimeoutMs,
        resetTimeoutOnProgress: true,
        onprogress: (progress: { message?: string | undefined }) => {
          if (progress.message) onProgress?.(progress.message);
        },
      },
    );
    return normalizeMcpResult(result, Math.round(performance.now() - started));
    } finally { release(); }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.lifetime.abort();
      try { await this.releaseProcessResources(); }
      finally { await this.client.close().catch(() => {}); await this.transport.close().catch(() => {}); }
    })();
  }
}
