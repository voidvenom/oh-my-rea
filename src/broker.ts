import { createHash } from "node:crypto";
import { InvocationNotDispatchedError, UncertainInvocationError, type ExecutionStore } from "./execution.js";
import type { LocalTool } from "./localTools.js";
import type { ReaCallOptions, ReaPort, ReaTool } from "./rea.js";
import { errorMessage } from "./rea.js";
import {
  BROWSER_TOOLS,
  BROWSER_TOOL_NAMES,
  BrowserManager,
} from "./browser.js";
import {
  RUN_DEFAULT_TIMEOUT_SEC,
  RUN_MAX_TIMEOUT_SEC,
  renderRunOutcome,
  runSessionScript,
} from "./exec.js";
import { readGuide, withOperatorPrecedence } from "./guide.js";
import type { ChatImageBlock, ChatMessage, ToolDefinition } from "./model.js";
import {
  captureScreenshot,
  inspectImageForensics,
  loadImageSource,
  type ScreenshotMode,
} from "./vision.js";
import {
  OMR_WORKFLOWS,
  findOmrWorkflow,
  hasAnyTrigger,
  matchWorkflowsForInput,
} from "./prompts.js";
import { asArray, asNumber, asRecord, asString } from "./values.js";

const CORE_SESSION_TOOLS: readonly string[] = [
  "open_binary",
  "close_binary",
  "binary_session",
  "inspect_artifact",
  "get_evidence_bundle",
  "list_unknowns",
  "record_unknown",
  "update_unknown",
  "verify_unknown_resolution",
  "export_evidence_bundle",
];

const ANDROID_TOOLS: readonly string[] = [
  "inspect_android_package",
  "decode_android_resources",
  "search_android_classes",
  "inspect_android_class",
  "inspect_android_method",
  "trace_android_references",
];

const NATIVE_BRIDGE_ESSENTIALS: readonly string[] = [
  "inspect_binary_layout",
  "search_strings",
  "search_procedures",
  "analyze_function",
  "procedure_pseudo_code",
  "xrefs",
];

const NATIVE_CORE_TOOLS: readonly string[] = [
  ...NATIVE_BRIDGE_ESSENTIALS,
  "list_strings",
  "list_procedures",
  "list_names",
  "procedure_callers",
  "procedure_callees",
  "read_bytes",
  "trace_feature",
  "trace_call_path",
  "build_call_path",
  "compare_functions",
  "inspect_native_api",
  "inspect_native_data_type",
  "inspect_native_instruction",
];

const MACHO_APPLE_TOOLS: readonly string[] = [
  "inspect_macho",
  "trace_dylib_resolution",
  "inspect_signature",
];
const MANAGED_TOOLS: readonly string[] = [
  "inspect_managed_artifact",
  "inspect_managed_members",
];
const JS_WEB_TOOLS: readonly string[] = [
  "analyze_javascript_application",
  "inspect_web_page",
  "trace_application_feature",
  "recover_javascript_sources",
  "export_environment_bundle",
  "omr_browser",
  "camofox_create_tab",
  "camofox_snapshot",
  "camofox_evaluate",
];
const BROWSER_STEALTH_TOOLS: readonly string[] = [
  ...BROWSER_TOOL_NAMES,
  "list_browser_targets",
  "inspect_web_page",
  "observe_web_session",
  "capture_browser_scenario",
  "inspect_web_network_capture",
];
const PCAP_TOOLS: readonly string[] = [
  "inspect_pcap_capture",
  "inspect_packet_capture",
  "inspect_packet_fields",
];
const FIRMWARE_EMBEDDED_TOOLS: readonly string[] = [
  "inspect_firmware_regions",
  "extract_firmware",
  "inspect_devicetree",
  "inspect_kernel_module",
  "inspect_byte_entropy",
  "extract_artifact",
];
const GAME_MOBILE_ENGINE_TOOLS: readonly string[] = [
  "inspect_il2cpp_metadata",
  "identify_flutter_build",
  "inspect_dart_aot",
];
const LANGUAGE_RUNTIME_TOOLS: readonly string[] = [
  "inspect_python_pyc",
  "inspect_go_binary",
  "inspect_rust_binary",
  "inspect_erlang_beam",
  "extract_artifact",
];
const WASM_EVM_DB_TOOLS: readonly string[] = [
  "inspect_wasm_artifact",
  "compare_wasm_interfaces",
  "inspect_evm_interface",
  "inspect_sqlite_database",
];
const DYNAMIC_INSTRUMENTATION_TOOLS: readonly string[] = [
  "instrument_with_frida",
  "start_frida_session",
  "load_frida_script",
  "start_gdb_session",
  "gdb_console",
  "start_rizin_debug_session",
  "rizin_debug_command",
  "capture_process_scenario",
];
/** Debugger intents that no workflow owns; they promote the gdb/rizin/process-capture set. */
const DEBUGGER_TRIGGERS: readonly string[] = [
  "gdb",
  "debugger",
  "breakpoint",
  "rizin debug",
];
const ADB_LIVE_TOOLS: readonly string[] = [
  "list_adb_devices",
  "list_adb_packages",
  "pull_adb_package",
  "read_adb_logcat",
  "inspect_adb_package",
];

const UNBOUND_DISCOVERY_TOOLS: readonly string[] = [
  ...NATIVE_BRIDGE_ESSENTIALS,
  "inspect_macho",
  "inspect_android_package",
  "analyze_javascript_application",
  "inspect_managed_artifact",
  "inspect_pcap_capture",
  "inspect_firmware_regions",
  "inspect_byte_entropy",
];

/**
 * Complete superset of curated tools across routes. Route-aware selection narrows
 * active per-step schemas to the bound target format while `rea_tools` + `rea_call`
 * reach all ~250 REA tools at any time.
 */
export const CURATED_TOOLS: readonly string[] = Object.freeze([
  ...new Set([
    ...CORE_SESSION_TOOLS,
    ...ANDROID_TOOLS,
    ...NATIVE_CORE_TOOLS,
    ...MACHO_APPLE_TOOLS,
    ...MANAGED_TOOLS,
    ...JS_WEB_TOOLS,
    ...BROWSER_STEALTH_TOOLS,
    ...PCAP_TOOLS,
    ...FIRMWARE_EMBEDDED_TOOLS,
    ...GAME_MOBILE_ENGINE_TOOLS,
    ...LANGUAGE_RUNTIME_TOOLS,
    ...WASM_EVM_DB_TOOLS,
    ...DYNAMIC_INSTRUMENTATION_TOOLS,
    ...ADB_LIVE_TOOLS,
  ]),
]);

export interface ToolSelectionContext {
  readonly targetPath?: string | null | undefined;
  readonly targetFormat?: string | null | undefined;
}

const DESCRIPTION_LIMIT = 200;
const PROPERTY_DESCRIPTION_LIMIT = 96;
const RESULT_LIMIT = 80_000;
const MAX_STICKY_TOOLS = 18;
const EVIDENCE_ID_RE = /^ev_[0-9a-f]{64}$/;
const EVIDENCE_ID_GLOBAL_RE = /\bev_[0-9a-f]{64}\b/g;

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * Keep the head and tail of an oversized tool result (summaries and trailing
 * `evidence_id` fields usually live at either end) and list every Evidence ID
 * that fell inside the omitted middle so citations never break.
 */
export const truncateToolResult = (
  text: string,
  limit = RESULT_LIMIT,
): string => {
  if (text.length <= limit) return text;
  const headLen = Math.floor(limit * 0.75);
  const tailLen = Math.floor(limit * 0.2);
  const middle = text.slice(headLen, text.length - tailLen);
  const ids = new Set<string>();
  for (const match of middle.matchAll(EVIDENCE_ID_GLOBAL_RE)) {
    ids.add(match[0]);
    if (ids.size >= 64) break;
  }
  const idNote =
    ids.size > 0
      ? `; evidence_ids inside the omitted span: ${[...ids].join(", ")}`
      : "";
  return (
    `${text.slice(0, headLen)}\n… [omr omitted ${middle.length} chars from the middle of this result${idNote}; ` +
    `use get_evidence_bundle or export_evidence_bundle for the full record] …\n${text.slice(text.length - tailLen)}`
  );
};

const searchTokens = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[\s,;:_\-/.]+/)
    .filter((token) => token.length >= 2);

/**
 * Ranked multi-keyword catalog search. Every query token contributes (name tokens
 * weigh most, then the summary line, then the full description), so analyst-style
 * queries like "android manifest permissions" still find the right tools.
 */
export const rankCatalogTools = (
  tools: readonly ReaTool[],
  query: string,
  limit: number,
): ReaTool[] => {
  const phrase = query.trim().toLowerCase();
  const tokens = searchTokens(phrase);
  if (!phrase || tokens.length === 0) return tools.slice(0, limit);
  const scored: Array<{ tool: ReaTool; score: number }> = [];
  for (const tool of tools) {
    const summary = tool.summaryLine.toLowerCase();
    let score = tool.name === phrase.replace(/\s+/g, "_") ? 100 : 0;
    if (tool.name.includes(phrase.replace(/\s+/g, "_"))) score += 30;
    let matched = 0;
    for (const token of tokens) {
      const variants =
        token.length > 3 && token.endsWith("s")
          ? [token, token.slice(0, -1)]
          : [token];
      let best = 0;
      for (const variant of variants) {
        if (tool.nameTokens.includes(variant)) best = Math.max(best, 12);
        else if (tool.name.includes(variant)) best = Math.max(best, 8);
        else if (summary.includes(variant)) best = Math.max(best, 4);
        else if (tool.searchKey.includes(variant)) best = Math.max(best, 2);
      }
      if (best > 0) matched += 1;
      score += best;
    }
    if (matched === 0) continue;
    if (matched === tokens.length) score += 10;
    scored.push({ tool, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
  );
  return scored.slice(0, limit).map((entry) => entry.tool);
};

/** Extract a concise first-sentence description without altering semantics. */
const conciseProse = (raw: string, limit: number): string => {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const dot = normalized.indexOf(". ");
  const candidate =
    dot > 12 && dot <= limit ? normalized.slice(0, dot + 1) : normalized;
  return clip(candidate, limit);
};

/**
 * Non-mutating JSON Schema compactor for direct model exposure.
 * Preserves 100% of structural/validation keywords (`type`, `properties`, `required`,
 * `items`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `additionalProperties`, bounds,
 * `pattern`, `default`, `format`) while stripping root `$schema` and tightening verbose
 * nested prose descriptions. Complete verbatim schemas remain available via `rea_tools`.
 */
export const compactJsonSchema = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => compactJsonSchema(item, depth + 1));

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(src)) {
    if (depth === 0 && key === "$schema") continue;
    if (key === "description" && typeof entry === "string") {
      const short = conciseProse(
        entry,
        depth === 0 ? 150 : PROPERTY_DESCRIPTION_LIMIT,
      );
      if (short) out["description"] = short;
      continue;
    }
    if (
      (key === "properties" || key === "$defs" || key === "definitions") &&
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry)
    ) {
      const propMap: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        entry as Record<string, unknown>,
      )) {
        propMap[propName] = compactJsonSchema(propSchema, depth + 1);
      }
      out[key] = propMap;
      continue;
    }
    if (
      key === "enum" ||
      key === "required" ||
      key === "const" ||
      key === "default" ||
      key === "examples"
    ) {
      out[key] = entry;
      continue;
    }
    out[key] = compactJsonSchema(entry, depth + 1);
  }
  return out;
};

/** Select route-matched direct REA tool names for the active target format. */
export const selectRouteToolNames = (
  context?: ToolSelectionContext,
): readonly string[] => {
  const pathLower = (context?.targetPath ?? "").toLowerCase();
  const fmtLower = (context?.targetFormat ?? "").toLowerCase();

  let route: readonly string[];
  if (!pathLower && !fmtLower) {
    route = UNBOUND_DISCOVERY_TOOLS;
  } else if (
    pathLower.endsWith(".apk") ||
    pathLower.endsWith(".aab") ||
    pathLower.endsWith(".dex") ||
    fmtLower.includes("android") ||
    fmtLower.includes("dalvik")
  ) {
    route = [
      ...ANDROID_TOOLS,
      ...NATIVE_BRIDGE_ESSENTIALS,
      ...GAME_MOBILE_ENGINE_TOOLS,
    ];
  } else if (
    pathLower.includes("il2cpp") ||
    pathLower.endsWith("global-metadata.dat") ||
    pathLower.includes("libapp.so") ||
    pathLower.includes("libflutter.so") ||
    fmtLower.includes("il2cpp") ||
    fmtLower.includes("flutter")
  ) {
    route = [...GAME_MOBILE_ENGINE_TOOLS, ...NATIVE_CORE_TOOLS];
  } else if (
    pathLower.endsWith(".asar") ||
    pathLower.endsWith(".js") ||
    pathLower.endsWith(".mjs") ||
    pathLower.endsWith(".cjs") ||
    fmtLower.includes("directory") ||
    fmtLower.includes("electron")
  ) {
    route = JS_WEB_TOOLS;
  } else if (
    pathLower.endsWith(".pcap") ||
    pathLower.endsWith(".pcapng") ||
    fmtLower.includes("pcap")
  ) {
    route = PCAP_TOOLS;
  } else if (
    pathLower.endsWith(".wasm") ||
    pathLower.endsWith(".evm") ||
    pathLower.endsWith(".sqlite") ||
    pathLower.endsWith(".sqlite3") ||
    pathLower.endsWith(".db") ||
    fmtLower.includes("webassembly") ||
    fmtLower.includes("evm") ||
    fmtLower.includes("sqlite")
  ) {
    route = [...WASM_EVM_DB_TOOLS, ...NATIVE_BRIDGE_ESSENTIALS];
  } else if (
    pathLower.endsWith(".bin") ||
    pathLower.endsWith(".fw") ||
    pathLower.endsWith(".img") ||
    pathLower.endsWith(".rom") ||
    pathLower.endsWith(".dtb") ||
    pathLower.endsWith(".ko") ||
    fmtLower.includes("firmware") ||
    fmtLower.includes("esp32") ||
    fmtLower.includes("devicetree") ||
    fmtLower.includes("kernel")
  ) {
    route = [...FIRMWARE_EMBEDDED_TOOLS, ...NATIVE_CORE_TOOLS];
  } else if (
    pathLower.endsWith(".pyc") ||
    pathLower.endsWith(".beam") ||
    fmtLower.includes("python") ||
    fmtLower.includes("erlang")
  ) {
    route = [...LANGUAGE_RUNTIME_TOOLS, ...NATIVE_BRIDGE_ESSENTIALS];
  } else if (
    pathLower.endsWith(".macho") ||
    pathLower.endsWith(".dylib") ||
    pathLower.endsWith(".ipa") ||
    pathLower.endsWith(".dmg") ||
    pathLower.endsWith(".app") ||
    fmtLower.includes("mach-o") ||
    fmtLower.includes("apple")
  ) {
    route = [...MACHO_APPLE_TOOLS, ...NATIVE_CORE_TOOLS];
  } else if (
    pathLower.endsWith(".dll") ||
    pathLower.endsWith(".exe") ||
    pathLower.endsWith(".jar") ||
    fmtLower.includes("pe/coff") ||
    fmtLower.includes("jvm")
  ) {
    route = [
      ...MANAGED_TOOLS,
      ...NATIVE_CORE_TOOLS,
      "inspect_pe_imports",
      "inspect_pe_resources",
      "inspect_pe_certificates",
      "inspect_pe_load_config",
    ];
  } else {
    route = [
      ...NATIVE_CORE_TOOLS,
      "inspect_byte_entropy",
      "inspect_go_binary",
      "inspect_rust_binary",
      "extract_artifact",
    ];
  }

  return [...new Set([...CORE_SESSION_TOOLS, ...route])];
};

const READ_ONLY_META_TOOLS: ReadonlySet<string> = new Set([
  "rea_tools",
  "rea_guide",
  "rea_prompt",
  "omr_workflow",
  "omr_task",
  "omr_view_image",
]);

/**
 * True only when REA itself declared the call read-only (`readOnlyHint`), so it is safe to run
 * concurrently with sibling calls. REA owns this fact; omr keeps no tool list of its own. Unknown
 * tools and tools without a hint are treated as not read-only and run sequentially.
 */
export const isReadOnlyToolCall = (
  name: string,
  args: Record<string, unknown>,
  readOnlyHint: (toolName: string) => boolean | null | undefined,
): boolean => {
  if (READ_ONLY_META_TOOLS.has(name)) return true;
  const effectiveName = name === "rea_call" ? asString(args["name"]) : name;
  if (!effectiveName || effectiveName === "rea_call") return false;
  return readOnlyHint(effectiveName) === true;
};

const META_TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    type: "function" as const,
    function: {
      name: "rea_tools",
      description:
        "Search the full REA catalog outside your direct tool list. Pass query=<keyword> for matching names & summaries, or schema=<tool-name> for its complete input schema before calling rea_call.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword matched against tool name and description.",
          },
          schema: {
            type: "string",
            description: "Exact tool name; returns its full input schema.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max matches (default 25).",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rea_call",
      description:
        "Invoke any REA tool by exact name with its arguments object. Discover names/schemas with rea_tools first.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact REA tool name." },
          arguments: { type: "object", description: "Tool arguments object." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rea_guide",
      description:
        "Read REA's own skill guidance on demand (routing per artifact type, evidence workflows, runtime observation, recovery). Call without topic for the index, then with a topic id.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Topic id such as ref:runtime-observation or skill:route-the-target-first.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rea_prompt",
      description:
        "Fetch one of REA's guided MCP workflows (investigate_feature, trace_crash, compare_application_versions, …) as step-by-step instructions to follow. Call without name to list them.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Guided prompt name." },
          arguments: {
            type: "object",
            description: "String arguments for the prompt.",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "omr_run",
      description:
        "Run a script in the session scripts directory (.py python3, .sh bash, .mjs/.cjs node, .yar/.yara yara) and get its real stdout, stderr and exit code. Pass code to write the file and run it in one call, or omit code to run a saved script. Use it to test decryptors, parsers, solvers and rules against bytes read with read_bytes before reporting them as working. Runs with a scrubbed environment and, by default, no network. It never executes the target binary.",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "File name inside the session scripts directory.",
          },
          code: {
            type: "string",
            description:
              "Source to write to script (replacing it) before running.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command-line arguments.",
          },
          stdin: {
            type: "string",
            description: "Text piped to the script's stdin.",
          },
          timeout_s: {
            type: "number",
            description: `Wall-clock limit in seconds (default ${RUN_DEFAULT_TIMEOUT_SEC}, max ${RUN_MAX_TIMEOUT_SEC}).`,
          },
          network: {
            type: "boolean",
            description: "Allow host networking (default false).",
          },
        },
        required: ["script"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "omr_workflow",
      description:
        "Autonomously load any of OMR's 20 specialized reverse-engineering & cyber slash-command playbooks (surface, diff-cve, protocol, crypto, frida, browser, ioc, unpack, sandbox, deobfuscate, sbom, triage, investigate, explain, trace, crash, audit, compare, script, adb) even when the user did not type a /command. Call without workflow to list all playbooks.",
      parameters: {
        type: "object",
        properties: {
          workflow: {
            type: "string",
            description:
              "Workflow id or alias (e.g. surface, diff-cve, protocol, crypto, frida, browser, ioc, yara, unpack, sandbox, deobfuscate, sbom, script).",
          },
          focus: {
            type: "string",
            description:
              "Specific goal, symbol, URL, or focus for the workflow.",
          },
          target: {
            type: "string",
            description:
              "Optional target path override (or left_path for compare/diff-cve).",
          },
          secondary_target: {
            type: "string",
            description:
              "Optional second target path (right_path for compare/diff-cve).",
          },
          script_kind: {
            type: "string",
            description:
              "For workflow='script': frida | python | gdb | rizin | yara.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "omr_task",
      description:
        "Orchestrate the OMR Subagent Mesh & DAG: spawn isolated read-only subagents (blocking `mode: 'wait'` or non-blocking `mode: 'background'` so you can continue your own REA work in parallel), inspect their live step-by-step trace (`action: 'inspect'`), course-correct a subagent that is making a mistake or needs to pivot (`action: 'steer'`), view the live DAG (`action: 'status'`), or collect background results (`action: 'wait'`).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["spawn", "status", "graph", "inspect", "steer", "wait", "cancel"],
            description:
              "Operation (default 'spawn'). Use 'inspect' to watch a subagent's live steps, 'steer' to inject a corrective prompt, 'wait' to await background subagents, or 'status'/'graph' for the mesh DAG.",
          },
          mode: {
            type: "string",
            enum: ["wait", "background"],
            description:
              "For 'spawn'/'steer': 'wait' (default) blocks until done; 'background' runs asynchronously while you continue working.",
          },
          agent_id: {
            type: "string",
            description:
              "Target subagent ID (e.g. 'sub-1') for 'inspect', 'steer', 'wait', or 'cancel'.",
          },
          role: {
            type: "string",
            description:
              "Short role title for 'spawn' (e.g. 'aes-key-tracer', 'jni-sink-auditor').",
          },
          goal: {
            type: "string",
            description:
              "Sub-investigation goal for 'spawn', or course-correction directive for 'steer'.",
          },
          prompt: {
            type: "string",
            description:
              "Alias for 'goal' when steering a subagent ('action: steer').",
          },
          workflow: {
            type: "string",
            description:
              "Optional OMR workflow id to preload (e.g. crypto, deobfuscate, surface, ioc, sbom, trace).",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description:
              "Upstream subagent IDs (e.g. ['sub-1']) that must finish before this subagent starts and whose findings feed into it.",
          },
          max_steps: {
            type: "integer",
            minimum: 2,
            maximum: 16,
            description: "Max subagent steps (default 10).",
          },
          timeout_s: {
            type: "number",
            description: "Timeout in seconds for 'action: wait' (default 120).",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "omr_view_image",
      description:
        "Inspect a local image file (.png, .jpg, .webp, .gif, .bmp), http(s) URL, data URI, or clipboard image ('clipboard'). Extracts image forensics (dimensions, SHA-256, PNG tEXt/iTXt chunks, embedded strings) AND attaches the image into the turn so vision models can visually inspect screenshots, UI layouts, malware dialogs, diagrams, or binary heatmaps.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Image file path, http(s):// URL, data:image/... URI, or 'clipboard'.",
          },
          detail: {
            type: "string",
            enum: ["auto", "low", "high", "original"],
            description: "Vision detail level (default 'auto').",
          },
        },
        required: ["source"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "omr_screenshot",
      description:
        "Capture a visual screenshot or binary forensics heatmap and attach it into the vision context: mode='desktop' (full screen), 'region' (interactive selection), 'window' (active window), 'adb' (connected Android device screen), 'browser' (active OMR browser or headless Chromium URL), or 'binary' (2D RGB Byte-Class & Sliding-Window Entropy Heatmap of a binary target).",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["desktop", "region", "window", "adb", "browser", "binary"],
            description:
              "Capture mode (defaults to 'binary' when a target is open, otherwise 'desktop').",
          },
          target: {
            type: "string",
            description:
              "For mode='binary': file path (defaults to current bound binary). For mode='browser': optional URL to capture.",
          },
          device: {
            type: "string",
            description: "For mode='adb': optional Android device serial.",
          },
        },
      },
    },
  },
]);

export interface BrokerOutcome {
  tool: string;
  text: string;
  isError: boolean;
  durationMs: number;
  evidenceIds: string[];
  images?: readonly ChatImageBlock[] | undefined;
  content?: readonly unknown[] | undefined;
  structuredContent?: unknown;
}

export interface ParsedSessionSnapshot {
  readonly open: boolean;
  readonly path: string | null;
  readonly boundProvider: string | null;
  readonly evidenceRecords: number | null;
  readonly unknownHeads: number | null;
}

/** Single owner for extracting session & ledger facts from `binary_session` payloads. */
export const parseSessionSnapshot = (
  payload: unknown,
): ParsedSessionSnapshot | null => {
  const outer = asRecord(payload);
  const record =
    (outer &&
      "normalized_result" in outer &&
      asRecord(outer["normalized_result"])) ||
    (outer && "result" in outer && asRecord(outer["result"])) ||
    outer;
  if (!record || typeof record["open"] !== "boolean") return null;

  const binding = asRecord(record["analysis_provider_binding"]);
  const bindingProvider = asRecord(binding?.["provider"]);
  const boundProvider =
    asString(binding?.["provider_id"]) ||
    asString(binding?.["id"]) ||
    asString(bindingProvider?.["id"]) ||
    null;

  const open = record["open"] === true;
  const path = open ? asString(record["path"]) || null : null;
  const investigation = asRecord(record["investigation"]);
  const evidenceRecords = asNumber(investigation?.["evidence_records"]);
  const unknownHeads = asNumber(investigation?.["unknown_heads"]);

  return { open, path, boundProvider, evidenceRecords, unknownHeads };
};

export type SessionMutationEvent =
  | { readonly kind: "open"; readonly path: string; readonly payload: unknown }
  | { readonly kind: "close" }
  | { readonly kind: "snapshot"; readonly snapshot: ParsedSessionSnapshot }
  | { readonly kind: "reset"; readonly retainedTarget: boolean };

export interface BrokerOptions {
  readonly localTools?: (() => readonly LocalTool[]) | undefined;
  readonly execution?: ExecutionStore | undefined;
  readonly binding?: (() => unknown) | undefined;
  readonly onSessionMutation?: (event: SessionMutationEvent) => void;
  readonly browser?: BrowserManager | undefined;
  readonly currentTarget?: (() => string | null) | undefined;
  /** Session `scripts/` directory used by `omr_run`; `null` when no session is active. */
  readonly scriptsDir?: (() => string | null) | undefined;
  /** Optional isolated subagent orchestrator backing the `omr_task` meta-tool. */
  readonly runSubagent?:
    | ((
        args: Record<string, unknown>,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
      ) => Promise<{
        readonly text: string;
        readonly isError: boolean;
        readonly evidenceIds: readonly string[];
      }>)
    | undefined;
}

/** Pull Evidence IDs out of an unwrapped REA payload or an Evidence record. */
export const evidenceIdsOf = (payload: unknown): string[] => {
  const record = asRecord(payload);
  if (!record) return [];
  const innerResult = asRecord(record["result"]);
  const norm =
    asRecord(record["normalized_result"]) ??
    asRecord(innerResult?.["normalized_result"]);
  const candidates = [
    record["evidence_id"],
    innerResult?.["evidence_id"],
    norm?.["evidence_id"],
    norm?.["parent_evidence_id"],
  ];
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      EVIDENCE_ID_RE.test(candidate) &&
      !ids.includes(candidate)
    ) {
      ids.push(candidate);
    }
  }
  for (const item of asArray(record["records"]).slice(0, 32)) {
    const id = asString(asRecord(item)?.["evidence_id"]);
    if (EVIDENCE_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

/** Format compact, human-readable tool call argument preview for TUI cards. */
export const summarizeToolCall = (
  name: string,
  args: Record<string, unknown>,
): { displayTool: string; summary: string } => {
  let effectiveName = name;
  let effectiveArgs = args;
  if (name === "rea_call") {
    const nestedName = asString(args["name"]);
    if (nestedName) effectiveName = nestedName;
    effectiveArgs = asRecord(args["arguments"]) ?? {};
  }
  const priorityKeys = [
    "workflow",
    "source",
    "mode",
    "goal",
    "focus",
    "url",
    "tabId",
    "engine",
    "action",
    "path",
    "input_path",
    "pattern",
    "query",
    "schema",
    "procedure",
    "address",
    "name",
    "class_name",
    "method_name",
    "expression",
    "selector",
    "ref",
    "proxy",
    "question",
    "unknown_id",
    "evidence_id",
    "detail",
  ];
  const parts: string[] = [];
  for (const key of priorityKeys) {
    if (!(key in effectiveArgs)) continue;
    const raw = effectiveArgs[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw === "string") {
      const compactVal =
        key === "path" || key === "input_path"
          ? (raw.split(/[\\/]/).filter(Boolean).at(-1) ?? raw)
          : raw;
      parts.push(`${key}=${JSON.stringify(clip(compactVal, 34))}`);
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      parts.push(`${key}=${String(raw)}`);
    }
    if (parts.length >= 2) break;
  }
  if (parts.length === 0) {
    for (const [key, raw] of Object.entries(effectiveArgs)) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "string")
        parts.push(`${key}=${JSON.stringify(clip(raw, 26))}`);
      else if (typeof raw === "number" || typeof raw === "boolean")
        parts.push(`${key}=${String(raw)}`);
      else parts.push(key);
      if (parts.length >= 2) break;
    }
  }
  return {
    displayTool:
      name === "rea_call" && effectiveName !== "rea_call"
        ? `rea_call→${effectiveName}`
        : effectiveName,
    summary: parts.join(", "),
  };
};

interface ResolvedCatalogTool {
  readonly backend: "rea" | "browser" | "local";
  readonly canonicalName: string;
  readonly tool: ReaTool;
}

export class ReaBroker {
  private readonly compactedDefs = new Map<string, ToolDefinition>();
  private readonly listCache = new Map<string, ToolDefinition[]>();
  private catalogKey = "";
  private readonly resolved = new Map<string, ResolvedCatalogTool>();
  /** Tools promoted by successful use; recorded immediately. */
  private readonly stickyTools: string[] = [];
  /**
   * Sticky set actually exposed to the model. It only changes at turn boundaries
   * (`beginTurn`) so the tool list — the head of every provider prompt cache —
   * stays byte-identical across the steps of one turn.
   */
  private exposedSticky: readonly string[] = [];
  private fallbackBrowser: BrowserManager | null = null;
  private readonly browserByName: ReadonlyMap<string, ReaTool> = new Map(
    BROWSER_TOOLS.map((tool) => [tool.name, tool]),
  );

  constructor(
    private readonly rea: ReaPort,
    private readonly options: BrokerOptions = {},
  ) {}

  /** Pre-warm sticky tools (e.g. from an active analyst `--profile`). */
  promoteTools(names: Iterable<string>): void {
    for (const name of names) {
      if (this.findCatalogTool(name)) this.rememberTool(name);
    }
    this.exposedSticky = [...this.stickyTools];
  }

  private findCatalogTool(name: string): ReaTool | undefined {
    this.syncCatalog(); return this.resolved.get(name)?.tool;
  }

  private localCatalogTool(name: string, local = this.options.localTools?.() ?? []): ReaTool | undefined {
    const tool=local.find(candidate=>candidate.definition.function.name===name);
    if(!tool)return undefined;
    const fn=tool.definition.function;
    return {name:fn.name,description:fn.description,summaryLine:fn.description.slice(0,150),searchKey:`${fn.name}\n${fn.description}`.toLowerCase(),nameTokens:fn.name.toLowerCase().split(/[_\W]+/),inputSchema:fn.parameters,readOnly:null};
  }

  private checkedLocalTools(): readonly LocalTool[] {
    const local=this.options.localTools?.()??[];
    const reserved=new Set([...this.rea.tools().map(tool=>tool.name),...BROWSER_TOOL_NAMES,...META_TOOLS.map(tool=>tool.function.name)]);
    for(const tool of local){const name=tool.definition.function.name;if(reserved.has(name))throw new Error(`Local tool name collision: ${name}`);reserved.add(name);}
    return local;
  }

  private allCatalogTools(): readonly ReaTool[] {
    this.syncCatalog(); return [...this.resolved.values()].map(item => item.tool);
  }

  private syncCatalog(local = this.checkedLocalTools()): void {
    const native = this.rea.tools();
    const identity = JSON.stringify([this.rea.catalogRevision ?? native, local.map(tool => [tool.backend, tool.definition])]);
    const key = createHash("sha256").update(identity).digest("hex");
    if (key === this.catalogKey) return;
    const metaNames = META_TOOLS.map(tool => tool.function.name);
    const reserved = new Set([...native.map(tool => tool.name), ...BROWSER_TOOL_NAMES, ...metaNames, ...local.map(tool => tool.definition.function.name)]);
    const owned = new Set([...BROWSER_TOOL_NAMES, ...metaNames]);
    const resolved = new Map<string, ResolvedCatalogTool>();
    for (const tool of native) {
      let name = tool.name;
      if (owned.has(name)) {
        name = `rea__${tool.name}`;
        if (name.length > 64 || reserved.has(name)) name = `rea__${tool.name.slice(0,42)}_${createHash("sha256").update(tool.name).digest("hex").slice(0,12)}`;
        if (reserved.has(name)) throw new Error(`Cannot assign an unambiguous REA alias for ${tool.name}`);
        reserved.add(name);
      }
      const exposed = name === tool.name ? tool : { ...tool, name, description: `[REA native ${tool.name}] ${tool.description}`, searchKey: `${name}\n${tool.searchKey}`.toLowerCase(), nameTokens: [...tool.nameTokens, "rea"] };
      resolved.set(name, { backend: "rea", canonicalName: tool.name, tool: exposed });
    }
    for (const tool of BROWSER_TOOLS) resolved.set(tool.name, { backend: "browser", canonicalName: tool.name, tool });
    for (const tool of local) { const catalog = this.localCatalogTool(tool.definition.function.name, local)!; resolved.set(catalog.name, { backend: "local", canonicalName: catalog.name, tool: catalog }); }
    this.resolved.clear(); for (const [name, tool] of resolved) this.resolved.set(name, tool);
    this.catalogKey = key; this.compactedDefs.clear(); this.listCache.clear();
  }

  catalogVersion(): string { this.syncCatalog(); return this.catalogKey; }
  private assertCatalogVersion(expected?: string): void {
    if (expected !== undefined && this.catalogVersion() !== expected) throw new InvocationNotDispatchedError("Tool catalog changed since the model request; inspect the updated schema and retry. No tool was dispatched.");
  }

  private browserManager(): BrowserManager {
    if (this.options.browser) return this.options.browser;
    if (!this.fallbackBrowser) {
      this.fallbackBrowser = new BrowserManager(
        this.rea.sessionDir ?? process.cwd(),
      );
    }
    return this.fallbackBrowser;
  }

  /** Publish tools promoted during the previous turn or matched by the active user intent. */
  beginTurn(userInput?: string): void {
    if (userInput) {
      // One router: workflow triggers decide what to promote. Generic words never do.
      for (const wf of matchWorkflowsForInput(userInput, 2)) {
        for (const toolName of wf.promotedTools) this.rememberTool(toolName);
      }
      if (hasAnyTrigger(userInput, DEBUGGER_TRIGGERS)) {
        for (const toolName of DYNAMIC_INSTRUMENTATION_TOOLS)
          this.rememberTool(toolName);
      }
    }
    this.exposedSticky = [...this.stickyTools];
  }

  private definitionFor(tool: ReaTool): ToolDefinition {
    const cached = this.compactedDefs.get(tool.name);
    if (cached) return cached;
    const compactedParams = asRecord(
      compactJsonSchema(tool.inputSchema, 0),
    ) ?? {
      type: "object",
      properties: {},
    };
    const def: ToolDefinition = {
      type: "function",
      function: {
        name: tool.name,
        description: conciseProse(
          tool.description || tool.name,
          DESCRIPTION_LIMIT,
        ),
        parameters: compactedParams,
      },
    };
    this.compactedDefs.set(tool.name, def);
    return def;
  }

  private resolveSelectedTools(
    context?: ToolSelectionContext,
    includeSticky = true,
    local?: readonly LocalTool[],
  ): ReaTool[] {
    this.syncCatalog(local);
    const wanted = selectRouteToolNames(context);
    const seen = new Set<string>();
    const selected: ReaTool[] = [];
    for (const name of includeSticky
      ? [...wanted, ...this.exposedSticky]
      : wanted) {
      if (seen.has(name)) continue;
      const tool = this.resolved.get(name)?.tool;
      if (!tool) continue;
      seen.add(name);
      selected.push(tool);
    }
    return selected;
  }

  definitions(context?: ToolSelectionContext): ToolDefinition[] {
    const local = this.checkedLocalTools();
    const localNames = new Set(local.map(tool => tool.definition.function.name));
    const selected = this.resolveSelectedTools(context, true, local).filter(tool => !localNames.has(tool.name));
    const key = selected.map((tool) => tool.name).join(",");
    const cached = this.listCache.get(key);
    if (cached) return [...cached, ...local.map(tool => tool.definition)];
    const built = [
      ...selected.map((tool) => this.definitionFor(tool)),
      ...META_TOOLS,
    ];
    if (this.listCache.size > 16) this.listCache.clear();
    this.listCache.set(key, built);
    return [...built, ...local.map(tool => tool.definition)];
  }

  /**
   * Route-only direct tool names for the system prompt. Sticky promotions are
   * excluded so the system prompt changes only when the target route changes.
   */
  directNames(context?: ToolSelectionContext): string[] {
    return [...new Set([...this.resolveSelectedTools(context, false).map(tool => tool.name), ...this.checkedLocalTools().map(tool => tool.definition.function.name)])];
  }

  /** Whether REA or BrowserManager declared this call read-only (see {@link isReadOnlyToolCall}). */
  isReadOnly(name: string, args: Record<string, unknown>): boolean {
    this.syncCatalog();
    const effective=name==="rea_call"?asString(args["name"]):name;
    const local=this.options.localTools?.().find(tool=>tool.definition.function.name===effective);
    if(local)return local.readOnly(name==="rea_call"?(asRecord(args["arguments"])??{}):args);
    return isReadOnlyToolCall(
      name,
      args,
      (toolName) => this.findCatalogTool(toolName)?.readOnly,
    );
  }

  /**
   * Re-promote the REA tools a restored conversation already used (most recent last, bounded by the
   * sticky cap) so a resumed session exposes the same direct tool set instead of re-discovering it.
   */
  restoreSticky(messages: readonly ChatMessage[]): void {
    for (const message of messages) {
      for (const call of message.tool_calls ?? []) {
        let name = call.function.name;
        if (name === "rea_call") {
          try {
            name = asString(
              asRecord(JSON.parse(call.function.arguments || "{}"))?.["name"],
            );
          } catch {
            continue;
          }
        }
        if (name && this.findCatalogTool(name)) this.rememberTool(name);
      }
    }
    this.exposedSticky = [...this.stickyTools];
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
    expectedCatalogVersion?: string,
  ): Promise<BrokerOutcome> {
    try { this.assertCatalogVersion(expectedCatalogVersion); }
    catch (error) { return { tool: name, text: error instanceof Error ? error.message : String(error), isError: true, durationMs: 0, evidenceIds: [] }; }
    const local=this.checkedLocalTools().find(tool=>tool.definition.function.name===name);
    if (this.options.execution && (local || ["omr_run", "omr_view_image", "omr_screenshot"].includes(name))) {
      return this.options.execution.invoke({backend: local?.backend ?? (name === "omr_run" ? "script" : "artifact"), tool: name, args, readOnly: local ? local.readOnly(args) : name === "omr_view_image", binding: this.options.binding?.() ?? null}, () => this.dispatchUnrecorded(name, args, signal, onProgress, expectedCatalogVersion), signal);
    }
    return this.dispatchUnrecorded(name, args, signal, onProgress, expectedCatalogVersion);
  }

  private async dispatchUnrecorded(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
    expectedCatalogVersion?: string,
  ): Promise<BrokerOutcome> {
    const started = performance.now();
    const callOptions: ReaCallOptions = { signal, onProgress };
    let outcome: BrokerOutcome;
    try {
      this.assertCatalogVersion(expectedCatalogVersion);
      const local=this.options.localTools?.().find(tool=>tool.definition.function.name===name);
      outcome =
        local ? await local.invoke(args,signal) : name === "rea_tools"
          ? this.describeCatalog(args)
          : name === "rea_guide"
            ? this.readGuideTopic(args)
            : name === "rea_prompt"
              ? await this.guidedPrompt(args)
              : name === "omr_workflow"
                ? this.runOmrWorkflowTool(args)
                : name === "omr_task"
                  ? await this.runOmrTaskTool(args, signal, onProgress)
                  : name === "omr_view_image"
                    ? await this.runOmrViewImageTool(args)
                    : name === "omr_screenshot"
                      ? await this.runOmrScreenshotTool(args)
                      : name === "omr_run"
                        ? await this.runOmrScript(args, signal)
                        : name === "rea_call"
                          ? await this.callNested(args, callOptions, expectedCatalogVersion)
                          : await this.invoke(name, args, callOptions);
    } catch (error) {
      if (error instanceof UncertainInvocationError) throw error;
      outcome = {
        tool: name,
        text: error instanceof Error ? error.message : String(error),
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    outcome.durationMs = Math.round(performance.now() - started);
    outcome.text = truncateToolResult(outcome.text);
    return outcome;
  }

  private async callNested(
    args: Record<string, unknown>,
    options: ReaCallOptions,
    expectedCatalogVersion?: string,
  ): Promise<BrokerOutcome> {
    const target = asString(args["name"]);
    if (!target) {
      return {
        tool: "rea_call",
        text: "rea_call requires name",
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const nested = asRecord(args["arguments"]) ?? {};
    if(this.options.localTools?.().some(tool=>tool.definition.function.name===target))return this.dispatch(target,nested,options.signal,options.onProgress,expectedCatalogVersion);
    return this.invoke(target, nested, options);
  }

  private rememberTool(name: string): void {
    if (this.stickyTools.includes(name)) return;
    if (this.stickyTools.length >= MAX_STICKY_TOOLS) this.stickyTools.shift();
    this.stickyTools.push(name);
  }

  private readGuideTopic(args: Record<string, unknown>): BrokerOutcome {
    const result = readGuide(asString(args["topic"]));
    return {
      tool: "rea_guide",
      text: result.text,
      isError: !result.ok,
      durationMs: 0,
      evidenceIds: [],
    };
  }

  private async runOmrScript(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<BrokerOutcome> {
    const fail = (text: string): BrokerOutcome => ({
      tool: "omr_run",
      text,
      isError: true,
      durationMs: 0,
      evidenceIds: [],
    });
    const scriptsDir = this.options.scriptsDir?.() ?? null;
    if (!scriptsDir)
      return fail("omr_run needs an active session scripts directory.");
    const rawArgs = asArray(args["args"]);
    const timeout = asNumber(args["timeout_s"]);
    const outcome = await runSessionScript({
      scriptsDir,
      script: asString(args["script"]),
      code: typeof args["code"] === "string" ? args["code"] : undefined,
      args: rawArgs.filter((a): a is string => typeof a === "string"),
      stdin: typeof args["stdin"] === "string" ? args["stdin"] : undefined,
      timeoutSec:
        timeout === null
          ? RUN_DEFAULT_TIMEOUT_SEC
          : Math.min(timeout, RUN_MAX_TIMEOUT_SEC),
      network: args["network"] === true,
      signal,
    });
    if ("error" in outcome) return fail(outcome.error);
    return {
      tool: "omr_run",
      text: renderRunOutcome(outcome),
      isError: !outcome.ok,
      durationMs: outcome.durationMs,
      evidenceIds: [],
    };
  }

  private async runOmrTaskTool(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onProgress: ((message: string) => void) | undefined,
  ): Promise<BrokerOutcome> {
    if (!this.options.runSubagent) {
      return {
        tool: "omr_task",
        text: "omr_task subagent delegation is not enabled in this broker instance.",
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const res = await this.options.runSubagent(args, signal, onProgress);
    return {
      tool: "omr_task",
      text: res.text,
      isError: res.isError,
      durationMs: 0,
      evidenceIds: [...res.evidenceIds],
    };
  }

  private async runOmrViewImageTool(
    args: Record<string, unknown>,
  ): Promise<BrokerOutcome> {
    const source = (asString(args["source"]) || asString(args["path"])).trim();
    if (!source) {
      return {
        tool: "omr_view_image",
        text: "omr_view_image requires a 'source' argument (file path, URL, data URI, or 'clipboard').",
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    let loaded;
    try {
      loaded = await loadImageSource(source, {
        cwd: process.cwd(),
        sessionDir: this.rea.sessionDir ?? null,
      });
    } catch (error) {
      return {
        tool: "omr_view_image",
        text: error instanceof Error ? error.message : String(error),
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const rawDetail = asString(args["detail"]);
    const detail: ChatImageBlock["detail"] =
      rawDetail === "low" ||
      rawDetail === "high" ||
      rawDetail === "original" ||
      rawDetail === "auto"
        ? rawDetail
        : undefined;
    const forensics = inspectImageForensics(
      loaded.bytes,
      loaded.mimeType,
      loaded.sourcePath ?? null,
    );
    const lines = [
      `Loaded image: ${loaded.sourcePath ?? source}`,
      `Format: ${forensics.mimeType} · ${forensics.width && forensics.height ? `${forensics.width}×${forensics.height}px · ` : ""}${forensics.byteLength} bytes`,
      `SHA-256: ${forensics.sha256}`,
    ];
    if (forensics.textChunks.length > 0) {
      lines.push(
        `PNG metadata: ${forensics.textChunks.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(", ")}`,
      );
    }
    if (forensics.printableStrings.length > 0) {
      lines.push(
        `Printable strings: ${forensics.printableStrings.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}`,
      );
    }
    lines.push(
      "[omr: image attached to conversation context for visual inspection]",
    );
    return {
      tool: "omr_view_image",
      text: lines.join("\n"),
      isError: false,
      durationMs: 0,
      evidenceIds: [],
      images: [
        {
          mimeType: forensics.mimeType,
          data: loaded.bytes.toString("base64"),
          ...(detail ? { detail } : {}),
        },
      ],
    };
  }

  private async runOmrScreenshotTool(
    args: Record<string, unknown>,
  ): Promise<BrokerOutcome> {
    const currentTarget = this.options.currentTarget?.() ?? null;
    const rawMode = asString(args["mode"]).trim().toLowerCase();
    const validModes: readonly ScreenshotMode[] = [
      "desktop",
      "region",
      "window",
      "adb",
      "browser",
      "binary",
    ];
    const mode: ScreenshotMode = validModes.includes(rawMode as ScreenshotMode)
      ? (rawMode as ScreenshotMode)
      : currentTarget
        ? "binary"
        : "desktop";
    const targetArg = asString(args["target"]).trim();
    const outputDir = this.rea.sessionDir
      ? `${this.rea.sessionDir}/attachments`
      : process.cwd();
    let result;
    try {
      result = await captureScreenshot({
        mode,
        outputDir,
        targetPath: mode === "binary" ? targetArg || currentTarget : null,
        url: mode === "browser" && targetArg ? targetArg : null,
      });
    } catch (error) {
      return {
        tool: "omr_screenshot",
        text: error instanceof Error ? error.message : String(error),
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    return {
      tool: "omr_screenshot",
      text: `${result.summary}\nSaved at: ${result.path}\n[omr: screenshot attached to conversation context for visual inspection]`,
      isError: false,
      durationMs: 0,
      evidenceIds: [],
      images: [
        {
          mimeType: result.mimeType,
          data: result.bytes.toString("base64"),
        },
      ],
    };
  }

  private runOmrWorkflowTool(args: Record<string, unknown>): BrokerOutcome {
    const rawName = asString(args["workflow"]).trim();
    if (!rawName) {
      const lines = OMR_WORKFLOWS.map((wf) => {
        const aliasTag =
          wf.aliases.length > 0 ? ` (aliases: ${wf.aliases.join(", ")})` : "";
        return `[${wf.category}] /${wf.id}${aliasTag} — ${wf.summary}`;
      });
      return {
        tool: "omr_workflow",
        text: `${OMR_WORKFLOWS.length} OMR cyber & reverse-engineering workflows:\n${lines.join("\n")}\n\nCall omr_workflow with workflow="<id>" and focus="<goal>" to load the full step-by-step playbook and promote its tools.`,
        isError: false,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const wf = findOmrWorkflow(rawName);
    if (!wf) {
      return {
        tool: "omr_workflow",
        text: `Unknown OMR workflow "${rawName}". Available workflows: ${OMR_WORKFLOWS.map((w) => w.id).join(", ")}`,
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    for (const toolName of wf.promotedTools) {
      this.rememberTool(toolName);
    }
    this.exposedSticky = [...this.stickyTools];
    const target =
      asString(args["target"]).trim() || this.options.currentTarget?.() || null;
    const secondaryTarget =
      asString(args["secondary_target"]).trim() || undefined;
    const focus = (asString(args["focus"]) || asString(args["goal"])).trim();
    const scriptKind = asString(args["script_kind"]).trim() || undefined;
    const rendered = wf.buildPrompt({
      target,
      focus,
      secondaryTarget,
      scriptKind,
    });
    return {
      tool: "omr_workflow",
      text: `${rendered}\n\n[omr: promoted tools for /${wf.id}: ${wf.promotedTools.join(", ")}]`,
      isError: false,
      durationMs: 0,
      evidenceIds: [],
    };
  }

  private async guidedPrompt(
    args: Record<string, unknown>,
  ): Promise<BrokerOutcome> {
    const name = asString(args["name"]).trim();
    const prompts = await this.rea.prompts();
    if (!name) {
      const lines = prompts.map((prompt) => {
        const argList = prompt.arguments
          .map((a) => `${a.name}${a.required ? "*" : ""}`)
          .join(", ");
        return `${prompt.name}(${argList}) — ${prompt.description}`;
      });
      return {
        tool: "rea_prompt",
        text: `${prompts.length} guided REA workflows (* = required argument):\n${lines.join("\n")}`,
        isError: false,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    if (!prompts.some((prompt) => prompt.name === name)) {
      return {
        tool: "rea_prompt",
        text: `No guided prompt "${name}". Available: ${prompts.map((p) => p.name).join(", ")}`,
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const rawArgs = asRecord(args["arguments"]) ?? {};
    const stringArgs: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawArgs)) {
      if (typeof value === "string") stringArgs[key] = value;
      else if (typeof value === "number" || typeof value === "boolean")
        stringArgs[key] = String(value);
    }
    const text = await this.rea.getPrompt(name, stringArgs);
    return {
      tool: "rea_prompt",
      text: withOperatorPrecedence(text),
      isError: false,
      durationMs: 0,
      evidenceIds: [],
    };
  }

  private suggestTools(name: string): string {
    const near = rankCatalogTools(
      this.allCatalogTools(),
      name.replace(/_/g, " "),
      4,
    ).map((tool) => tool.name);
    return near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "";
  }

  private async invoke(
    name: string,
    args: Record<string, unknown>,
    options: ReaCallOptions,
  ): Promise<BrokerOutcome> {
    this.syncCatalog(); const resolved = this.resolved.get(name);
    if (resolved?.backend === "browser") {
      const result = await this.browserManager().call(
        name,
        args,
        options.signal,
      );
      if (!result.isError) this.rememberTool(name);
      const screenshot = asString(asRecord(result.payload)?.["saved_screenshot_path"]);
      const images: ChatImageBlock[] = [...(result.images ?? [])];
      let imageNote = "";
      if (!result.isError && screenshot && ["camofox_snapshot", "camofox_screenshot"].includes(name)) {
        try { const loaded = await loadImageSource(screenshot, { cwd: process.cwd(), sessionDir: this.rea.sessionDir ?? null }); images.push({ mimeType: loaded.mimeType, data: loaded.bytes.toString("base64") }); }
        catch (error) { imageNote = `\nScreenshot could not be loaded into model context: ${error instanceof Error ? error.message : String(error)}`; }
      }
      return {
        tool: name,
        text: result.text + imageNote,
        isError: result.isError,
        durationMs: result.durationMs,
        evidenceIds: [],
        structuredContent: result.payload,
        images,
      };
    }
    if (resolved?.backend !== "rea") {
      return {
        tool: name,
        text: `Unknown REA tool: ${name}.${this.suggestTools(name)} Use rea_tools to search the catalog.`,
        isError: true,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const canonicalName = resolved.canonicalName;
    const result = await this.rea.call(canonicalName, args, { ...options, catalogRevision: this.rea.catalogRevision });
    const problem = errorMessage(result.payload);
    const evidenceIds = evidenceIdsOf(result.payload);
    if (result.isError || problem) {
      return {
        tool: name,
        text: problem ?? result.text,
        isError: true,
        durationMs: result.durationMs,
        evidenceIds,
        images: result.images,
        content: result.content,
        structuredContent: result.structuredContent,
      };
    }

    this.rememberTool(name);

    if (canonicalName === "open_binary") {
      const openedPath = asString(args["path"]);
      if (openedPath) {
        this.options.onSessionMutation?.({
          kind: "open",
          path: openedPath,
          payload: result.payload,
        });
      }
    } else if (canonicalName === "close_binary" || canonicalName === "open_bundle_resources") {
      this.options.onSessionMutation?.({ kind: "close" });
    } else if (canonicalName === "binary_session") {
      const snap = parseSessionSnapshot(result.payload);
      if (snap)
        this.options.onSessionMutation?.({ kind: "snapshot", snapshot: snap });
    } else if (canonicalName === "reset_investigation") {
      const inner =
        asRecord(asRecord(result.payload)?.["result"]) ??
        asRecord(result.payload);
      this.options.onSessionMutation?.({
        kind: "reset",
        retainedTarget: inner?.["retained_target"] === true,
      });
    }

    return {
      tool: name,
      text: result.text,
      isError: false,
      durationMs: result.durationMs,
      evidenceIds,
      images: result.images,
      content: result.content,
      structuredContent: result.structuredContent,
    };
  }

  private describeCatalog(args: Record<string, unknown>): BrokerOutcome {
    const schemaName = asString(args["schema"]);
    if (schemaName) {
      const tool = this.findCatalogTool(schemaName);
      if (!tool) {
        return {
          tool: "rea_tools",
          text: `No tool named ${schemaName}.${this.suggestTools(schemaName)}`,
          isError: true,
          durationMs: 0,
          evidenceIds: [],
        };
      }
      // Compact JSON: indentation would add ~30% tokens with no information.
      return {
        tool: "rea_tools",
        text: JSON.stringify({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        isError: false,
        durationMs: 0,
        evidenceIds: [],
      };
    }
    const query = asString(args["query"]).trim();
    const rawLimit = args["limit"];
    const limit =
      typeof rawLimit === "number"
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 25;
    const allTools = this.allCatalogTools();
    const matches = rankCatalogTools(allTools, query, limit).map(
      (tool) => `${tool.name} — ${tool.summaryLine}`,
    );
    return {
      tool: "rea_tools",
      text: `${matches.length} of ${allTools.length} tools${query ? ` matching "${query}" (ranked)` : ""}\n${matches.join("\n")}`,
      isError: false,
      durationMs: 0,
      evidenceIds: [],
    };
  }
}
