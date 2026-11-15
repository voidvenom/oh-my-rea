import type {
  ChatMessage,
  ChatToolCall,
  ModelPort,
  RetryNotice,
  StreamResult,
  ToolDefinition,
  Usage,
} from "../model.js";
import type {
  ReaCallOptions,
  ReaCallResult,
  ReaPort,
  ReaPromptInfo,
  ReaTool,
} from "../rea.js";
import { parseEnvelope } from "../rea.js";

export interface FakeToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly readOnly?: boolean | null;
  readonly inputSchema?: Record<string, unknown>;
}

export const makeFakeReaTool = (spec: FakeToolSpec): ReaTool => {
  const description = spec.description ?? `Fake REA tool ${spec.name}`;
  return {
    name: spec.name,
    description,
    summaryLine: description.slice(0, 150),
    searchKey: `${spec.name}\n${description}`.toLowerCase(),
    nameTokens: spec.name
      .toLowerCase()
      .split(/[_\W]+/)
      .filter(Boolean),
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    readOnly: spec.readOnly === undefined ? true : spec.readOnly,
  };
};

export const createFakeCatalog = (extra: readonly FakeToolSpec[] = []): ReaTool[] => {
  const defaults: FakeToolSpec[] = [
    {
      name: "open_binary",
      description: "Open a binary target into the active REA session.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "close_binary",
      description: "Close the currently open binary session.",
      readOnly: false,
    },
    {
      name: "binary_session",
      description: "Inspect active binary session metadata and Evidence counts.",
      readOnly: true,
    },
    {
      name: "inspect_binary_layout",
      description: "Inspect ELF/PE/Mach-O sections, segments, and mitigations.",
      readOnly: true,
    },
    {
      name: "search_strings",
      description: "Search extracted strings in the open target.",
      readOnly: true,
    },
    {
      name: "search_procedures",
      description: "Search discovered procedures by name pattern.",
      readOnly: true,
    },
    {
      name: "analyze_function",
      description: "Analyze and summarize a procedure with Evidence.",
      readOnly: true,
    },
    {
      name: "procedure_pseudo_code",
      description: "Decompile a procedure to pseudocode.",
      readOnly: true,
    },
    {
      name: "read_bytes",
      description: "Read raw bytes from the open target.",
      readOnly: true,
    },
    {
      name: "get_evidence_bundle",
      description: "Retrieve retained Evidence records from the session.",
      readOnly: true,
    },
    {
      name: "export_evidence_bundle",
      description: "Export portable Evidence bundle to disk.",
      readOnly: false,
    },
    {
      name: "list_unknowns",
      description: "List open residual Unknown records.",
      readOnly: true,
    },
    {
      name: "list_adb_devices",
      description: "List connected Android ADB devices.",
      readOnly: true,
    },
    {
      name: "list_adb_packages",
      description: "List installed packages on an Android device.",
      readOnly: true,
    },
    {
      name: "pull_adb_package",
      description: "Pull an installed APK from an Android device.",
      readOnly: false,
    },
    {
      name: "read_adb_logcat",
      description: "Read recent logcat entries from an Android device.",
      readOnly: true,
    },
  ];
  const byName = new Map<string, ReaTool>();
  for (const item of [...defaults, ...extra]) {
    byName.set(item.name, makeFakeReaTool(item));
  }
  return [...byName.values()];
};

export type FakeToolHandler = (
  args: Record<string, unknown>,
  options?: ReaCallOptions,
) => unknown | Promise<unknown>;

/**
 * Deterministic in-memory `ReaPort` implementation for end-to-end `runOmr` tests without spawning `rea`.
 */
export class FakeRea implements ReaPort {
  private closed = false;
  private openPath: string | null = null;
  private evidenceCounter = 0;
  private readonly catalog: ReaTool[];
  private readonly byName: Map<string, ReaTool>;
  private readonly handlers = new Map<string, FakeToolHandler>();
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    readonly sessionDir: string,
    options: {
      readonly envSources?: readonly string[];
      readonly extraTools?: readonly FakeToolSpec[];
      readonly handlers?: Readonly<Record<string, FakeToolHandler>>;
    } = {},
  ) {
    this.envSources = options.envSources ?? [];
    this.catalog = createFakeCatalog(options.extraTools);
    this.byName = new Map(this.catalog.map((t) => [t.name, t]));
    for (const [name, fn] of Object.entries(options.handlers ?? {})) {
      this.handlers.set(name, fn);
    }
  }

  readonly envSources: readonly string[];

  get isClosed(): boolean {
    return this.closed;
  }

  nextEvidenceId(seed?: number): string {
    const n = seed ?? ++this.evidenceCounter;
    return `ev_${n.toString(16).padStart(64, "0")}`;
  }

  tools(): readonly ReaTool[] {
    return this.catalog;
  }

  find(name: string): ReaTool | undefined {
    return this.byName.get(name);
  }

  diagnostics(): string {
    return "";
  }

  async prompts(): Promise<readonly ReaPromptInfo[]> {
    return [
      {
        name: "investigate_feature",
        description: "Guided feature investigation workflow",
        arguments: [{ name: "goal", required: true, description: "Target goal" }],
      },
    ];
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    return `Guided prompt ${name}: ${JSON.stringify(args)}`;
  }

  onTool(name: string, handler: FakeToolHandler): void {
    this.handlers.set(name, handler);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    options?: ReaCallOptions,
  ): Promise<ReaCallResult> {
    if (this.closed) {
      throw new Error("FakeRea is closed");
    }
    this.calls.push({ name, args });

    const custom = this.handlers.get(name);
    if (custom) {
      const out = await custom(args, options);
      if (
        out &&
        typeof out === "object" &&
        "isError" in out &&
        "text" in out &&
        "payload" in out
      ) {
        return out as ReaCallResult;
      }
      const text = typeof out === "string" ? out : JSON.stringify({ result: out });
      return {
        isError: false,
        text,
        payload: parseEnvelope(text) ?? out,
        durationMs: 1,
      };
    }

    if (name === "open_binary") {
      this.openPath = typeof args["path"] === "string" ? args["path"] : null;
      const ev = this.nextEvidenceId();
      const result = {
        open: true,
        path: this.openPath,
        evidence_id: ev,
        analysis_provider_binding: { provider_id: "rizin" },
        investigation: { evidence_records: this.evidenceCounter, unknown_heads: 0 },
      };
      return {
        isError: false,
        text: JSON.stringify({ result }),
        payload: result,
        durationMs: 1,
      };
    }

    if (name === "close_binary") {
      this.openPath = null;
      const result = { open: false };
      return {
        isError: false,
        text: JSON.stringify({ result }),
        payload: result,
        durationMs: 1,
      };
    }

    if (name === "binary_session") {
      const result = {
        open: this.openPath !== null,
        path: this.openPath,
        analysis_provider_binding: this.openPath
          ? { provider_id: "rizin" }
          : null,
        investigation: { evidence_records: this.evidenceCounter, unknown_heads: 0 },
      };
      return {
        isError: false,
        text: JSON.stringify({ result }),
        payload: result,
        durationMs: 1,
      };
    }

    if (name === "get_evidence_bundle") {
      const result = {total_retained_records:this.evidenceCounter,matching_records:this.evidenceCounter,records:[]};
      return {isError:false,text:JSON.stringify(result),payload:result,durationMs:1};
    }
    if (name === "list_unknowns") {
      const result = {items:[],total:0,next_offset:null};
      return {isError:false,text:JSON.stringify(result),payload:result,durationMs:1};
    }
    const ev = this.nextEvidenceId();
    const result = { tool: name, args, evidence_id: ev };
    return {
      isError: false,
      text: JSON.stringify({ result }),
      payload: result,
      durationMs: 1,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeModelStep {
  readonly content?: string;
  readonly reasoning?: string;
  readonly toolCalls?: ReadonlyArray<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  readonly usage?: Usage;
}

export type FakeModelResponder = (
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  stepIndex: number,
) => FakeModelStep | Promise<FakeModelStep>;

/**
 * Deterministic in-memory `ModelPort` implementation for testing `Agent`, `SubagentRunner`, and `runOmr`.
 */
export class FakeModel implements ModelPort {
  readonly providerId = "fake";
  readonly providerName = "FakeProvider";
  private stepCount = 0;
  readonly requests: Array<{
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }> = [];

  constructor(
    private readonly script: readonly FakeModelStep[] | FakeModelResponder,
    readonly model = "fake-omr-1",
  ) {}

  async stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    _signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    onReasoning?: (delta: string) => void,
    _onRetry?: (notice: RetryNotice) => void,
  ): Promise<StreamResult> {
    const idx = this.stepCount++;
    this.requests.push({
      messages: messages.map((m) => ({ ...m })),
      tools: [...tools],
    });
    const step: FakeModelStep =
      typeof this.script === "function"
        ? await this.script(messages, tools, idx)
        : (this.script[idx] ?? { content: "(end of FakeModel script)" });

    const reasoning = step.reasoning ?? "";
    if (reasoning) onReasoning?.(reasoning);
    const content = step.content ?? "";
    if (content) onText(content);

    const toolCalls: ChatToolCall[] = (step.toolCalls ?? []).map((tc, i) => ({
      id: tc.id ?? `fake_call_${idx}_${i}`,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));

    return {
      content,
      reasoning,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: step.usage ?? {
        prompt_tokens: 120,
        completion_tokens: 40,
        total_tokens: 160,
      },
      reasoningContent: null,
      thinkingBlocks: [],
    };
  }

  async summarize(
    _system: string,
    user: string,
    _maxTokens: number,
    _signal?: AbortSignal,
  ): Promise<string> {
    const evs = [...user.matchAll(/\bev_[0-9a-f]{64}\b/g)].map((m) => m[0]);
    const unique = [...new Set(evs)];
    return `Compacted summary.${unique.length > 0 ? ` Evidence: ${unique.join(", ")}` : ""}`;
  }
}
