import { visibleWidth } from "./ansi.js";
import type { I18n, MessageKey } from "./i18n/index.js";
import type { CustomCommandSpec } from "./customCommands.js";
import { OMR_PROFILES } from "./profiles.js";
import { OMR_WORKFLOWS, type OmrWorkflowSpec } from "./prompts.js";

export type CommandKind = "local" | "workflow" | "prompt";

export interface PaletteSubArg {
  readonly id: string;
  readonly description: string;
  readonly usage?: string | undefined;
  readonly badge?: string | undefined;
  readonly badgeKind?: "workflow" | "local" | "arg" | undefined;
  readonly submitOnEnter?: boolean | undefined;
}

export interface CommandRequirements {
  /** Ensure REA MCP connection is established before invoking handler. */
  readonly rea?: boolean | undefined;
  /** Ensure bound target is opened in REA (`ensureTargetOpen()`) before invoking handler. */
  readonly openTarget?: boolean | undefined;
  /** Require an active LLM model client (`!noModel && model !== null`). */
  readonly model?: boolean | undefined;
}

export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly kind: CommandKind;
  readonly argument: "none" | "optional" | "required";
  readonly usage?: string;
  readonly shortcut?: string;
  readonly pathCompletion?: boolean;
  readonly workflowId?: string;
  readonly requires?: CommandRequirements;
  readonly paletteArgs?: readonly PaletteSubArg[];
  readonly source?: "builtin" | "custom";
}

interface WorkflowCommandUiMeta {
  readonly kind?: CommandKind;
  readonly argument: "none" | "optional" | "required";
  readonly usage: string;
  readonly pathCompletion?: boolean;
  readonly requires?: CommandRequirements;
  readonly paletteArgs?: readonly PaletteSubArg[];
}

const SCRIPT_PALETTE_ARGS: readonly PaletteSubArg[] = [
  {
    id: "frida",
    badge: "LANG",
    badgeKind: "workflow",
    usage: "<goal>",
    description: "Frida (.js) instrumentation hook / argument & return logger",
    submitOnEnter: false,
  },
  {
    id: "python",
    badge: "LANG",
    badgeKind: "workflow",
    usage: "<goal>",
    description:
      "Standalone Python 3 (.py) decoder, unpacker, or protocol client",
    submitOnEnter: false,
  },
  {
    id: "gdb",
    badge: "LANG",
    badgeKind: "workflow",
    usage: "<goal>",
    description: "GDB (.gdb) non-interactive breakpoint & register dump script",
    submitOnEnter: false,
  },
  {
    id: "rizin",
    badge: "LANG",
    badgeKind: "workflow",
    usage: "<goal>",
    description: "Rizin (.rz) automated analysis & annotation script",
    submitOnEnter: false,
  },
  {
    id: "yara",
    badge: "LANG",
    badgeKind: "workflow",
    usage: "<goal>",
    description:
      "YARA (.yar) signature rule grounded in unique byte/string Evidence",
    submitOnEnter: false,
  },
];

const ADB_PALETTE_ARGS: readonly PaletteSubArg[] = [
  {
    id: "devices",
    badge: "ADB",
    badgeKind: "local",
    description: "List connected Android ADB devices & emulators (zero tokens)",
    submitOnEnter: true,
  },
  {
    id: "packages",
    badge: "ADB",
    badgeKind: "local",
    description:
      "List installed Android packages on connected device (zero tokens)",
    submitOnEnter: true,
  },
  {
    id: "pull",
    badge: "ADB",
    badgeKind: "local",
    usage: "<package>",
    description: "Pull an installed APK by package name and open it in OMR",
    submitOnEnter: false,
  },
  {
    id: "logcat",
    badge: "ADB",
    badgeKind: "local",
    description:
      "Read recent Android logcat output from connected device (zero tokens)",
    submitOnEnter: true,
  },
];

const BROWSER_PALETTE_ARGS: readonly PaletteSubArg[] = [
  { id: "context", badge: "WEB", badgeKind: "local", description: "Inspect selected tab, last DOM/screenshot and historical browser context", submitOnEnter: true },
  { id: "select", badge: "WEB", badgeKind: "local", usage: "<tabId>", description: "Select an observed tab without taking ownership", submitOnEnter: false },
  {
    id: "status",
    badge: "WEB",
    badgeKind: "local",
    description:
      "Show Camoufox Docker/MCP health, Tor status, proxy routing & installed browsers",
    submitOnEnter: true,
  },
  {
    id: "camofox",
    badge: "WEB",
    badgeKind: "local",
    usage: "[url]",
    description:
      "Use Camoufox anti-detection browser (CAPTCHA / Cloudflare / WAF bypass)",
    submitOnEnter: false,
  },
  {
    id: "chromium",
    badge: "WEB",
    badgeKind: "local",
    usage: "[url] [--gui] [--tor]",
    description:
      "Launch local Chromium with loopback CDP port (for REA web inspection)",
    submitOnEnter: false,
  },
  {
    id: "firefox",
    badge: "WEB",
    badgeKind: "local",
    usage: "[url] [--gui] [--tor]",
    description:
      "Launch local Mozilla Firefox with isolated profile & remote debugging",
    submitOnEnter: false,
  },
  {
    id: "zen",
    badge: "WEB",
    badgeKind: "local",
    usage: "[url] [--gui] [--tor]",
    description:
      "Launch local Zen Browser with isolated profile & remote debugging",
    submitOnEnter: false,
  },
  {
    id: "tor",
    badge: "WEB",
    badgeKind: "local",
    usage: "[on|off]",
    description:
      "Route browser traffic & DNS over Tor SOCKS5h (127.0.0.1:9050 / .onion)",
    submitOnEnter: true,
  },
  {
    id: "proxy",
    badge: "WEB",
    badgeKind: "local",
    usage: "<url|off>",
    description: "Configure HTTP or SOCKS5 proxy for browser sessions",
    submitOnEnter: false,
  },
  {
    id: "tabs",
    badge: "WEB",
    badgeKind: "local",
    description: "List open Camoufox tabs for the active session",
    submitOnEnter: true,
  },
  {
    id: "close",
    badge: "WEB",
    badgeKind: "local",
    usage: "[tabId]",
    description: "Close active local browser or Camoufox tab",
    submitOnEnter: true,
  },
];

const WORKFLOW_COMMAND_UI: Readonly<Record<string, WorkflowCommandUiMeta>> = {
  surface: { argument: "optional", usage: "/surface [focus]" },
  "diff-cve": {
    argument: "required",
    usage: "/diff-cve <left> <right> [focus]",
    pathCompletion: true,
  },
  protocol: { argument: "optional", usage: "/protocol [focus]" },
  crypto: { argument: "optional", usage: "/crypto [focus]" },
  frida: { argument: "required", usage: "/frida <goal>" },
  browser: {
    kind: "local",
    argument: "optional",
    usage:
      "/browser [status|context|select <tabId>|camofox|chromium|firefox|zen|tor|proxy <url>|tabs|close|<url|goal>]",
    requires: {},
    paletteArgs: BROWSER_PALETTE_ARGS,
  },
  ioc: { argument: "optional", usage: "/ioc [focus]" },
  unpack: { argument: "optional", usage: "/unpack [focus]" },
  sandbox: { argument: "optional", usage: "/sandbox [focus]" },
  deobfuscate: { argument: "optional", usage: "/deobfuscate [focus]" },
  sbom: { argument: "optional", usage: "/sbom [focus]" },
  triage: { kind: "prompt", argument: "optional", usage: "/triage [focus]" },
  investigate: { argument: "optional", usage: "/investigate [goal]" },
  explain: {
    kind: "prompt",
    argument: "required",
    usage: "/explain <symbol|addr>",
  },
  trace: { argument: "required", usage: "/trace <symbol|feature>" },
  crash: { argument: "required", usage: "/crash <symptom>" },
  audit: { argument: "optional", usage: "/audit [scope]" },
  compare: {
    argument: "required",
    usage: "/compare <left> <right>",
    pathCompletion: true,
  },
  script: {
    argument: "required",
    usage: "/script <frida|python|gdb|rizin|yara> <goal>",
    paletteArgs: SCRIPT_PALETTE_ARGS,
  },
  adb: {
    kind: "local",
    argument: "optional",
    usage: "/adb [devices|packages|pull <pkg>|logcat|<goal>]",
    requires: { rea: true },
    paletteArgs: ADB_PALETTE_ARGS,
  },
  capa: { argument: "optional", usage: "/capa [focus]" },
  firmware: { argument: "optional", usage: "/firmware [focus]" },
  masvs: { argument: "optional", usage: "/masvs [focus]" },
  forge: {
    kind: "local",
    argument: "optional",
    usage:
      "/forge [list|registry [id]|register <spec.json> <source>|verify <id> <version>|activate <id> <version>|deactivate <id>|remove <id> [version]|run <id> <json>|install <preset|all> [--user]|command <name> <goal>|<goal>]",
    requires: {},
    paletteArgs: [
      {
        id: "list",
        badge: "FORGE",
        badgeKind: "local",
        description:
          "List built-in cyber/RE slash-command blueprints & installed custom commands",
        submitOnEnter: true,
      },
      {
        id: "install all",
        badge: "FORGE",
        badgeKind: "local",
        description:
          "Install all 6 curated cyber/RE slash-command playbooks into .omr/commands/",
        submitOnEnter: true,
      },
      {
        id: "command",
        badge: "FORGE",
        badgeKind: "workflow",
        usage: "<name> <goal>",
        description:
          "Synthesize a target-grounded automation tool and save a reusable /<name> command",
        submitOnEnter: false,
      },
    ],
  },
};

const workflowToCommand = (wf: OmrWorkflowSpec): Command => {
  const ui = WORKFLOW_COMMAND_UI[wf.id];
  return {
    name: wf.id,
    ...(wf.aliases.length > 0 ? { aliases: wf.aliases } : {}),
    description: wf.summary,
    kind: ui?.kind ?? "workflow",
    argument: ui?.argument ?? "optional",
    usage: ui?.usage ?? `/${wf.id} [focus]`,
    ...(ui?.pathCompletion ? { pathCompletion: true } : {}),
    workflowId: wf.id,
    requires: ui?.requires ?? { rea: true, model: true },
    ...(ui?.paletteArgs ? { paletteArgs: ui.paletteArgs } : {}),
    source: "builtin",
  };
};

const PROFILE_PALETTE_ARGS: readonly PaletteSubArg[] = [
  ...OMR_PROFILES.map((p) => ({
    id: p.id,
    badge: "PROF",
    badgeKind: "workflow" as const,
    description: `${p.summary} [effort=${p.effort}]`,
    submitOnEnter: true,
  })),
  {
    id: "off",
    badge: "PROF",
    badgeKind: "local",
    description: "Deactivate active analyst profile",
    submitOnEnter: true,
  },
];

const SPAWN_PALETTE_ARGS: readonly PaletteSubArg[] = OMR_WORKFLOWS.slice(
  0,
  12,
).map((wf) => ({
  id: wf.id,
  badge: "SUB",
  badgeKind: "workflow" as const,
  usage: "<goal>",
  description: `Delegate /${wf.id} sub-investigation: ${wf.summary}`,
  submitOnEnter: false,
}));

const LOCAL_COMMANDS: readonly Command[] = [
  {
    name: "open",
    description: "Open and bind a target binary, APK, bundle or archive",
    kind: "local",
    argument: "required",
    usage: "/open <path>",
    pathCompletion: true,
    requires: {},
    source: "builtin",
  },
  {
    name: "spawn",
    aliases: ["subagent", "delegate"],
    description:
      "Spawn an isolated read-only subagent in foreground or background (--bg) mode inside the Subagent Mesh",
    kind: "workflow",
    argument: "required",
    usage: "/spawn [--bg] [workflow] <goal>",
    requires: { rea: true, model: true },
    paletteArgs: [
      {
        id: "--bg",
        badge: "BG",
        badgeKind: "local",
        usage: "[workflow] <goal>",
        description:
          "Launch subagent asynchronously in the background while continuing your main session",
        submitOnEnter: false,
      },
      ...SPAWN_PALETTE_ARGS,
    ],
    source: "builtin",
  },
  {
    name: "subagents",
    aliases: ["graph", "mesh", "agents-graph"],
    description:
      "Inspect the live Subagent Mesh DAG, step-by-step execution trace, or steer/wait/cancel subagents",
    kind: "local",
    argument: "optional",
    usage:
      "/subagents [graph|inspect <id>|steer <id> <prompt>|wait [id]|cancel <id>]",
    requires: {},
    paletteArgs: [
      {
        id: "graph",
        badge: "DAG",
        badgeKind: "local",
        description:
          "Render the live Subagent Mesh DAG with step-by-step tool calls & Evidence chips",
        submitOnEnter: true,
      },
      {
        id: "inspect",
        badge: "TRACE",
        badgeKind: "arg",
        usage: "<sub-id>",
        description:
          "Inspect detailed step-by-step reasoning, tool calls, steers & outputs for a subagent",
        submitOnEnter: false,
      },
      {
        id: "steer",
        badge: "STEER",
        badgeKind: "arg",
        usage: "<sub-id> <correction_prompt>",
        description:
          "Course-correct a running or finished subagent with a new supervisor directive",
        submitOnEnter: false,
      },
      {
        id: "wait",
        badge: "SYNC",
        badgeKind: "local",
        usage: "[sub-id]",
        description:
          "Await completion of one or all running background subagents",
        submitOnEnter: true,
      },
      {
        id: "cancel",
        badge: "STOP",
        badgeKind: "arg",
        usage: "<sub-id>",
        description: "Abort a running subagent",
        submitOnEnter: false,
      },
    ],
    source: "builtin",
  },
  {
    name: "steer",
    aliases: ["intervene"],
    description:
      "Inject a supervisor course-correction prompt into a running or finished subagent",
    kind: "workflow",
    argument: "required",
    usage: "/steer <sub-id> <correction_prompt>",
    requires: { rea: true, model: true },
    source: "builtin",
  },
  {
    name: "profile",
    aliases: ["lens"],
    description:
      "Activate or inspect a cyber/RE operational profile (recon|malware|vuln|crypto|frida|android|firmware|web|off)",
    kind: "local",
    argument: "optional",
    usage: "/profile [name|off]",
    requires: {},
    paletteArgs: PROFILE_PALETTE_ARGS,
    source: "builtin",
  },
  {
    name: "save",
    aliases: ["save-script"],
    description:
      "Save latest generated script block to <session>/scripts/ or promote a prompt with --as-command <name>",
    kind: "local",
    argument: "optional",
    usage: "/save [filename|--as-command <name>]",
    pathCompletion: true,
    requires: {},
    source: "builtin",
  },
  {
    name: "commands",
    aliases: ["skills"],
    description:
      "List or reload custom markdown slash commands from .omr/commands/*.md & ~/.config/rea/omr/commands/*.md",
    kind: "local",
    argument: "optional",
    usage: "/commands [reload]",
    requires: {},
    paletteArgs: [
      {
        id: "reload",
        badge: "CMD",
        badgeKind: "local",
        description: "Re-scan custom .md command directories from disk",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "jb",
    aliases: ["directive"],
    description:
      "Set, view, or clear a quick operator directive (saved in AGENTS.md's omr block & the active prompt)",
    kind: "local",
    argument: "optional",
    usage: "/jb [directive|show|clear]",
    requires: {},
    paletteArgs: [
      {
        id: "show",
        badge: "DIR",
        badgeKind: "local",
        description:
          "Inspect active operator directives from AGENTS.md and session",
        submitOnEnter: true,
      },
      {
        id: "clear",
        badge: "DIR",
        badgeKind: "local",
        description: "Clear custom operator directives (restores default)",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "agents.md",
    aliases: ["agents"],
    description:
      "Load the project's AGENTS.md (or another instruction file as the default /jb) into the agent",
    kind: "local",
    argument: "optional",
    usage: "/agents.md [path|show|reload|on|off]",
    pathCompletion: true,
    requires: {},
    paletteArgs: [
      {
        id: "show",
        badge: "AGNT",
        badgeKind: "local",
        description: "Print the AGENTS.md instructions the agent is using",
        submitOnEnter: true,
      },
      {
        id: "reload",
        badge: "AGNT",
        badgeKind: "local",
        description:
          "Report the current AGENTS.md state (re-read automatically on every change)",
        submitOnEnter: true,
      },
      {
        id: "off",
        badge: "AGNT",
        badgeKind: "local",
        description: "Stop sending AGENTS.md to the agent for this session",
        submitOnEnter: true,
      },
      {
        id: "on",
        badge: "AGNT",
        badgeKind: "local",
        description: "Send AGENTS.md to the agent again",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "state",
    description: "Read or update persistent task goals, constraints, decisions, acceptance and artifacts",
    kind: "local",
    argument: "optional",
    usage: "/state [get|update <revision> <patch-json>]",
    requires: {},
    source: "builtin",
  },
  {
    name: "recipe",
    description: "Run or inspect versioned analysis recipes with explicit entry/exit criteria and Evidence",
    kind: "local",
    argument: "optional",
    usage: "/recipe [list|run <javascript|browser-javascript> <input-json>|inspect <run-id>]",
    requires: {},
    source: "builtin",
  },
  {
    name: "coverage",
    description: "Inspect measured Evidence progress, verified acceptance conditions and open Unknown coverage",
    kind: "local",
    argument: "optional",
    usage: "/coverage [item-id] [offset=N] [limit=N]",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "resume",
    aliases: ["sessions"],
    description:
      "Open interactive session picker or restore conversation history & target by #index, shortId, or title",
    kind: "local",
    argument: "optional",
    usage: "/resume [#|shortId|id|last|rename <title>]",
    requires: {},
    paletteArgs: [
      {
        id: "list",
        badge: "SESS",
        badgeKind: "local",
        description:
          "Open interactive Session Picker modal to browse & restore saved chats",
        submitOnEnter: true,
      },
      {
        id: "last",
        badge: "SESS",
        badgeKind: "local",
        description:
          "Restore conversation history & target from the most recent saved session",
        submitOnEnter: true,
      },
      {
        id: "rename",
        badge: "SESS",
        badgeKind: "arg",
        usage: "<new_title>",
        description: "Set a custom work title for the active chat session",
        submitOnEnter: false,
      },
    ],
    source: "builtin",
  },
  {
    name: "rename",
    aliases: ["title"],
    description:
      "Rename the active chat session with a custom task/work title (shown in /resume)",
    kind: "local",
    argument: "required",
    usage: "/rename <new_chat_title>",
    requires: {},
    source: "builtin",
  },
  {
    name: "rewind",
    aliases: ["undo"],
    description:
      "Roll back the last N conversation turns cleanly while preserving tool pairing & earlier Evidence",
    kind: "local",
    argument: "optional",
    usage: "/rewind [turns]",
    requires: {},
    paletteArgs: [
      {
        id: "1",
        badge: "TURN",
        badgeKind: "local",
        description: "Undo the most recent user/assistant turn",
        submitOnEnter: true,
      },
      {
        id: "2",
        badge: "TURN",
        badgeKind: "local",
        description: "Undo the last 2 conversation turns",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "fork",
    aliases: ["branch"],
    description:
      "Clone current session history, assets, scripts & directives into an independent branched session",
    kind: "local",
    argument: "optional",
    usage: "/fork [label]",
    requires: {},
    source: "builtin",
  },
  {
    name: "find",
    description:
      "Zero-token deterministic search (APK classes, binary strings & procs)",
    kind: "local",
    argument: "required",
    usage: "/find <query>",
    requires: { rea: true, openTarget: true },
    source: "builtin",
  },
  {
    name: "tools",
    aliases: ["catalog"],
    description:
      "Search the REA MCP catalog or inspect a tool's input schema (schema:<name>) with zero tokens",
    kind: "local",
    argument: "optional",
    usage: "/tools [query|schema:<name>]",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "call",
    description:
      "Invoke any REA MCP tool directly with JSON arguments (zero model tokens)",
    kind: "local",
    argument: "required",
    usage: "/call <tool_name> [json_args]",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "guide",
    description: "Read REA's built-in skill & workflow reference topics locally",
    kind: "local",
    argument: "optional",
    usage: "/guide [topic]",
    requires: {},
    source: "builtin",
  },
  {
    name: "prompts",
    description: "List or render REA's guided MCP prompt templates",
    kind: "local",
    argument: "optional",
    usage: "/prompts [name [k=v …]]",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "model",
    aliases: ["models"],
    description:
      "Open interactive Model & Provider selector, refresh live endpoint models, or switch active model",
    kind: "local",
    argument: "optional",
    usage: "/model [refresh|list [query]|endpoint <url> [key]|[provider:]model]",
    shortcut: "Alt+M",
    requires: {},
    paletteArgs: [
      {
        id: "refresh",
        badge: "MODL",
        badgeKind: "local",
        description:
          "Fetch all live models & capabilities from configured API key & endpoint (/v1/models)",
        submitOnEnter: true,
      },
      {
        id: "list",
        badge: "MODL",
        badgeKind: "local",
        usage: "[search_query]",
        description:
          "List all discovered models & capability tags across connected providers",
        submitOnEnter: true,
      },
      {
        id: "endpoint",
        badge: "MODL",
        badgeKind: "arg",
        usage: "<base_url> [api_key_or_env] [default_model]",
        description:
          "Configure custom OpenAI/Anthropic-compatible endpoint + key and fetch all its models",
        submitOnEnter: false,
      },
    ],
    source: "builtin",
  },
  {
    name: "effort",
    aliases: ["thinking"],
    description:
      "Select thinking effort budget (auto|off|minimal|low|medium|high|xhigh)",
    kind: "local",
    argument: "optional",
    usage: "/effort [level]",
    shortcut: "Alt+E",
    requires: {},
    source: "builtin",
  },
  {
    name: "providers",
    aliases: ["provider"],
    description:
      "Browse all 33+ cloud, router & local LLM providers and auth status",
    kind: "local",
    argument: "optional",
    usage: "/providers [id]",
    requires: {},
    source: "builtin",
  },
  {
    name: "failover",
    aliases: ["fallbacks"],
    description:
      "Configure or inspect automatic multi-provider failover chain (e.g. anthropic:claude-sonnet-4-6,ollama:qwen3-coder)",
    kind: "local",
    argument: "optional",
    usage: "/failover [provider:model,...|off] [--save]",
    requires: {},
    paletteArgs: [
      {
        id: "off",
        badge: "FAIL",
        badgeKind: "local",
        description: "Clear automatic provider failover chain",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "budget",
    aliases: ["cost", "tokens"],
    description:
      "Inspect session token/cost usage or set a maximum token budget cap",
    kind: "local",
    argument: "optional",
    usage: "/budget [<tokens>|off] [--save]",
    requires: {},
    paletteArgs: [
      {
        id: "off",
        badge: "BUDG",
        badgeKind: "local",
        description: "Disable session token budget cap",
        submitOnEnter: true,
      },
      {
        id: "500k",
        badge: "BUDG",
        badgeKind: "local",
        description: "Cap cumulative session token budget at 500,000 tokens",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "net",
    aliases: ["net-guard", "ping"],
    description:
      "Inspect Net Guard status, proxy routing, or run live latency probes against active & fallback endpoints",
    kind: "local",
    argument: "optional",
    usage: "/net [status|probe|interval <ms>|wait <ms>]",
    requires: {},
    paletteArgs: [
      {
        id: "status",
        badge: "NET",
        badgeKind: "local",
        description: "Show Net Guard configuration, proxy routing & failover endpoints",
        submitOnEnter: true,
      },
      {
        id: "probe",
        badge: "NET",
        badgeKind: "local",
        description: "Run live connectivity & latency probes to active and fallback endpoints",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "status",
    description:
      "Target, providers, Evidence/Unknown counters, tokens & journal status",
    kind: "local",
    argument: "none",
    requires: { rea: true, openTarget: true },
    source: "builtin",
  },
  {
    name: "evidence",
    description:
      "Summarize retained Evidence or inspect an evidence_id / prefix / last",
    kind: "local",
    argument: "optional",
    usage: "/evidence [ev_…|last]",
    requires: { rea: true },
    paletteArgs: [
      {
        id: "last",
        badge: "EV",
        badgeKind: "local",
        description:
          "Inspect the most recently recorded Evidence record in full detail",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "unknowns",
    description: "Inspect the residual Unknown ledger",
    kind: "local",
    argument: "none",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "report",
    description:
      "View or export the cumulative forensic session report (Markdown or structured JSON dossier)",
    kind: "local",
    argument: "optional",
    usage: "/report [view|export [path]|json [path]]",
    pathCompletion: true,
    requires: {},
    paletteArgs: [
      {
        id: "view",
        badge: "RPT",
        badgeKind: "local",
        description: "View cumulative session report with Evidence provenance summary",
        submitOnEnter: true,
      },
      {
        id: "export",
        badge: "RPT",
        badgeKind: "local",
        usage: "[path.md]",
        description: "Export standalone Markdown forensic dossier with Evidence & Unknown ledger",
        submitOnEnter: true,
      },
      {
        id: "json",
        badge: "RPT",
        badgeKind: "local",
        usage: "[path.json]",
        description: "Export machine-readable JSON forensic dossier (omr-report/v1)",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "export",
    description: "Export the canonical Evidence bundle JSON to disk",
    kind: "local",
    argument: "optional",
    usage: "/export [path]",
    pathCompletion: true,
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "journal",
    description: "Tail recent S1 session journal records",
    kind: "local",
    argument: "none",
    requires: {},
    source: "builtin",
  },
  {
    name: "doctor",
    description:
      "Verify REA providers, MCP catalog, env sources & model configuration",
    kind: "local",
    argument: "none",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "dashboard",
    description: "Start and display the loopback live session dashboard URL",
    kind: "local",
    argument: "none",
    requires: {},
    source: "builtin",
  },
  {
    name: "binary",
    description:
      "Live binary bitstream mode (on: continuous · eco · busy · off)",
    kind: "local",
    argument: "optional",
    usage: "/binary [on|eco|busy|off]",
    shortcut: "Ctrl+B",
    requires: {},
    source: "builtin",
  },
  {
    name: "image",
    aliases: ["img", "attach"],
    description:
      "Attach an image (file, URL, data URI, or clipboard) to chat, preview in ANSI, or run a vision prompt",
    kind: "local",
    argument: "optional",
    usage: "/image [<path|url|clipboard|list|clear> [prompt...]]",
    shortcut: "Ctrl+V",
    pathCompletion: true,
    requires: {},
    paletteArgs: [
      {
        id: "clipboard",
        badge: "IMG",
        badgeKind: "local",
        usage: "[prompt]",
        description:
          "Grab image from system clipboard (Wayland / X11 / macOS / Windows) and stage for chat",
        submitOnEnter: true,
      },
      {
        id: "list",
        badge: "IMG",
        badgeKind: "local",
        description:
          "List staged image attachments with dimensions, SHA-256 & terminal ANSI preview",
        submitOnEnter: true,
      },
      {
        id: "clear",
        badge: "IMG",
        badgeKind: "local",
        usage: "[#]",
        description: "Remove all staged images (or a specific 1-based # chip)",
        submitOnEnter: true,
      },
    ],
    source: "builtin",
  },
  {
    name: "screenshot",
    aliases: ["shot", "ss", "vision"],
    description:
      "Capture desktop/region/window/ADB/browser screenshot or 2D RGB binary entropy heatmap and attach to chat",
    kind: "local",
    argument: "optional",
    usage:
      "/screenshot [binary|desktop|region|window|adb|browser] [target|prompt...]",
    shortcut: "Alt+S",
    pathCompletion: true,
    requires: {},
    paletteArgs: [
      {
        id: "binary",
        badge: "SHOT",
        badgeKind: "local",
        usage: "[path] [prompt]",
        description:
          "Render 640×360 2D RGB Byte-Class & Sliding-Window Shannon Entropy Heatmap PNG of bound target",
        submitOnEnter: true,
      },
      {
        id: "desktop",
        badge: "SHOT",
        badgeKind: "local",
        usage: "[prompt]",
        description:
          "Capture full desktop screen and stage into chat (spectacle/grim/maim/scrot/screencapture)",
        submitOnEnter: true,
      },
      {
        id: "region",
        badge: "SHOT",
        badgeKind: "local",
        usage: "[prompt]",
        description:
          "Interactive area/region screenshot selection and stage into chat",
        submitOnEnter: true,
      },
      {
        id: "window",
        badge: "SHOT",
        badgeKind: "local",
        usage: "[prompt]",
        description: "Capture active window screenshot and stage into chat",
        submitOnEnter: true,
      },
      {
        id: "adb",
        badge: "SHOT",
        badgeKind: "local",
        usage: "[prompt]",
        description:
          "Capture connected Android device screen via `adb exec-out screencap -p`",
        submitOnEnter: true,
      },
      {
        id: "browser",
        badge: "SHOT",
        badgeKind: "local",
        usage: "[url] [prompt]",
        description:
          "Capture active OMR browser tab or headless Chromium URL screenshot",
        submitOnEnter: false,
      },
    ],
    source: "builtin",
  },
  {
    name: "compact",
    description:
      "Compact context now: soft, remote, snapcompact (bitmap), handoff, or shake",
    kind: "local",
    argument: "optional",
    usage:
      "/compact [--model id] [soft|remote|snapcompact|handoff|shake] [focus]",
    requires: {},
    source: "builtin",
  },
  {
    name: "compaction",
    description:
      "Configure compaction mode (soft|remote|snapcompact|handoff|shake|off), compaction AI model & window",
    kind: "local",
    argument: "optional",
    usage:
      "/compaction [soft|remote|snapcompact|handoff|shake|off] [model=id|active] [75%|auto] [window=1m] [--save]",
    shortcut: "Alt+C",
    requires: {},
    source: "builtin",
  },
  {
    name: "context",
    description: "Show context window usage, threshold and compaction mode",
    kind: "local",
    argument: "none",
    requires: {},
    source: "builtin",
  },
  {
    name: "clear",
    description: "Clear conversation history and return to the OMR hero view",
    kind: "local",
    argument: "none",
    requires: {},
    source: "builtin",
  },
  {
    name: "close",
    description: "Close the active target in REA",
    kind: "local",
    argument: "none",
    requires: { rea: true },
    source: "builtin",
  },
  {
    name: "changelog",
    description: "Show release notes for the installed version, a specific version, or all versions",
    kind: "local",
    argument: "optional",
    usage: "/changelog [version|--all]",
    requires: {},
    source: "builtin",
  },
  {
    name: "lang",
    aliases: ["language"],
    description: "Show or change the saved interface language",
    kind: "local",
    argument: "optional",
    usage: "/lang [en|tr]",
    requires: {},
    source: "builtin",
  },
  {
    name: "help",
    aliases: ["?"],
    description: "Show commands and TUI keyboard shortcuts",
    kind: "local",
    argument: "none",
    requires: {},
    source: "builtin",
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Flush session state and exit omr",
    kind: "local",
    argument: "none",
    shortcut: "Ctrl+D",
    requires: {},
    source: "builtin",
  },
];

export const COMMANDS: readonly Command[] = Object.freeze([
  LOCAL_COMMANDS[0]!, // /open first for discoverability
  ...OMR_WORKFLOWS.map(workflowToCommand),
  ...LOCAL_COMMANDS.slice(1),
]);

export const BUILTIN_COMMAND_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const cmd of COMMANDS) {
    keys.add(cmd.name);
    for (const alias of cmd.aliases ?? []) keys.add(alias);
  }
  return keys;
})();

export const toCustomCommand = (spec: CustomCommandSpec): Command => ({
  name: spec.name,
  ...(spec.aliases.length > 0 ? { aliases: spec.aliases } : {}),
  description: `[${spec.scope}] ${spec.description}`,
  kind: "workflow",
  argument: "optional",
  usage: spec.usage,
  requires: { rea: true, model: true },
  source: "custom",
});

export const mergeCommands = (
  customSpecs: readonly CustomCommandSpec[],
): readonly Command[] =>
  customSpecs.length === 0
    ? COMMANDS
    : [...COMMANDS, ...customSpecs.map(toCustomCommand)];

export const findCommand = (
  rawName: string,
  commands: readonly Command[] = COMMANDS,
): Command | undefined => {
  const lower = rawName.trim().replace(/^\/+/, "").toLowerCase();
  return commands.find(
    (command) =>
      command.name === lower || (command.aliases?.includes(lower) ?? false),
  );
};

type CommandKey = Extract<MessageKey, `command.${string}`>;
type ArgumentKey = Exclude<Extract<MessageKey, `argument.${string}`>, "argument.spawn.delegate">;

const commandDescription = (command: { name: string; description: string; source?: "builtin" | "custom" }, i18n: I18n): string =>
  (command.source !== "custom" && i18n.t(`command.${command.name}` as CommandKey)) || command.description;

export const localizeCommand = <T extends {
  name: string; description: string; source?: "builtin" | "custom"; paletteArgs?: readonly PaletteSubArg[];
}>(command: T, i18n: I18n): T => {
  const paletteArgs = command.paletteArgs?.map((arg) => {
    let description = i18n.t(`argument.${command.name}.${arg.id}` as ArgumentKey);
    if (command.name === "spawn" && arg.id !== "--bg") {
      const subcommand = findCommand(arg.id);
      if (subcommand) {
        description = i18n.t("argument.spawn.delegate", {
          name: subcommand.name, description: commandDescription(subcommand, i18n),
        });
      }
    }
    return { ...arg, description: description || arg.description };
  });
  return {
    ...command, description: commandDescription(command, i18n),
    ...(paletteArgs ? { paletteArgs } : {}),
  };
};

export const helpText = (customSpecs: readonly CustomCommandSpec[], i18n: I18n): string => {
  const { t } = i18n;
  const local = COMMANDS.filter((command) => command.kind === "local");
  const guided = COMMANDS.filter((command) => command.kind !== "local");
  const line = (command: Command): string => {
    const label = command.usage ?? `/${command.name}`;
    return `  ${label}${" ".repeat(Math.max(2, 32 - visibleWidth(label)))}${commandDescription(command, i18n)}`;
  };
  const sections = [
    t("help.workflows"), ...guided.map(line), "",
    t("help.local"), ...local.map(line), "", t("help.shell"),
  ];
  if (customSpecs.length > 0) {
    sections.push("", t("help.custom"), ...customSpecs.map((spec) => line(toCustomCommand(spec))));
  }
  sections.push("", t("help.shortcuts"));
  return sections.join("\n");
};
