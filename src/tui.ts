import { StringDecoder } from "node:string_decoder";
import {
  ESC,
  SYNC_END,
  SYNC_START,
  centerAnsi,
  codePointWidth,
  createTheme,
  highlightVisualCols,
  padEndAnsi,
  renderMarkdown,
  sanitizeText,
  slicePlainByVisualCols,
  stripAnsi,
  styleInlineMarkdown,
  styleVisualSpans,
  truncateAnsi,
  visibleWidth,
  wrapPlain,
  type ColorTheme,
} from "./ansi.js";
import {
  formatBytes,
  renderBinaryPulse,
  renderHeroLines,
  renderHudBinaryStrip,
  type TargetMagic,
} from "./binaryArt.js";
import { summarizeToolCall } from "./broker.js";
import { normalizeTypedAhead, takeEarlyInput } from "./earlyInput.js";
import { I18n, type LocalizedMessage, type MessageKey } from "./i18n/index.js";
import { ledgerHealthLabel } from "./render.js";
import type { UpdateInfo } from "./setup.js";
import { linkAt, linkSpansForLines, type LinkSpan } from "./links.js";
import {
  ClickCounter,
  lineRange,
  selectionRowSpans,
  wordRangeAt,
  type RowSpan,
  type SelectionRegion,
} from "./selection.js";
import {
  copyTextToClipboard,
  isKlipperImagePlaceholder,
  readImageFromClipboard,
  readTextFromClipboard,
  toChatImageBlock,
  toClipboardImageAttachment,
  tryLoadImageFromPathText,
  type ClipboardImageAttachment,
  type RawClipboardImage,
} from "./clipboard.js";
import { localizeCommand, type CommandKind, type PaletteSubArg } from "./commands.js";
import { formatTokenCountShort } from "./compaction.js";
import type { ChatImageBlock, ChatMessage } from "./model.js";
import {
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from "./modelConfig.js";
import type { ResolvedProvider } from "./providers.js";
import {
  stripInternalPromptNotes,
  type SavedSessionSummary,
} from "./session.js";
import { completePathInput } from "./target.js";
import { renderSupportLine } from "./support.js";
import { completeAtMention } from "./vision.js";

export type BinaryFlowMode = "on" | "eco" | "busy" | "off";

export interface UiCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly kind?: CommandKind;
  readonly usage?: string;
  readonly shortcut?: string;
  readonly description: string;
  readonly source?: "builtin" | "custom";
  readonly pathCompletion?: boolean;
  readonly paletteArgs?: readonly PaletteSubArg[];
}

export interface UiNetworkGuardState {
  readonly state: "offline" | "pinging" | "restored";
  readonly target: string;
  readonly attempt: number;
  readonly reason: string;
  readonly offlineDurationMs: number;
  readonly nextPingInMs: number | null;
  readonly latencyMs: number | null;
}

interface InternalNetworkGuard extends UiNetworkGuardState {
  readonly startedAt: number;
  readonly nextPingAt: number | null;
  clearTimer: NodeJS.Timeout | null;
}

export interface UiStatus {
  model: string;
  modelProvider: string | null;
  effort: ReasoningEffort;
  /** Real-time or most recent turn generation speed in tokens/sec (`tok/s`). */
  tps?: number | null;
  /** True while `tps` is being measured live during an active stream. */
  tpsLive?: boolean;
  /** Time-to-first-token (ms) of the current or most recent turn. */
  ttftMs?: number | null;
  /** Optional dedicated compaction AI or mode badge (e.g. `openai:gpt-4o-mini` or `snapcompact`). */
  compactor?: string | null;
  /** Context window usage; percent is 0–100 against `window` tokens. */
  context: { tokens: number; window: number; percent: number; source?: "provider" | "estimate"; windowSource?: string | undefined };
  target: string | null;
  magic: TargetMagic | null;
  provider: string | null;
  reaConnected: boolean;
  reaTools: number;
  candidates: readonly string[];
  evidence: number | null;
  unknowns: number | null;
  unknownTotal?: number | null;
  unknownResolved?: number | null;
  ledgerHealth?: import("./investigation.js").InvestigationLedger["health"];
  ledgerObservedAt?: string | null;
  analysisScope?: import("./investigation.js").AnalysisScope | null;
  nativeBinding?: "unknown" | "open" | "closed";
  estimatedTokens?: number;
  priorUsageUnknown?: boolean;
  journal: number;
  journalHealth?: import("./journal.js").JournalState["source"];
  journalMalformed?: number;
  tokens: number;
  session: string;
}

export interface UiSubmitOptions {
  readonly immediate?: boolean | undefined;
  readonly images?: readonly ChatImageBlock[] | undefined;
}

export interface UiOptions {
  commands: readonly UiCommand[];
  i18n?: I18n;
  cwd?: string;
  theme?: ColorTheme;
  providers?: () => readonly ResolvedProvider[];
  onSubmit: (line: string, options?: UiSubmitOptions) => void;
  onDequeueSteer?: () => {
    readonly text: string;
    readonly images?: readonly ChatImageBlock[] | undefined;
  } | null;
  onClipboardImage?: () =>
    | Promise<ClipboardImageAttachment | null>
    | ClipboardImageAttachment
    | null;
  onClipboardText?: () => Promise<string | null> | string | null;
  onCopyText?: (text: string) => void;
  /** Opens a validated link; defaults to the platform opener (xdg-open / open / rundll32). */
  onOpenUrl?: (url: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onOpenModelPicker?: (focusProviderId?: string | null) => void;
  onOpenEffortPicker?: () => void;
  onOpenCompactionModelPicker?: () => void;
  onSelectModel?: (
    providerId: string,
    modelId: string,
    effort: ReasoningEffort,
    saveDefault: boolean,
  ) => void;
  onSelectEffort?: (effort: ReasoningEffort, saveDefault: boolean) => void;
  onSelectCompactionModel?: (spec: string | null, saveDefault: boolean) => void;
  onRefreshModels?: () => void;
}

interface ToolCallItem {
  id: string;
  name: string;
  displayTool: string;
  summary: string;
  startedAt: number;
  status: "running" | "ok" | "fail";
  durationMs: number;
  evidenceIds: string[];
}

interface EntryRenderCache {
  readonly width: number;
  readonly rev: number;
  readonly language: I18n["language"];
  readonly lines: readonly string[];
}

type TimelineEntry =
  | { kind: "user"; text: string; rev: number; cache?: EntryRenderCache }
  | {
      kind: "reasoning";
      text: string;
      words: number;
      active: boolean;
      startedAt: number;
      durationMs: number;
      rev: number;
      cache?: EntryRenderCache;
    }
  | {
      kind: "assistant";
      text: string;
      streaming: boolean;
      meta: string | null;
      rev: number;
      cache?: EntryRenderCache;
    }
  | {
      kind: "tools";
      calls: ToolCallItem[];
      rev: number;
      cache?: EntryRenderCache;
    }
  | { kind: "system"; text: string; rev: number; startup?: boolean; localize?: LocalizedMessage; cache?: EntryRenderCache }
  | { kind: "update"; text: string; info: UpdateInfo; rev: number; startup: true; cache?: EntryRenderCache }
  | { kind: "error"; text: string; rev: number; cache?: EntryRenderCache };

/**
 * In-app mouse selection. Transcript selections use logical transcript line indices (so they
 * stay on their text while it scrolls); HUD and composer selections use frame rows. Columns are
 * display columns relative to the region's left edge.
 */
interface ViewportSelection {
  region: SelectionRegion;
  startLineIdx: number;
  startCol: number;
  endLineIdx: number;
  endCol: number;
  dragging: boolean;
  /** Double-click selects a word and triple-click a line; dragging only extends `char` selections. */
  mode: "char" | "word" | "line";
}

/** A rectangle of frame cells (0-based rows/columns). */
interface FrameRegion {
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
}

/** Frame row of the first transcript line; row 0 is the top bar. */
const VIEWPORT_TOP_ROW = 1;
/** Frame column where transcript text starts, after the `│ ` border. */
const VIEWPORT_LEFT_COL = 2;

interface PaletteItem {
  readonly kind: "command" | "path" | "arg" | "mention";
  readonly badge: string;
  readonly badgeKind: CommandKind | "path" | "arg";
  readonly label: string;
  readonly usage: string;
  readonly shortcut?: string;
  readonly description: string;
  readonly completion: string;
  readonly cursorAfter?: number | undefined;
  readonly submitOnEnter: boolean;
}

interface PickerTab {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly local: boolean;
  readonly modelCount: number;
  readonly provider?: ResolvedProvider;
}

interface PickerModelRow {
  readonly provider: ResolvedProvider;
  readonly modelId: string;
  readonly note?: string | undefined;
  readonly source:
    | "configured"
    | "live"
    | "curated"
    | "custom-input"
    | "inherit-active";
  readonly active: boolean;
}

interface ModelPickerState {
  open: boolean;
  purpose: "active" | "compaction";
  stage: "model" | "effort";
  effortOnly: boolean;
  providers: readonly ResolvedProvider[];
  activeProviderId: string | null;
  activeModelId: string;
  compactionModelSpec: string | null;
  activeEffort: ReasoningEffort;
  pendingProviderId: string | null;
  pendingModelId: string;
  pendingSaveDefault: boolean;
  selectedEffortIndex: number;
  selectedTab: number;
  selectedRow: number;
  query: string;
  loading: boolean;
  notice: string | LocalizedMessage | null;
}

interface SessionPickerState {
  open: boolean;
  sessions: readonly SavedSessionSummary[];
  selectedRow: number;
  query: string;
}

export interface RenderedFrame {
  readonly lines: string[];
  readonly cursor: {
    readonly row: number;
    readonly col: number;
    readonly visible: boolean;
  };
}

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const THINKING_STAR_FRAMES = [
  "✻",
  "✼",
  "❉",
  "❊",
  "✺",
  "✹",
  "✸",
  "✶",
] as const;
const IDLE_FLOW_GRACE_MS = 3_000;
const FLOW_INTERVAL_MS = 105;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_TIMELINE_ENTRIES = 600;
const MAX_TIMELINE_CHARS = 240_000;
const MAX_ENTRY_CHARS = 8_000;
const MAX_TOOL_GROUP = 16;

const binaryModeKeys = {
  busy: "hud.binaryBusy", eco: "hud.binaryEco", off: "hud.binaryOff", on: "hud.binaryOn",
} satisfies Record<BinaryFlowMode, MessageKey>;

const paletteBadgeKeys = {
  FLOW: "badge.flow", ASK: "badge.prompt", LOCAL: "badge.local", ARG: "badge.args",
  DIR: "badge.dir", FILE: "badge.file", NOW: "badge.now", MODE: "badge.mode",
  DFLT: "badge.default", CONN: "badge.connected", SETUP: "badge.setup", THINK: "badge.thinking",
  UI: "badge.ui", IMG: "badge.image", BIN: "badge.binary", LIVE: "badge.live",
  SYNC: "badge.sync", LIST: "badge.list", ENDP: "badge.endpoint",
} satisfies Record<string, MessageKey>;

const timelineText = (i18n: I18n, text: string): string => {
  if (text.length <= MAX_ENTRY_CHARS) return sanitizeText(text);
  const slice = Math.floor(MAX_ENTRY_CHARS / 2) - 24;
  return sanitizeText(`${text.slice(0, slice)}\n… ${i18n.t("timeline.preview")} …\n${text.slice(-slice)}`);
};
const DOUBLE_ENTER_STEER_WINDOW_MS = 650;
/** Inactivity gap after which an unterminated bracketed paste is flushed (large pastes arrive in bursts while the UI repaints). */
const PASTE_SAFETY_TIMEOUT_MS = 2_000;
/** How long an incomplete escape sequence is held waiting for its continuation before a lone ESC is treated as the Esc key. */
const ESC_SEQUENCE_WAIT_MS = 40;
const MAX_STAGED_IMAGES = 6;
const EVIDENCE_ID_EXTRACT_RE = /\bev_[0-9a-f]{64}\b/g;

const decodeBracketedPasteText = (raw: string): string =>
  raw
    .replace(/\x1b\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

const basenameOf = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const hline = (width: number): string => "─".repeat(Math.max(0, width));

/** Startup notices (release notes, AGENTS.md, update box) keep the splash on screen. */
const isStartupNotice = (entry: TimelineEntry): boolean =>
  entry.kind === "update" || (entry.kind === "system" && entry.startup === true);

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;

/** Context meter color: calm until 60%, warning until 85% (where compaction fires), then critical. */
const contextColor = (percent: number, t: ColorTheme): string =>
  percent >= 85 ? t.crimson : percent >= 60 ? t.amber : t.neonMint;

const contextBar = (percent: number, width: number, t: ColorTheme): string => {
  const cells = Math.max(4, width);
  const filled = Math.min(
    cells,
    Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * cells)),
  );
  return `${contextColor(percent, t)}${"█".repeat(filled)}${t.subtle}${"░".repeat(cells - filled)}${t.reset}`;
};

const formatTokenCount = (tokens: number): string => {
  if (tokens <= 0) return "0";
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
};

const prevCodePointIndex = (text: string, index: number): number => {
  if (index <= 0) return 0;
  if (index >= 2) {
    const hi = text.charCodeAt(index - 2);
    const lo = text.charCodeAt(index - 1);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff)
      return index - 2;
  }
  return index - 1;
};

const nextCodePointIndex = (text: string, index: number): number => {
  if (index >= text.length) return text.length;
  const cp = text.codePointAt(index)!;
  return Math.min(text.length, index + (cp > 0xffff ? 2 : 1));
};

interface WrappedComposerLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const wrapComposerWithCursor = (
  text: string,
  cursor: number,
  width: number,
): { lines: WrappedComposerLine[]; row: number; col: number } => {
  const safeWidth = Math.max(4, width);
  const lines: WrappedComposerLine[] = [];
  let pos = 0;
  const rawLines = text.split("\n");
  for (let r = 0; r < rawLines.length; r += 1) {
    const seg = rawLines[r]!;
    if (seg.length === 0) {
      lines.push({ text: "", start: pos, end: pos });
      pos += 1;
      continue;
    }
    let segOffset = 0;
    while (segOffset < seg.length) {
      let cols = 0;
      let i = segOffset;
      while (i < seg.length) {
        const cp = seg.codePointAt(i)!;
        const w = codePointWidth(cp);
        if (cols + w > safeWidth && i > segOffset) break;
        cols += w;
        i += cp > 0xffff ? 2 : 1;
      }
      lines.push({
        text: seg.slice(segOffset, i),
        start: pos + segOffset,
        end: pos + i,
      });
      segOffset = i;
    }
    pos += seg.length + 1;
  }
  if (lines.length === 0) lines.push({ text: "", start: 0, end: 0 });

  let cursorRow = lines.length - 1;
  let cursorCol = visibleWidth(lines[cursorRow]!.text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isLineEnd = i === lines.length - 1 || text[line.end] === "\n";
    if (
      cursor >= line.start &&
      (cursor < line.end || (cursor === line.end && isLineEnd))
    ) {
      cursorRow = i;
      cursorCol = visibleWidth(text.slice(line.start, cursor));
      break;
    }
  }
  return { lines, row: cursorRow, col: cursorCol };
};

export class TerminalUi {
  private readonly stdout = process.stdout;
  private readonly hyperlinks = process.env["TERM"] !== "dumb";
  private readonly decoder = new StringDecoder("utf8");
  private readonly theme: ColorTheme;
  private readonly cwd: string;

  private timeline: TimelineEntry[] = [];
  private output = { label: "", text: "" };
  private outputWrapCache: {
    text: string;
    width: number;
    lines: readonly string[];
  } | null = null;
  private outputDrawerOpen = false;
  private outputExpanded = false;
  private outputScroll = 0;

  private composer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = "";

  private paletteOpen = false;
  private paletteSelected = 0;
  private scroll = 0;

  private status: UiStatus = {
    model: "",
    modelProvider: null,
    effort: "auto",
    tps: null,
    tpsLive: false,
    ttftMs: null,
    context: { tokens: 0, window: 32_768, percent: 0, source: "estimate", windowSource: "conservative-default" },
    target: null,
    magic: null,
    provider: null,
    reaConnected: false,
    reaTools: 0,
    candidates: [],
    evidence: null,
    unknowns: null,
    ledgerHealth: "unobserved",
    journal: 0,
    tokens: 0,
    session: "",
  };

  private picker: ModelPickerState = {
    open: false,
    purpose: "active",
    stage: "model",
    effortOnly: false,
    providers: [],
    activeProviderId: null,
    activeModelId: "",
    compactionModelSpec: null,
    activeEffort: "auto",
    pendingProviderId: null,
    pendingModelId: "",
    pendingSaveDefault: false,
    selectedEffortIndex: 0,
    selectedTab: 0,
    selectedRow: 0,
    query: "",
    loading: false,
    notice: null,
  };

  private sessionPicker: SessionPickerState = {
    open: false,
    sessions: [],
    selectedRow: 0,
    query: "",
  };

  private busy: string | LocalizedMessage | null = null;
  private readonly subagentActivity = new Map<string, LocalizedMessage>();
  private busyStartedAt = 0;
  private networkGuard: InternalNetworkGuard | null = null;
  private binaryMode: BinaryFlowMode = "on";
  private lastInteractionAt = Date.now();
  private ctrlCArmedUntil = 0;

  private started = false;
  private firstInput = true;
  private paintTimer: NodeJS.Timeout | null = null;
  private flowTimer: NodeJS.Timeout | null = null;
  private tick = 0;

  private pasteMode = false;
  private pasteBuffer = "";
  private pasteSafetyTimer: NodeJS.Timeout | null = null;
  private escCarry = "";
  private escCarryTimer: NodeJS.Timeout | null = null;

  private queuedSteers: readonly string[] = [];
  private stagedImages: ClipboardImageAttachment[] = [];
  private nextImageId = 1;
  private lastBusySubmitAt = 0;
  private selection: ViewportSelection | null = null;
  private lastViewportLayout: {
    startLine: number;
    height: number;
    leftCellWidth: number;
    lines: readonly string[];
    hero?: boolean;
  } = { startLine: 0, height: 0, leftCellWidth: 0, lines: [] };
  private frameRegions: { hud: FrameRegion | null; composer: FrameRegion | null } = { hud: null, composer: null };
  /** Frame lines of the last rendered main frame, used to copy HUD/composer selections. */
  private lastFrameLines: readonly string[] = [];
  /** Clickable links of the last rendered frame by row, in absolute frame columns. */
  private frameLinks = new Map<number, LinkSpan[]>();
  /** Transcript links of the visible viewport rows (row relative to the viewport, columns to its text). */
  private viewportLinks: { row: number; span: LinkSpan }[] = [];
  private readonly clickCounter = new ClickCounter();
  /** OSC 8 link under a plain press; opened on release when the press did not become a selection. */
  private pendingPlainLink: string | null = null;
  private clipboardNotice: { text: LocalizedMessage; until: number } | null = null;
  private clipboardNoticeTimer: NodeJS.Timeout | null = null;

  private streamEntry: Extract<TimelineEntry, { kind: "assistant" }> | null =
    null;
  private streamEndedWithCr = false;
  private reasoningEntry: Extract<TimelineEntry, { kind: "reasoning" }> | null =
    null;
  private prevLines: string[] = [];
  private prevRows = 0;
  private prevCols = 0;

  private commandsList: readonly UiCommand[];
  private readonly i18n: I18n;

  constructor(private readonly options: UiOptions) {
    this.i18n = options.i18n ?? new I18n();
    this.theme = options.theme ?? createTheme();
    this.cwd = options.cwd ?? process.cwd();
    this.commandsList = options.commands.map((command) => localizeCommand(command, this.i18n));
  }

  setCommands(commands: readonly UiCommand[]): void {
    this.commandsList = commands.map((command) => localizeCommand(command, this.i18n));
    this.syncPalette();
    this.schedule();
  }

  private paletteBadge(badge: string): string {
    const key = paletteBadgeKeys[badge as keyof typeof paletteBadgeKeys];
    return key ? this.i18n.t(key) || badge : badge;
  }

  get currentBinaryMode(): BinaryFlowMode {
    return this.binaryMode;
  }

  get isModelPickerOpen(): boolean {
    return this.picker.open;
  }

  openModelPicker(
    providers: readonly ResolvedProvider[],
    activeProviderId: string | null,
    activeModelId: string,
    focusProviderId?: string | null,
    loading = false,
    activeEffort: ReasoningEffort = this.status.effort,
  ): void {
    const effortIdx = Math.max(
      0,
      REASONING_EFFORT_LEVELS.findIndex((lvl) => lvl.id === activeEffort),
    );
    this.picker.open = true;
    this.picker.purpose = "active";
    this.picker.stage = "model";
    this.picker.effortOnly = false;
    this.picker.providers = providers;
    this.picker.activeProviderId = activeProviderId;
    this.picker.activeModelId = activeModelId;
    this.picker.activeEffort = activeEffort;
    this.picker.pendingProviderId = activeProviderId;
    this.picker.pendingModelId = activeModelId;
    this.picker.pendingSaveDefault = false;
    this.picker.selectedEffortIndex = effortIdx;
    this.picker.query = "";
    this.picker.loading = loading;
    this.picker.notice = null;
    this.paletteOpen = false;
    this.outputExpanded = false;

    const tabs = this.pickerTabs();
    if (focusProviderId) {
      const idx = tabs.findIndex((t) => t.id === focusProviderId.toLowerCase());
      this.picker.selectedTab = idx >= 0 ? idx : 0;
    } else {
      this.picker.selectedTab = 0;
    }
    const rows = this.pickerRows();
    const activeIdx = rows.findIndex((r) => r.active);
    this.picker.selectedRow = activeIdx >= 0 ? activeIdx : 0;
    this.syncFlowTimer();
    this.paint();
  }

  openCompactionModelPicker(
    providers: readonly ResolvedProvider[],
    activeProviderId: string | null,
    activeModelId: string,
    compactionModelSpec: string | null,
    loading = false,
  ): void {
    this.picker.open = true;
    this.picker.purpose = "compaction";
    this.picker.stage = "model";
    this.picker.effortOnly = false;
    this.picker.providers = providers;
    this.picker.activeProviderId = activeProviderId;
    this.picker.activeModelId = activeModelId;
    this.picker.compactionModelSpec = compactionModelSpec;
    this.picker.pendingProviderId = activeProviderId;
    this.picker.pendingModelId = activeModelId;
    this.picker.pendingSaveDefault = false;
    this.picker.query = "";
    this.picker.loading = loading;
    this.picker.notice = (t) => t("picker.compactionHelp");
    this.paletteOpen = false;
    this.outputExpanded = false;
    this.picker.selectedTab = 0;
    const rows = this.pickerRows();
    const activeIdx = rows.findIndex((r) => r.active);
    this.picker.selectedRow = activeIdx >= 0 ? activeIdx : 0;
    this.syncFlowTimer();
    this.paint();
  }

  openEffortPicker(
    providers: readonly ResolvedProvider[],
    activeProviderId: string | null,
    activeModelId: string,
    activeEffort: ReasoningEffort = this.status.effort,
  ): void {
    this.openModelPicker(
      providers,
      activeProviderId,
      activeModelId,
      activeProviderId,
      false,
      activeEffort,
    );
    this.picker.stage = "effort";
    this.picker.effortOnly = true;
    this.paint();
  }

  updateModelPicker(patch: {
    providers?: readonly ResolvedProvider[];
    activeProviderId?: string | null;
    activeModelId?: string;
    loading?: boolean;
    notice?: string | null;
  }): void {
    const prevTabs = this.pickerTabs();
    const prevTabId = prevTabs[this.picker.selectedTab]?.id ?? null;

    if (patch.providers !== undefined) this.picker.providers = patch.providers;
    if (patch.activeProviderId !== undefined)
      this.picker.activeProviderId = patch.activeProviderId;
    if (patch.activeModelId !== undefined)
      this.picker.activeModelId = patch.activeModelId;
    if (patch.loading !== undefined) this.picker.loading = patch.loading;
    if (patch.notice !== undefined) this.picker.notice = patch.notice;

    if (prevTabId) {
      const nextTabs = this.pickerTabs();
      const idx = nextTabs.findIndex((t) => t.id === prevTabId);
      if (idx >= 0) this.picker.selectedTab = idx;
    }
    const rows = this.pickerRows();
    if (this.picker.selectedRow >= rows.length) {
      this.picker.selectedRow = Math.max(0, rows.length - 1);
    }
    this.schedule();
  }

  closeModelPicker(): void {
    if (!this.picker.open) return;
    this.picker.open = false;
    this.picker.loading = false;
    this.syncFlowTimer();
    this.paint();
  }

  get isSessionPickerOpen(): boolean {
    return this.sessionPicker.open;
  }

  openSessionPicker(sessions: readonly SavedSessionSummary[]): void {
    this.picker.open = false;
    this.paletteOpen = false;
    this.outputExpanded = false;
    this.outputDrawerOpen = false;
    this.sessionPicker.open = true;
    this.sessionPicker.sessions = sessions;
    this.sessionPicker.selectedRow = 0;
    this.sessionPicker.query = "";
    this.syncFlowTimer();
    this.paint();
  }

  closeSessionPicker(): void {
    if (!this.sessionPicker.open) return;
    this.sessionPicker.open = false;
    this.syncFlowTimer();
    this.paint();
  }

  private filteredSessionPickerRows(): SavedSessionSummary[] {
    const q = this.sessionPicker.query.trim().toLowerCase();
    if (!q) return [...this.sessionPicker.sessions];
    const terms = q.split(/\s+/).filter(Boolean);
    return this.sessionPicker.sessions.filter((s, idx) => {
      const numIdx = s.index ?? idx + 1;
      const hay = [
        `#${numIdx}`,
        String(numIdx),
        s.shortId ?? "",
        s.id,
        s.title ?? "",
        s.firstUserPrompt ?? "",
        s.lastMessagePreview ?? "",
        s.target ?? "",
        s.model ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  start(): void {
    if (this.started || !this.stdout.isTTY) return;
    this.started = true;
    this.firstInput = true;
    this.lastInteractionAt = Date.now();
    this.prevLines = [];
    this.stdout.write(
      `${ESC}?1049h${ESC}?2004h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?1007l${ESC}?25l${ESC}2J${ESC}H`,
    );
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    // Take over from the pre-load capture in the same tick as attaching our listener, so no chunk is lost.
    const typedAhead = takeEarlyInput();
    process.stdin.on("data", this.onData);
    this.stdout.on("resize", this.onResize);
    this.syncFlowTimer();
    this.paint();
    if (typedAhead) this.onData(typedAhead);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.stdin.off("data", this.onData);
    this.stdout.off("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (this.paintTimer) {
      clearTimeout(this.paintTimer);
      this.paintTimer = null;
    }
    if (this.flowTimer) {
      clearInterval(this.flowTimer);
      this.flowTimer = null;
    }
    if (this.pasteSafetyTimer) {
      clearTimeout(this.pasteSafetyTimer);
      this.pasteSafetyTimer = null;
    }
    this.clearEscCarryTimer();
    this.escCarry = "";
    if (this.clipboardNoticeTimer) {
      clearTimeout(this.clipboardNoticeTimer);
      this.clipboardNoticeTimer = null;
    }
    if (this.networkGuard?.clearTimer) {
      clearTimeout(this.networkGuard.clearTimer);
      this.networkGuard.clearTimer = null;
    }
    this.stdout.write(
      `${ESC}?25h${ESC}?1007l${ESC}?1006l${ESC}?1002l${ESC}?1000l${ESC}?2004l${ESC}?1049l`,
    );
  }

  get currentNetworkStatus(): UiNetworkGuardState | null {
    if (!this.networkGuard) return null;
    const {
      state,
      target,
      attempt,
      reason,
      offlineDurationMs,
      nextPingInMs,
      latencyMs,
    } = this.networkGuard;
    return {
      state,
      target,
      attempt,
      reason,
      offlineDurationMs,
      nextPingInMs,
      latencyMs,
    };
  }

  setNetworkStatus(status: UiNetworkGuardState | null): void {
    if (this.networkGuard?.clearTimer) {
      clearTimeout(this.networkGuard.clearTimer);
      this.networkGuard.clearTimer = null;
    }
    if (!status) {
      this.networkGuard = null;
      this.syncFlowTimer();
      this.schedule();
      return;
    }
    const durationMs = Number.isFinite(status.offlineDurationMs)
      ? status.offlineDurationMs
      : 0;
    const prevStarted =
      this.networkGuard && this.networkGuard.state !== "restored"
        ? this.networkGuard.startedAt
        : Date.now() - Math.max(0, durationMs);
    const nextPingAt =
      typeof status.nextPingInMs === "number" &&
      Number.isFinite(status.nextPingInMs)
        ? Date.now() + status.nextPingInMs
        : null;

    let clearTimer: NodeJS.Timeout | null = null;
    if (status.state === "restored") {
      clearTimer = setTimeout(() => {
        if (this.networkGuard?.state === "restored") {
          this.networkGuard = null;
          this.syncFlowTimer();
          this.schedule();
        }
      }, 3_200);
      clearTimer.unref?.();
    }

    this.networkGuard = {
      ...status,
      startedAt: prevStarted,
      nextPingAt,
      clearTimer,
    };
    this.syncFlowTimer();
    this.schedule();
  }

  /**
   * Discard any incomplete in-progress assistant or reasoning stream entry for the active step
   * when a mid-stream network drop triggers a clean step rollback and auto-resume.
   */
  resetActiveStream(): void {
    if (this.reasoningEntry) {
      const rIdx = this.timeline.indexOf(this.reasoningEntry);
      if (rIdx >= 0) this.timeline.splice(rIdx, 1);
      this.reasoningEntry = null;
    }
    if (this.streamEntry) {
      const sIdx = this.timeline.indexOf(this.streamEntry);
      if (sIdx >= 0) this.timeline.splice(sIdx, 1);
      this.streamEntry = null;
    }
    this.streamEndedWithCr = false;
    this.schedule();
  }

  setBinaryMode(mode?: BinaryFlowMode | "always"): BinaryFlowMode {
    if (mode) {
      this.binaryMode = mode === "always" ? "on" : mode;
    } else {
      this.binaryMode =
        this.binaryMode === "on"
          ? "eco"
          : this.binaryMode === "eco"
            ? "busy"
            : this.binaryMode === "busy"
              ? "off"
              : "on";
    }
    this.lastInteractionAt = Date.now();
    this.syncFlowTimer();
    this.paint();
    return this.binaryMode;
  }

  setStatus(patch: Partial<UiStatus>): void {
    this.status = { ...this.status, ...patch };
    this.schedule();
  }

  setSubagentActivity(id: string, activity: LocalizedMessage | null): void {
    if (activity) this.subagentActivity.set(id, activity);
    else this.subagentActivity.delete(id);
    this.syncFlowTimer();
    this.schedule();
  }

  setQueuedSteers(items: readonly string[]): void {
    this.queuedSteers = [...items];
    this.schedule();
    this.paint();
  }

  getQueuedSteers(): readonly string[] {
    return this.queuedSteers;
  }

  getStagedImages(): readonly ClipboardImageAttachment[] {
    return this.stagedImages;
  }

  clearStagedImages(index?: number): number {
    if (typeof index === "number" && Number.isFinite(index) && index >= 1) {
      if (index > this.stagedImages.length) return 0;
      this.stagedImages.splice(index - 1, 1);
      this.paint();
      return 1;
    }
    const count = this.stagedImages.length;
    this.stagedImages.length = 0;
    this.paint();
    return count;
  }

  consumeStagedImages(): ClipboardImageAttachment[] {
    const items = this.stagedImages.splice(0, this.stagedImages.length);
    if (items.length > 0) this.paint();
    return items;
  }

  stageImageAttachment(
    input: ClipboardImageAttachment | RawClipboardImage,
  ): void {
    const attachment = toClipboardImageAttachment(this.nextImageId++, input);
    if (this.stagedImages.length >= MAX_STAGED_IMAGES) {
      this.stagedImages.shift();
    }
    this.stagedImages.push(attachment);
    this.setClipboardNotice(
      (t) => t("clipboard.added", { label: attachment.label }),
    );
    this.paint();
  }

  private setClipboardNotice(text: LocalizedMessage, durationMs = 2_800): void {
    if (this.clipboardNoticeTimer) {
      clearTimeout(this.clipboardNoticeTimer);
      this.clipboardNoticeTimer = null;
    }
    this.clipboardNotice = { text, until: Date.now() + durationMs };
    this.clipboardNoticeTimer = setTimeout(() => {
      this.clipboardNotice = null;
      this.clipboardNoticeTimer = null;
      this.schedule();
    }, durationMs);
    this.clipboardNoticeTimer.unref?.();
    this.schedule();
  }

  private finishReasoning(): void {
    if (!this.reasoningEntry) return;
    this.reasoningEntry.active = false;
    this.reasoningEntry.durationMs = Math.max(
      0,
      Date.now() - this.reasoningEntry.startedAt,
    );
    this.reasoningEntry.rev += 1;
    this.reasoningEntry = null;
  }

  setBusy(label: string | LocalizedMessage | null): void {
    const wasBusy = this.busy !== null;
    this.busy = label;
    if (label && !wasBusy) this.busyStartedAt = Date.now();
    if (!label) {
      this.busyStartedAt = 0;
      this.lastBusySubmitAt = 0;
      this.finishReasoning();
    }
    this.syncFlowTimer();
    this.schedule();
  }

  addUser(text: string): void {
    this.closeActiveStreams();
    this.outputDrawerOpen = false;
    this.timeline.push({ kind: "user", text: timelineText(this.i18n, text), rev: 1 });
    this.trimTimeline();
    this.scroll = 0;
    this.paint();
  }

  addSystem(message: string | LocalizedMessage, startup = false): void {
    const text = typeof message === "string" ? message : message(this.i18n.t);
    this.timeline.push({
      kind: "system", text: timelineText(this.i18n, text), rev: 1, startup,
      ...(typeof message === "function" && { localize: message }),
    });
    this.trimTimeline();
    this.scroll = 0;
    this.paint();
  }

  /**
   * Shows (or updates in place) the boxed "Update Available" notice. On the splash it goes first so
   * the notice budget never clips it; during a conversation it is appended as a new event.
   */
  showUpdate(info: UpdateInfo): void {
    if (info.packages.length === 0) return;
    const text = info.packages.map((pkg) => `${pkg.name} ${pkg.installed} → ${pkg.latest}`).join(", ");
    const existing = this.timeline.find((entry) => entry.kind === "update");
    if (existing && existing.kind === "update") {
      existing.info = info;
      existing.text = text;
      existing.rev += 1;
    } else {
      const entry: TimelineEntry = { kind: "update", text, info, rev: 1, startup: true };
      if (this.timeline.every(isStartupNotice)) this.timeline.unshift(entry);
      else this.timeline.push(entry);
      this.trimTimeline();
      this.scroll = 0;
    }
    this.paint();
  }

  addError(text: string): void {
    this.timeline.push({ kind: "error", text: timelineText(this.i18n, text), rev: 1 });
    this.trimTimeline();
    this.scroll = 0;
    this.paint();
  }

  appendReasoning(delta: string): void {
    if (!delta) return;
    if (!this.reasoningEntry) {
      this.reasoningEntry = {
        kind: "reasoning",
        text: "",
        words: 0,
        active: true,
        startedAt: Date.now(),
        durationMs: 0,
        rev: 1,
      };
      this.timeline.push(this.reasoningEntry);
    }
    const clean = sanitizeText(delta);
    if (!clean) return;
    const chunkWords = clean.trim() ? clean.trim().split(/\s+/).length : 0;
    this.reasoningEntry.words += chunkWords;
    this.reasoningEntry.text = timelineText(this.i18n, this.reasoningEntry.text + clean);
    this.reasoningEntry.rev += 1;
    this.scroll = 0;
    this.schedule();
  }

  beginAssistant(): void {
    if (this.streamEntry) this.endAssistant("");
    this.streamEntry = null;
    this.streamEndedWithCr = false;
    this.schedule();
  }

  appendAssistant(delta: string): void {
    if (!delta) return;
    this.finishReasoning();
    if (!this.streamEntry) {
      this.streamEntry = {
        kind: "assistant",
        text: "",
        streaming: true,
        meta: null,
        rev: 1,
      };
      this.streamEndedWithCr = false;
      this.timeline.push(this.streamEntry);
    }
    const slice =
      this.streamEndedWithCr && delta.startsWith("\n") ? delta.slice(1) : delta;
    this.streamEndedWithCr = delta.endsWith("\r");
    if (slice.length > 0) {
      this.streamEntry.text = timelineText(this.i18n, this.streamEntry.text + slice);
      this.streamEntry.rev += 1;
    }
    this.scroll = 0;
    this.schedule();
  }

  endAssistant(text: string, meta?: string | null): void {
    this.finishReasoning();
    this.streamEndedWithCr = false;
    if (!this.streamEntry && text.trim().length > 0) {
      this.timeline.push({
        kind: "assistant",
        text: timelineText(this.i18n, text),
        streaming: false,
        meta: meta ?? null,
        rev: 1,
      });
      this.trimTimeline();
      this.paint();
      return;
    }
    const entry = this.streamEntry;
    this.streamEntry = null;
    if (!entry) return;
    entry.streaming = false;
    if (text) entry.text = timelineText(this.i18n, text);
    if (meta !== undefined) entry.meta = meta;
    entry.rev += 1;
    if (entry.text.trim().length === 0) {
      const idx = this.timeline.indexOf(entry);
      if (idx >= 0) this.timeline.splice(idx, 1);
    } else {
      this.trimTimeline();
    }
    this.paint();
  }

  annotateLastAssistant(meta: string): void {
    for (let i = this.timeline.length - 1; i >= 0; i -= 1) {
      const item = this.timeline[i]!;
      if (item.kind === "assistant") {
        item.meta = meta;
        item.rev += 1;
        this.schedule();
        return;
      }
    }
  }

  toolStart(callId: string, name: string, args: Record<string, unknown>): void {
    this.finishReasoning();
    if (this.streamEntry) {
      this.endAssistant("");
    }
    const { displayTool, summary } = summarizeToolCall(name, args);
    const item: ToolCallItem = {
      id: callId,
      name,
      displayTool,
      summary,
      startedAt: Date.now(),
      status: "running",
      durationMs: 0,
      evidenceIds: [],
    };
    const last = this.timeline.at(-1);
    if (last?.kind === "tools" && last.calls.length < MAX_TOOL_GROUP) {
      last.calls.push(item);
      last.rev += 1;
    } else {
      this.timeline.push({ kind: "tools", calls: [item], rev: 1 });
      this.trimTimeline();
    }
    this.scroll = 0;
    this.schedule();
  }

  toolEnd(
    callId: string,
    name: string,
    ok: boolean,
    durationMs: number,
    evidenceIds: string[],
  ): void {
    for (let i = this.timeline.length - 1; i >= 0; i -= 1) {
      const entry = this.timeline[i]!;
      if (entry.kind !== "tools") continue;
      const target =
        entry.calls.find((c) => c.id === callId && c.status === "running") ??
        entry.calls.find((c) => c.status === "running");
      if (target) {
        target.status = ok ? "ok" : "fail";
        target.durationMs = durationMs;
        target.evidenceIds = evidenceIds;
        if (name && target.name === "rea_call")
          target.displayTool = `rea_call→${name}`;
        entry.rev += 1;
        this.schedule();
        return;
      }
    }
    // Fallback if toolStart was not paired
    this.timeline.push({
      kind: "tools",
      rev: 1,
      calls: [
        {
          id: callId,
          name,
          displayTool: name,
          summary: "",
          startedAt: Date.now() - durationMs,
          status: ok ? "ok" : "fail",
          durationMs,
          evidenceIds,
        },
      ],
    });
    this.schedule();
  }

  showOutput(label: string, text: string, options?: { expanded: boolean }): void {
    const capped =
      !options?.expanded && text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n${this.i18n.t("drawer.capped", { count: text.length - MAX_OUTPUT_CHARS })}`
        : text;
    this.output = { label, text: sanitizeText(capped) };
    this.outputWrapCache = null;
    this.outputDrawerOpen = true;
    if (options?.expanded) this.outputExpanded = true;
    this.outputScroll = 0;
    this.paint();
  }

  dismissOutput(): void {
    this.outputDrawerOpen = false;
    this.outputExpanded = false;
    this.paint();
  }

  clearChat(): void {
    this.timeline = [];
    this.streamEntry = null;
    this.streamEndedWithCr = false;
    this.reasoningEntry = null;
    this.outputDrawerOpen = false;
    this.outputExpanded = false;
    this.scroll = 0;
    this.lastInteractionAt = Date.now();
    this.syncFlowTimer();
    this.paint();
  }

  /**
   * Replay a restored or rewound conversation history (`ChatMessage[]`) directly into
   * the TUI timeline, composer `Up`-arrow input history, and HUD recent tool calls
   * (`omp`-style transcript hydration).
   */
  hydrateFromHistory(
    messages: readonly ChatMessage[],
    options?: { readonly bannerText?: string | undefined },
  ): void {
    messages = messages.slice(-240);
    this.closeActiveStreams();
    this.outputDrawerOpen = false;
    this.outputExpanded = false;
    this.selection = null;

    // Preserve initial startup notices (AGENTS.md / active profile) at the very top
    const startupNotices = this.timeline.filter(isStartupNotice);
    this.timeline = [...startupNotices];

    // Map tool_call_id -> tool result message for pairing status, duration, and Evidence IDs
    const toolResultById = new Map<string, ChatMessage>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultById.set(msg.tool_call_id, msg);
      }
    }

    for (const msg of messages) {
      if (msg.role === "system" || msg.role === "tool") continue;

      if (msg.role === "user") {
        const rawContent = typeof msg.content === "string" ? timelineText(this.i18n, msg.content) : "";
        const cleaned = stripInternalPromptNotes(rawContent);
        if (!cleaned && (!msg.images || msg.images.length === 0)) continue;

        // Render synthetic compaction/auto-resume/tool-image markers as compact system lines
        if (
          cleaned.startsWith("[omr context compaction") ||
          cleaned.startsWith("[omr:auto-resume]") ||
          cleaned.startsWith("[omr: attached ")
        ) {
          const firstLine = cleaned.split("\n")[0] ?? cleaned;
          this.timeline.push({
            kind: "system",
            text: sanitizeText(firstLine),
            rev: 1,
          });
          continue;
        }

        const promptLabel =
          msg.images && msg.images.length > 0
            ? `${cleaned || this.i18n.t("ui.imageOnly")} [📎 ×${msg.images.length}]`
            : cleaned;
        this.timeline.push({
          kind: "user",
          text: sanitizeText(promptLabel),
          rev: 1,
        });
        if (cleaned && this.history.at(-1) !== cleaned) {
          this.history.push(cleaned);
          if (this.history.length > 200) this.history.shift();
        }
        continue;
      }

      if (msg.role === "assistant") {
        // 1. Reasoning / extended thinking block
        const reasoningParts: string[] = [];
        if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
          reasoningParts.push(msg.reasoning_content.trim());
        } else if (Array.isArray(msg.thinking_blocks)) {
          for (const b of msg.thinking_blocks) {
            if (b.type === "thinking" && b.thinking.trim()) {
              reasoningParts.push(b.thinking.trim());
            }
          }
        }
        if (reasoningParts.length > 0) {
          const thoughtText = timelineText(this.i18n, reasoningParts.join("\n\n"));
          const words = thoughtText
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;
          this.timeline.push({
            kind: "reasoning",
            text: thoughtText,
            words,
            active: false,
            startedAt: 0,
            durationMs: 0,
            rev: 1,
          });
        }

        // 2. Assistant markdown message
        if (typeof msg.content === "string" && msg.content.trim().length > 0) {
          this.timeline.push({
            kind: "assistant",
            text: timelineText(this.i18n, msg.content).replace(/^\n+/, ""),
            streaming: false,
            meta: null,
            rev: 1,
          });
        }

        // 3. Tool calls paired with their tool results
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          const calls: ToolCallItem[] = [];
          for (const tc of msg.tool_calls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              const raw = JSON.parse(tc.function.arguments || "{}");
              if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                parsedArgs = raw as Record<string, unknown>;
              }
            } catch {
              parsedArgs = {};
            }
            const { displayTool, summary } = summarizeToolCall(
              tc.function.name,
              parsedArgs,
            );
            const toolResult = toolResultById.get(tc.id);
            const resultText =
              typeof toolResult?.content === "string" ? toolResult.content : "";
            const evSet = new Set<string>();
            for (const m of resultText.matchAll(EVIDENCE_ID_EXTRACT_RE)) {
              evSet.add(m[0]);
              if (evSet.size >= 8) break;
            }
            const durMatch =
              /→\s*exit\s+\d+\s+in\s+(\d+)\s*ms/i.exec(resultText) ??
              /\bduration_ms["\s:]+(\d+)/i.exec(resultText);
            const durationMs = durMatch ? Number(durMatch[1]) : 0;
            const failed =
              /^(?:error\b|✗)/i.test(resultText.trim()) ||
              /→\s*exit\s+[1-9]\d*/.test(resultText);
            calls.push({
              id: tc.id,
              name: tc.function.name,
              displayTool,
              summary,
              startedAt: 0,
              status: failed ? "fail" : "ok",
              durationMs,
              evidenceIds: [...evSet],
            });
          }

          for (const call of calls) {
            const prev = this.timeline.at(-1);
            if (prev?.kind === "tools" && prev.calls.length < MAX_TOOL_GROUP) {
              prev.calls.push(call);
              prev.rev += 1;
            } else {
              this.timeline.push({ kind: "tools", calls: [call], rev: 1 });
            }
          }
        }
      }
    }

    if (options?.bannerText) {
      this.timeline.push({
        kind: "system",
        text: sanitizeText(options.bannerText),
        rev: 1,
      });
    }

    this.trimTimeline();
    this.historyIndex = -1;
    this.scroll = 0;
    this.lastInteractionAt = Date.now();
    this.syncFlowTimer();
    this.paint();
  }

  private closeActiveStreams(): void {
    this.finishReasoning();
    if (this.streamEntry) {
      this.endAssistant("");
    }
  }

  private entryCharSize(entry: TimelineEntry): number {
    if (entry.kind === "tools") return entry.calls.length * 80;
    return entry.text.length;
  }

  private trimTimeline(): void {
    if (this.timeline.length > MAX_TIMELINE_ENTRIES) {
      this.timeline.splice(0, this.timeline.length - MAX_TIMELINE_ENTRIES);
    }
    let totalChars = 0;
    for (const entry of this.timeline) totalChars += this.entryCharSize(entry);
    while (totalChars > MAX_TIMELINE_CHARS && this.timeline.length > 4) {
      const removed = this.timeline.shift();
      if (!removed) break;
      totalChars -= this.entryCharSize(removed);
    }
  }

  private shouldAnimate(): boolean {
    if (!this.started) return false;
    if (this.busy !== null || this.subagentActivity.size > 0) return true;
    if (this.networkGuard !== null && this.networkGuard.state !== "restored") {
      return true;
    }
    if (this.picker.open && this.picker.loading) return true;
    if (this.binaryMode === "off" || this.binaryMode === "busy") return false;
    if (this.outputExpanded) return false;
    if (this.binaryMode === "on") return true;
    // "eco" mode: flows on activity and rests after 3s idle
    return Date.now() - this.lastInteractionAt < IDLE_FLOW_GRACE_MS;
  }

  private syncFlowTimer(): void {
    if (!this.shouldAnimate()) {
      if (this.flowTimer) {
        clearInterval(this.flowTimer);
        this.flowTimer = null;
      }
      return;
    }
    if (this.flowTimer) return;
    this.flowTimer = setInterval(() => {
      if (!this.shouldAnimate()) {
        this.syncFlowTimer();
        return;
      }
      this.tick = (this.tick + 1) % 100_000;
      this.paint();
    }, FLOW_INTERVAL_MS);
    this.flowTimer.unref();
  }

  private onResize = (): void => {
    this.prevLines = [];
    // Line indices and frame cells change with the width, so an old selection would point elsewhere.
    this.selection = null;
    this.paint();
  };

  private schedule(): void {
    if (!this.started || this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      this.paint();
    }, 22);
  }

  private onData = (chunk: string | Buffer): void => {
    this.lastInteractionAt = Date.now();
    this.syncFlowTimer();
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    // A cooked line can still be queued in the tty when its read reaches the new listener.
    const first = this.firstInput;
    this.firstInput = false;
    this.handleText(first ? normalizeTypedAhead(text) : text);
  };

  private flushPasteBuffer(): void {
    if (this.pasteSafetyTimer) {
      clearTimeout(this.pasteSafetyTimer);
      this.pasteSafetyTimer = null;
    }
    const raw = decodeBracketedPasteText(this.pasteBuffer);
    this.pasteBuffer = "";
    this.pasteMode = false;
    if (!raw || isKlipperImagePlaceholder(raw)) {
      if (
        !this.picker.open &&
        !this.sessionPicker.open &&
        !this.outputExpanded
      ) {
        void this.pasteFromClipboard(true);
        return;
      }
      this.paint();
      return;
    }
    if (this.picker.open) {
      this.handlePickerPlain(raw.replace(/\s+/g, " "));
      return;
    }
    if (this.sessionPicker.open) {
      this.handleSessionPickerPlain(raw.replace(/\s+/g, " "));
      return;
    }
    // Check if the user pasted a local image file path / URI
    const pathImg = tryLoadImageFromPathText(raw, this.cwd);
    if (pathImg) {
      this.stageImageAttachment(pathImg);
      return;
    }
    this.insertText(raw, true);
    this.syncPalette();
    this.paint();
  }

  private armPasteSafetyTimer(): void {
    if (this.pasteSafetyTimer) clearTimeout(this.pasteSafetyTimer);
    this.pasteSafetyTimer = setTimeout(() => {
      if (this.pasteMode) {
        this.flushPasteBuffer();
      }
    }, PASTE_SAFETY_TIMEOUT_MS);
    this.pasteSafetyTimer.unref?.();
  }

  private clearEscCarryTimer(): void {
    if (this.escCarryTimer) {
      clearTimeout(this.escCarryTimer);
      this.escCarryTimer = null;
    }
  }

  /**
   * Incomplete escape sequences wait briefly for the next chunk. Only a lone Esc
   * becomes a key when the wait expires.
   */
  private handleText(input: string): void {
    let text = input;
    if (this.escCarry && !this.pasteMode) {
      if (input !== "\x03") text = this.escCarry + text;
      this.escCarry = "";
    }
    this.clearEscCarryTimer();
    while (text.length > 0) {
      if (this.pasteMode) {
        const close = `${ESC}201~`;
        // Only the end of the previous chunk can contain the start of a split marker.
        const boundary = Math.max(0, this.pasteBuffer.length - close.length + 1);
        const joined = this.pasteBuffer.slice(boundary) + text;
        const end = joined.indexOf(close);
        if (end < 0) {
          this.pasteBuffer += text;
          this.armPasteSafetyTimer();
          return;
        }
        this.pasteBuffer = this.pasteBuffer.slice(0, boundary) + joined.slice(0, end);
        text = joined.slice(end + close.length);
        this.flushPasteBuffer();
        continue;
      }

      const paste = text.indexOf(`${ESC}200~`);
      if (paste === 0) {
        this.pasteMode = true;
        this.armPasteSafetyTimer();
        text = text.slice(6);
        continue;
      }
      if (paste > 0) {
        this.handleText(text.slice(0, paste));
        text = text.slice(paste);
        continue;
      }

      // SGR Mouse events: \x1b[<btn;col;rowM or \x1b[<btn;col;rowm
      const sgrMouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text);
      if (sgrMouse) {
        const btn = Number(sgrMouse[1]);
        const col1Based = Number(sgrMouse[2]);
        const row1Based = Number(sgrMouse[3]);
        const isRelease = sgrMouse[4] === "m";
        this.handleSgrMouse(btn, col1Based, row1Based, isRelease);
        text = text.slice(sgrMouse[0].length);
        continue;
      }

      // Coalesced vertical arrow bursts (e.g. terminal alternate-scroll wheel bursts)
      // must scroll the chat timeline instead of triggering composer input history.
      const arrowBurst = /^(?:(?:\x1b\[[AB]|\x1bO[AB]){2,})/.exec(text);
      if (arrowBurst) {
        const seqs =
          arrowBurst[0].match(/\x1b\[[AB]|\x1bO[AB]/g) ?? [];
        let netUp = 0;
        for (const s of seqs) {
          if (s.endsWith("A")) netUp += 1;
          else netUp -= 1;
        }
        if (netUp !== 0) {
          this.scrollByWheel(netUp * 2);
        }
        text = text.slice(arrowBurst[0].length);
        continue;
      }

      if (text.startsWith("\x1b")) {
        // Alt+Up / Alt+Down (two-ESC prefix in some terminals)
        if (text.startsWith("\x1b\x1b[A") || text.startsWith("\x1b\x1bOA")) {
          this.handleKey("\x1b[1;3A");
          text = text.slice(4);
          continue;
        }
        if (text.startsWith("\x1b\x1b[B") || text.startsWith("\x1b\x1bOB")) {
          this.handleKey("\x1b[1;3B");
          text = text.slice(4);
          continue;
        }
        // Alt+Enter / Alt+Backspace / Alt+b / Alt+f / Alt+m / Alt+s / Alt+r / Alt+v
        if (text.startsWith("\x1b\r") || text.startsWith("\x1b\n")) {
          this.handleKey("\x1b\r");
          text = text.slice(2);
          continue;
        }
        if (text.startsWith("\x1b\x7f") || text.startsWith("\x1b\b")) {
          this.handleKey("\x1b\x7f");
          text = text.slice(2);
          continue;
        }
        if (/^\x1b[bcCfeEmMsSrRvV]/.test(text)) {
          this.handleKey(text.slice(0, 2).toLowerCase());
          text = text.slice(2);
          continue;
        }
        const match = /^\x1b(?:\[\[?[0-9;?<]*[A-Za-z~]|O[A-Za-z])/.exec(text);
        if (match) {
          this.handleKey(match[0]);
          text = text.slice(match[0].length);
          continue;
        }
        if (/^\x1b(?:\x1b)?(?:\[\[?[0-9;?<]*|O)?$/.test(text)) {
          this.escCarry = text;
          this.escCarryTimer = setTimeout(() => {
            this.escCarryTimer = null;
            const carried = this.escCarry;
            this.escCarry = "";
            if (carried === "\x1b") this.handleKey(carried);
          }, ESC_SEQUENCE_WAIT_MS);
          this.escCarryTimer.unref?.();
          return;
        }
        this.handleKey("\x1b");
        text = text.slice(1);
        continue;
      }
      const control = /^[\x00-\x1f\x7f]/.exec(text);
      if (control) {
        this.handleKey(control[0]);
        text = text.slice(1);
        continue;
      }
      const next = text.search(/[\x1b\x00-\x1f\x7f]/);
      const plain = next < 0 ? text : text.slice(0, next);
      this.handlePlain(plain);
      text = next < 0 ? "" : text.slice(next);
    }
  }

  private scrollByWheel(deltaUpLines: number): void {
    if (this.picker.open) {
      const rows = this.pickerRows();
      if (rows.length > 0) {
        this.picker.selectedRow = Math.max(
          0,
          Math.min(rows.length - 1, this.picker.selectedRow - deltaUpLines),
        );
      }
      this.paint();
      return;
    }
    if (this.sessionPicker.open) {
      const rows = this.filteredSessionPickerRows();
      if (rows.length > 0) {
        this.sessionPicker.selectedRow = Math.max(
          0,
          Math.min(
            rows.length - 1,
            this.sessionPicker.selectedRow - deltaUpLines,
          ),
        );
      }
      this.paint();
      return;
    }
    if (this.outputExpanded) {
      this.outputScroll = Math.max(0, this.outputScroll - deltaUpLines);
      this.paint();
      return;
    }
    this.scroll = Math.max(0, this.scroll + deltaUpLines);
    this.paint();
  }

  private handleSgrMouse(
    btn: number,
    col1Based: number,
    row1Based: number,
    isRelease: boolean,
  ): void {
    // Wheel Up (64) / Wheel Down (65)
    if ((btn & 64) === 64) {
      const buttonCode = btn & 3;
      if (buttonCode === 0) {
        // Wheel Up -> scroll up into older messages
        this.scrollByWheel(3);
      } else if (buttonCode === 1) {
        // Wheel Down -> scroll down toward latest messages
        this.scrollByWheel(-3);
      }
      return;
    }

    const isMotion = (btn & 32) === 32;
    const baseBtn = btn & 3;

    // Allow left-clicking rows inside the interactive Session Picker modal
    if (this.sessionPicker.open) {
      if (!isRelease && !isMotion && baseBtn === 0) {
        const rowsCount = this.rows();
        const previewRows = rowsCount >= 14 ? 4 : 0;
        const listHeight = Math.max(
          2,
          rowsCount - 3 - (previewRows > 0 ? previewRows + 1 : 0) - 2,
        );
        const filtered = this.filteredSessionPickerRows();
        const selIdx =
          filtered.length > 0
            ? Math.min(
                Math.max(0, this.sessionPicker.selectedRow),
                filtered.length - 1,
              )
            : 0;
        const windowStart = Math.max(
          0,
          Math.min(
            Math.max(0, filtered.length - listHeight),
            selIdx - Math.floor(listHeight / 2),
          ),
        );
        const listRowIdx = row1Based - 4; // rows 1..3 are header + search + divider
        if (listRowIdx >= 0 && listRowIdx < listHeight) {
          const clickedIdx = windowStart + listRowIdx;
          const chosen = filtered[clickedIdx];
          if (chosen) {
            if (this.sessionPicker.selectedRow === clickedIdx) {
              this.closeSessionPicker();
              this.options.onSubmit(`/resume ${chosen.id}`);
            } else {
              this.sessionPicker.selectedRow = clickedIdx;
              this.paint();
            }
          }
        }
      }
      return;
    }

    if (this.picker.open || this.outputExpanded)
      return;

    if (baseBtn !== 0) return;
    const row0 = row1Based - 1;
    const col0 = col1Based - 1;

    // Left press: Ctrl+click opens a link; otherwise start a (word/line) selection.
    if (!isRelease && !isMotion) {
      const link = linkAt(this.frameLinks.get(row0), col0);
      if (link && (btn & 16) === 16) {
        this.clickCounter.reset();
        this.pendingPlainLink = null;
        this.openLink(link.url);
        return;
      }
      this.pendingPlainLink = link?.osc8 ? link.url : null;
      const hit = this.selectionHit(row0, col0);
      if (!hit) {
        if (this.selection) {
          this.selection = null;
          this.paint();
        }
        return;
      }
      const clicks = this.clickCounter.press(row0, col0, Date.now());
      let from = hit.col;
      let to = hit.col;
      let mode: ViewportSelection["mode"] = "char";
      if (clicks > 1) {
        const plain = this.selectionLinePlain(hit.region, hit.line);
        const range = clicks === 2 ? wordRangeAt(plain, hit.col) : lineRange(plain);
        if (range) {
          from = range.from;
          to = range.to;
          mode = clicks === 2 ? "word" : "line";
        }
      }
      this.selection = {
        region: hit.region,
        startLineIdx: hit.line,
        startCol: from,
        endLineIdx: hit.line,
        endCol: to,
        dragging: true,
        mode,
      };
      this.paint();
      return;
    }

    if (isMotion) {
      const sel = this.selection;
      if (!sel?.dragging || sel.mode !== "char") return;
      this.pendingPlainLink = null;
      if (sel.region === "transcript") {
        const layout = this.lastViewportLayout;
        if (layout.lines.length === 0) return;
        const relRow = row0 - VIEWPORT_TOP_ROW;
        // Dragging past the top/bottom edge scrolls the transcript.
        if (relRow < 0) {
          this.scroll = Math.min(Math.max(0, layout.lines.length - layout.height), this.scroll + 1);
        } else if (relRow >= layout.height) {
          this.scroll = Math.max(0, this.scroll - 1);
        }
        const clampedRow = Math.max(0, Math.min(layout.height - 1, relRow));
        sel.endLineIdx = Math.max(0, Math.min(layout.lines.length - 1, layout.startLine + clampedRow));
        sel.endCol = Math.max(0, Math.min(layout.leftCellWidth, col0 - VIEWPORT_LEFT_COL));
      } else {
        const region = this.frameRegions[sel.region];
        if (!region) return;
        sel.endLineIdx = Math.max(region.top, Math.min(region.top + region.height - 1, row0));
        sel.endCol = Math.max(0, Math.min(region.width, col0 - region.left));
      }
      this.paint();
      return;
    }

    // Release: copy a real selection (and keep it highlighted); a plain click on an OSC 8 link opens it.
    const plainLink = this.pendingPlainLink;
    this.pendingPlainLink = null;
    if (this.selection) {
      this.selection.dragging = false;
      if (this.hasActiveSelection()) {
        const selected = this.extractSelectedText();
        if (selected.trim().length > 0) {
          this.writeToClipboard(selected);
          this.setClipboardNotice(
            (t) => t("clipboard.selection", { count: selected.length }),
          );
        }
      } else {
        this.selection = null;
      }
    }
    if (plainLink && !this.hasActiveSelection()) this.openLink(plainLink);
    this.paint();
  }

  /** Which selectable region a frame cell belongs to, as a selection point in that region. */
  private selectionHit(row0: number, col0: number): { region: SelectionRegion; line: number; col: number } | null {
    const layout = this.lastViewportLayout;
    const relRow = row0 - VIEWPORT_TOP_ROW;
    if (
      relRow >= 0 &&
      relRow < layout.height &&
      col0 >= VIEWPORT_LEFT_COL - 1 &&
      col0 <= layout.leftCellWidth + VIEWPORT_LEFT_COL &&
      layout.lines.length > 0
    ) {
      return {
        region: "transcript",
        line: Math.max(0, Math.min(layout.lines.length - 1, layout.startLine + relRow)),
        col: Math.max(0, Math.min(layout.leftCellWidth, col0 - VIEWPORT_LEFT_COL)),
      };
    }
    for (const region of ["hud", "composer"] as const) {
      const area = this.frameRegions[region];
      if (!area) continue;
      if (row0 >= area.top && row0 < area.top + area.height && col0 >= area.left - 1 && col0 <= area.left + area.width) {
        return { region, line: row0, col: Math.max(0, Math.min(area.width, col0 - area.left)) };
      }
    }
    return null;
  }

  /** Plain text of one selectable line (transcript line or region slice of a frame row). */
  private selectionLinePlain(region: SelectionRegion, line: number): string {
    if (region === "transcript") return stripAnsi(this.lastViewportLayout.lines[line] ?? "");
    const area = this.frameRegions[region];
    return area ? slicePlainByVisualCols(this.lastFrameLines[line] ?? "", area.left, area.left + area.width) : "";
  }

  /** Frame cells covered by the active selection in the frame being built. */
  private selectionScreenSpans(frame: readonly string[]): RowSpan[] {
    const norm = this.normalizedSelection();
    const sel = this.selection;
    if (!norm || !sel) return [];
    if (sel.region === "transcript") {
      const layout = this.lastViewportLayout;
      return selectionRowSpans(
        norm,
        { firstLine: layout.startLine, height: layout.height, rowOffset: VIEWPORT_TOP_ROW, colOffset: VIEWPORT_LEFT_COL, width: layout.leftCellWidth },
        (line) => visibleWidth(layout.lines[line] ?? ""),
      );
    }
    const area = this.frameRegions[sel.region];
    if (!area) return [];
    return selectionRowSpans(
      norm,
      { firstLine: area.top, height: area.height, rowOffset: area.top, colOffset: area.left, width: area.width },
      (row) => visibleWidth(slicePlainByVisualCols(frame[row] ?? "", area.left, area.left + area.width).trimEnd()),
    );
  }

  private openLink(url: string): void {
    const shown = truncateAnsi(url, 64);
    this.setClipboardNotice((t) => t("link.opening", { url: shown }));
    if (this.options.onOpenUrl) {
      this.options.onOpenUrl(url);
      return;
    }
    void import("./opener.js")
      .then(({ openUrl }) => openUrl(url))
      .then((result) => {
        if (!result.ok) this.setClipboardNotice((t) => t("link.failed", { url: shown }));
      })
      .catch(() => {});
  }

  private hasActiveSelection(): boolean {
    if (!this.selection) return false;
    return (
      this.selection.startLineIdx !== this.selection.endLineIdx ||
      this.selection.startCol !== this.selection.endCol
    );
  }

  private normalizedSelection(): {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  } | null {
    if (!this.selection || !this.hasActiveSelection()) return null;
    const { startLineIdx, startCol, endLineIdx, endCol } = this.selection;
    if (
      startLineIdx < endLineIdx ||
      (startLineIdx === endLineIdx && startCol <= endCol)
    ) {
      return {
        startLine: startLineIdx,
        startCol,
        endLine: endLineIdx,
        endCol,
      };
    }
    return {
      startLine: endLineIdx,
      startCol: endCol,
      endLine: startLineIdx,
      endCol: startCol,
    };
  }

  extractSelectedText(): string {
    const norm = this.normalizedSelection();
    const sel = this.selection;
    if (!norm || !sel) return "";
    const area = sel.region === "transcript" ? null : this.frameRegions[sel.region];
    const lines = area ? this.lastFrameLines : this.lastViewportLayout.lines;
    if (lines.length === 0 || (sel.region !== "transcript" && !area)) return "";
    const offset = area?.left ?? 0;
    const out: string[] = [];
    for (let idx = norm.startLine; idx <= norm.endLine; idx += 1) {
      const line = lines[idx];
      if (line === undefined) continue;
      const maxCol = area ? area.width : visibleWidth(line);
      const fromCol = idx === norm.startLine ? norm.startCol : 0;
      const toCol = idx === norm.endLine ? norm.endCol : maxCol;
      out.push(slicePlainByVisualCols(line, offset + fromCol, offset + Math.min(maxCol, toCol)).trimEnd());
    }
    return out.join("\n").trim();
  }

  private writeToClipboard(text: string): void {
    if (!text) return;
    if (this.options.onCopyText) {
      this.options.onCopyText(text);
      return;
    }
    copyTextToClipboard(text, (osc) => {
      if (this.started && this.stdout.isTTY) {
        this.stdout.write(osc);
      }
    });
  }

  private copySelectionOrLastOutput(): void {
    if (this.hasActiveSelection()) {
      const selected = this.extractSelectedText();
      this.selection = null;
      if (selected) {
        this.writeToClipboard(selected);
        this.setClipboardNotice(
          (t) => t("clipboard.selection", { count: selected.length }),
        );
      }
      this.paint();
      return;
    }
    for (let i = this.timeline.length - 1; i >= 0; i -= 1) {
      const entry = this.timeline[i]!;
      if (entry.kind === "assistant" && entry.text.trim()) {
        const plain = stripAnsi(entry.text).trim();
        this.writeToClipboard(plain);
        this.setClipboardNotice(
          (t) => t("clipboard.answer", { count: plain.length }),
        );
        this.paint();
        return;
      }
    }
    if (this.output.text.trim()) {
      const plain = stripAnsi(this.output.text).trim();
      this.writeToClipboard(plain);
      this.setClipboardNotice(
        (t) => t("clipboard.output", { count: plain.length }),
      );
      this.paint();
    }
  }

  private async pasteFromClipboard(preferImage: boolean): Promise<void> {
    try {
      if (preferImage) {
        const img = this.options.onClipboardImage
          ? await this.options.onClipboardImage()
          : await readImageFromClipboard(this.cwd);
        if (img) {
          this.stageImageAttachment(img);
          return;
        }
      }
      const clipText = this.options.onClipboardText
        ? await this.options.onClipboardText()
        : await readTextFromClipboard();
      if (clipText) {
        const decoded = decodeBracketedPasteText(clipText);
        if (isKlipperImagePlaceholder(decoded)) {
          const klipperImg = this.options.onClipboardImage
            ? await this.options.onClipboardImage()
            : await readImageFromClipboard(this.cwd);
          if (klipperImg) {
            this.stageImageAttachment(klipperImg);
          }
          return;
        }
        if (preferImage) {
          const pathImg = tryLoadImageFromPathText(decoded, this.cwd);
          if (pathImg) {
            this.stageImageAttachment(pathImg);
            return;
          }
        }
        if (this.picker.open) {
          this.handlePickerPlain(decoded.replace(/\s+/g, " "));
        } else if (this.sessionPicker.open) {
          this.handleSessionPickerPlain(decoded.replace(/\s+/g, " "));
        } else {
          this.insertText(decoded, true);
          this.syncPalette();
          this.paint();
        }
        return;
      }
      if (!preferImage) {
        const fallbackImg = this.options.onClipboardImage
          ? await this.options.onClipboardImage()
          : await readImageFromClipboard(this.cwd);
        if (fallbackImg) {
          this.stageImageAttachment(fallbackImg);
          return;
        }
      }
      this.setClipboardNotice((t) => t("clipboard.empty"));
      this.paint();
    } catch {
      // Ignore clipboard read errors
    }
  }

  private dequeueSteerIntoComposer(): boolean {
    if (!this.options.onDequeueSteer || this.queuedSteers.length === 0) {
      return false;
    }
    const popped = this.options.onDequeueSteer();
    if (!popped) return false;
    this.composer = this.composer
      ? `${this.composer} ${popped.text}`
      : popped.text;
    this.cursor = this.composer.length;
    this.syncPalette();
    this.paint();
    return true;
  }

  private handlePlain(text: string): void {
    if (!text) return;
    if (this.picker.open) {
      this.handlePickerPlain(text);
      return;
    }
    if (this.sessionPicker.open) {
      this.handleSessionPickerPlain(text);
      return;
    }
    if (this.outputExpanded) {
      this.handleOutputPlainKey(text);
      return;
    }
    this.ctrlCArmedUntil = 0;
    this.insertText(text, false);
    this.syncPalette();
    this.paint();
  }

  private insertText(raw: string, allowNewlines: boolean): void {
    const clean = sanitizeText(raw);
    const normalized = allowNewlines ? clean : clean.replace(/\n+/g, " ");
    if (!normalized) return;
    this.composer = `${this.composer.slice(0, this.cursor)}${normalized}${this.composer.slice(this.cursor)}`;
    this.cursor += normalized.length;
    this.historyIndex = -1;
  }

  private handleKey(sequence: string): void {
    if (this.picker.open) {
      this.handlePickerKey(sequence);
      return;
    }
    if (this.sessionPicker.open) {
      this.handleSessionPickerKey(sequence);
      return;
    }
    if (this.outputExpanded) {
      this.handleOutputKey(sequence);
      return;
    }

    if (sequence !== "\x03") {
      this.ctrlCArmedUntil = 0;
    }

    switch (sequence) {
      case "\r":
        this.submit();
        return;
      case "\x16": // Ctrl+V (smart paste: image attachment first, else text)
      case "\x1b[118;5u":
      case "\x1b[86;5u":
      case "\x1b[27;5;118~":
      case "\x1b[27;5;86~":
        void this.pasteFromClipboard(true);
        return;
      case "\x1b[2;2~": // Shift+Insert (classic text paste)
        void this.pasteFromClipboard(false);
        return;
      case "\x1b[2;5~": // Ctrl+Insert (classic copy)
        this.copySelectionOrLastOutput();
        return;
      case "\x1bv": // Alt+V / Ctrl+Shift+V (text paste)
      case "\x1b[118;6u":
      case "\x1b[86;6u":
      case "\x1b[27;6;118~":
      case "\x1b[27;6;86~":
        void this.pasteFromClipboard(false);
        return;
      case "\x1b[99;6u": // Ctrl+Shift+C (copy selection or latest assistant output)
      case "\x1b[67;6u":
      case "\x1b[27;6;99~":
      case "\x1b[27;6;67~":
        this.copySelectionOrLastOutput();
        return;
      case "\x1b[1;3A": // Alt+Up: dequeue last steering message back into composer
        if (this.dequeueSteerIntoComposer()) return;
        this.scroll += 3;
        break;
      case "\x1b[1;3B": // Alt+Down
        this.scroll = Math.max(0, this.scroll - 3);
        break;
      case "\x1bm": // Alt+M
      case "\x1bOQ": // F2
      case "\x1b[12~":
      case "\x1b[[B":
        this.options.onOpenModelPicker?.();
        return;
      case "\x1be": // Alt+E
        this.options.onOpenEffortPicker?.();
        return;
      case "\x1bc": // Alt+C
        this.options.onOpenCompactionModelPicker?.();
        return;
      case "\x1bs": // Alt+S: quick screenshot / binary visual forensics heatmap
        this.options.onSubmit(
          this.status.target ? "/screenshot binary" : "/screenshot",
        );
        return;
      case "\n": // Ctrl+J inserts newline in raw TTY
      case "\x1b\r": // Alt+Enter
      case "\x1b[13;2u": // Shift+Enter (kitty / Ghostty / WezTerm)
      case "\x1b[27;2;13~": // Shift+Enter (xterm modifyOtherKeys)
        this.insertText("\n", true);
        this.paletteOpen = false;
        break;
      case "\t":
        this.handleTab();
        return;
      case "\x1b[Z": // Shift+Tab
        if (this.paletteOpen) this.movePalette(-1);
        return;
      case "\x7f": // Backspace
        this.deleteBefore();
        break;
      case "\x1b[3~":
        this.deleteAfter();
        break;
      case "\x1b[A": // Up
      case "\x1bOA":
        if (this.paletteOpen) {
          this.movePalette(-1);
          return;
        }
        if (this.moveCursorVertical(-1)) break;
        if (this.scroll > 0 && this.composer.length === 0) {
          this.scroll += 1;
          break;
        }
        this.moveHistory(-1);
        break;
      case "\x1b[B": // Down
      case "\x1bOB":
        if (this.paletteOpen) {
          this.movePalette(1);
          return;
        }
        if (this.moveCursorVertical(1)) break;
        if (this.scroll > 0 && this.composer.length === 0) {
          this.scroll = Math.max(0, this.scroll - 1);
          break;
        }
        this.moveHistory(1);
        break;
      case "\x1b[C": {
        // Right (accepts inline ghost completion when at end of slash input)
        if (
          this.cursor === this.composer.length &&
          this.ghostCompletionSuffix().length > 0
        ) {
          this.completePalette();
          return;
        }
        this.cursor = nextCodePointIndex(this.composer, this.cursor);
        break;
      }
      case "\x1b[D": // Left
        this.cursor = prevCodePointIndex(this.composer, this.cursor);
        break;
      case "\x1b[1;5D": // Ctrl+Left
      case "\x1b[1;3D": // Alt+Left
      case "\x1bb":
        this.moveWordLeft();
        break;
      case "\x1b[1;5C": // Ctrl+Right
      case "\x1b[1;3C": // Alt+Right
      case "\x1bf":
        this.moveWordRight();
        break;
      case "\x1b[H":
      case "\x1b[1~":
      case "\x01": // Ctrl+A
        this.moveLineStart();
        break;
      case "\x1b[F":
      case "\x1b[4~":
      case "\x05": // Ctrl+E
        this.moveLineEnd();
        break;
      case "\x1b[5~": // PgUp
      case "\x1b[1;5A": // Ctrl+Up
        this.scroll += Math.max(2, this.rows() - 10);
        break;
      case "\x1b[6~": // PgDn
      case "\x1b[1;5B": // Ctrl+Down
        this.scroll = Math.max(0, this.scroll - Math.max(2, this.rows() - 10));
        break;
      case "\x1b": // Esc
        if (this.hasActiveSelection()) {
          this.selection = null;
        } else if (this.paletteOpen) {
          this.paletteOpen = false;
        } else if (this.outputDrawerOpen) {
          this.outputDrawerOpen = false;
        } else if (this.busy) {
          this.options.onInterrupt();
          return;
        }
        break;
      case "\x0b": // Ctrl+K: open command palette when empty, else kill to EOL
        if (this.composer.length === 0) {
          this.composer = "/";
          this.cursor = 1;
          this.syncPalette();
        } else {
          const nl = this.composer.indexOf("\n", this.cursor);
          this.composer =
            nl >= 0
              ? `${this.composer.slice(0, this.cursor)}${this.composer.slice(nl)}`
              : this.composer.slice(0, this.cursor);
          this.syncPalette();
        }
        break;
      case "\x15": // Ctrl+U: clear before cursor
        this.composer = this.composer.slice(this.cursor);
        this.cursor = 0;
        this.syncPalette();
        break;
      case "\x17": // Ctrl+W
      case "\x1b\x7f": // Alt+Backspace
      case "\b": // Ctrl+Backspace (BS) in most terminals; each key repeat deletes one more word
      case "\x1b[127;5u": // Ctrl+Backspace: kitty / WezTerm / foot
      case "\x1b[8;5u":
      case "\x1b[27;5;127~": // Ctrl+Backspace: xterm modifyOtherKeys
      case "\x1b[27;5;8~":
        this.deleteWord();
        break;
      case "\x02": // Ctrl+B: toggle live binary flow mode
        this.setBinaryMode();
        return;
      case "\x0c": // Ctrl+L: hard repaint
        this.prevLines = [];
        this.stdout.write(`${ESC}2J${ESC}H`);
        break;
      case "\x0f": // Ctrl+O: expand/collapse output inspector
        if (this.output.text) {
          this.outputExpanded = true;
          this.outputScroll = 0;
        }
        break;
      case "\x03": // Ctrl+C
        if (this.hasActiveSelection()) {
          this.copySelectionOrLastOutput();
          return;
        }
        if (this.busy) {
          this.options.onInterrupt();
          return;
        }
        if (this.paletteOpen) {
          this.paletteOpen = false;
          this.composer = "";
          this.cursor = 0;
          break;
        }
        if (this.composer.length > 0) {
          this.composer = "";
          this.cursor = 0;
          break;
        }
        if (Date.now() < this.ctrlCArmedUntil) {
          this.options.onExit();
          return;
        }
        this.ctrlCArmedUntil = Date.now() + 2200;
        break;
      case "\x04": // Ctrl+D
        if (this.composer.length === 0) {
          this.options.onExit();
          return;
        }
        this.deleteAfter();
        break;
      default:
        return;
    }
    this.paint();
  }

  private handleOutputKey(sequence: string): void {
    const pageStep = Math.max(2, this.rows() - 6);
    switch (sequence) {
      case "\x1b":
      case "\x0f":
      case "\x03":
        this.outputExpanded = false;
        break;
      case "\x1b[A":
        this.outputScroll = Math.max(0, this.outputScroll - 1);
        break;
      case "\x1b[B":
        this.outputScroll += 1;
        break;
      case "\x1b[5~":
        this.outputScroll = Math.max(0, this.outputScroll - pageStep);
        break;
      case "\x1b[6~":
        this.outputScroll += pageStep;
        break;
      case "\x1b[H":
      case "\x1b[1~":
        this.outputScroll = 0;
        break;
      case "\x1b[F":
      case "\x1b[4~":
        this.outputScroll = 1_000_000;
        break;
      default:
        return;
    }
    this.paint();
  }

  private handleOutputPlainKey(text: string): void {
    const pageStep = Math.max(2, this.rows() - 6);
    for (const ch of text) {
      if (ch === "q") this.outputExpanded = false;
      else if (ch === "j") this.outputScroll += 1;
      else if (ch === "k")
        this.outputScroll = Math.max(0, this.outputScroll - 1);
      else if (ch === " " || ch === "d") this.outputScroll += pageStep;
      else if (ch === "u")
        this.outputScroll = Math.max(0, this.outputScroll - pageStep);
      else if (ch === "g") this.outputScroll = 0;
      else if (ch === "G") this.outputScroll = 1_000_000;
    }
    this.paint();
  }

  private pickerTabs(): readonly PickerTab[] {
    const connected = this.picker.providers.filter(
      (p) => p.connected && !p.local,
    );
    const localConnected = this.picker.providers.filter(
      (p) => p.connected && p.local,
    );
    const localIdle = this.picker.providers.filter(
      (p) => !p.connected && p.local,
    );
    const unconnected = this.picker.providers.filter(
      (p) => !p.connected && !p.local,
    );
    const ordered = [
      ...connected,
      ...localConnected,
      ...localIdle,
      ...unconnected,
    ];

    const connectedPool = this.picker.providers.filter((p) => p.connected);
    const allCount = connectedPool.reduce((acc, p) => acc + p.models.length, 0);

    const tabs: PickerTab[] = [
      {
        id: "all",
        label: this.i18n.t("picker.all"),
        connected: connectedPool.length > 0,
        local: false,
        modelCount: allCount,
      },
    ];
    for (const p of ordered) {
      tabs.push({
        id: p.id,
        label: p.name,
        connected: p.connected,
        local: p.local,
        modelCount: p.models.length,
        provider: p,
      });
    }
    return tabs;
  }

  private pickerRows(): readonly PickerModelRow[] {
    const tabs = this.pickerTabs();
    const tab = tabs[this.picker.selectedTab] ?? tabs[0];
    if (!tab) return [];

    let pool: readonly ResolvedProvider[];
    if (tab.id === "all") {
      const conn = this.picker.providers.filter((p) => p.connected);
      pool = conn.length > 0 ? conn : this.picker.providers;
    } else {
      pool = tab.provider ? [tab.provider] : [];
    }

    const rawQuery = this.picker.query.trim();
    const tokens = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);

    const isCompactionPicker = this.picker.purpose === "compaction";
    const compactSpecLower =
      this.picker.compactionModelSpec?.toLowerCase() ?? null;

    const scored: Array<{ score: number; row: PickerModelRow }> = [];
    for (const provider of pool) {
      for (const m of provider.models) {
        const fullSpecLower = `${provider.id}:${m.id}`.toLowerCase();
        const active = isCompactionPicker
          ? Boolean(
              compactSpecLower &&
              (compactSpecLower === fullSpecLower ||
                compactSpecLower === m.id.toLowerCase()),
            )
          : provider.id === this.picker.activeProviderId &&
            m.id === this.picker.activeModelId;
        const hay =
          `${provider.id} ${provider.name} ${m.id} ${m.note ?? ""}`.toLowerCase();
        if (tokens.length > 0 && !tokens.every((tok) => hay.includes(tok)))
          continue;

        let score = active
          ? 2000
          : provider.connected
            ? 400
            : provider.local
              ? 200
              : 50;
        if (m.source === "configured") score += 120;
        else if (m.source === "live") score += 60;
        if (tokens.length > 0) {
          const first = tokens[0]!;
          if (m.id.toLowerCase() === rawQuery.toLowerCase()) score += 1500;
          else if (m.id.toLowerCase().startsWith(first)) score += 600;
          else if (provider.id.startsWith(first)) score += 300;
        }
        scored.push({
          score,
          row: {
            provider,
            modelId: m.id,
            ...(m.note ? { note: m.note } : {}),
            source: m.source,
            active,
          },
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const rows = scored.map((s) => s.row);

    if (isCompactionPicker && tab.id === "all") {
      const activeProv =
        this.picker.providers.find(
          (p) => p.id === this.picker.activeProviderId,
        ) ??
        this.picker.providers.find((p) => p.connected) ??
        this.picker.providers[0];
      const inheritLabel = this.i18n.t("picker.activeLabel", {
        model: `${this.picker.activeProviderId ? `${this.picker.activeProviderId}:` : ""}${this.picker.activeModelId || this.i18n.t("picker.primary")}`,
      });
      if (
        activeProv &&
        (tokens.length === 0 ||
          tokens.every((tok) =>
            this.i18n.t("picker.activeDefault", { model: inheritLabel })
              .toLowerCase()
              .includes(tok),
          ))
      ) {
        rows.unshift({
          provider: activeProv,
          modelId: inheritLabel,
          source: "inherit-active",
          active: !this.picker.compactionModelSpec,
        });
      }
    }

    // Allow typing any arbitrary / brand-new model ID (or `provider:model`) directly!
    if (rawQuery.length > 0 && !/\s/.test(rawQuery)) {
      let targetProvider: ResolvedProvider | undefined = tab.provider;
      let candidateModel = rawQuery;
      const colon = rawQuery.indexOf(":");
      if (colon > 0) {
        const prefix = rawQuery.slice(0, colon).toLowerCase();
        const rest = rawQuery.slice(colon + 1).trim();
        const byPrefix = this.picker.providers.find((p) => p.id === prefix);
        if (byPrefix && rest) {
          targetProvider = byPrefix;
          candidateModel = rest;
        }
      }
      if (!targetProvider) {
        targetProvider =
          this.picker.providers.find(
            (p) =>
              p.id === this.picker.activeProviderId && (p.connected || p.local),
          ) ?? this.picker.providers.find((p) => p.connected || p.local);
      }
      if (
        targetProvider &&
        (targetProvider.connected || targetProvider.local) &&
        candidateModel.length > 0 &&
        !rows.some(
          (r) =>
            r.provider.id === targetProvider!.id &&
            r.modelId.toLowerCase() === candidateModel.toLowerCase(),
        )
      ) {
        rows.push({
          provider: targetProvider,
          modelId: candidateModel,
          source: "custom-input",
          active: false,
        });
      }
    }

    return rows;
  }

  private handlePickerPlain(text: string): void {
    const clean = sanitizeText(text).replace(/[\r\n\t]+/g, "");
    if (!clean) return;
    if (this.picker.stage === "effort") {
      for (const ch of clean) {
        const digit = Number(ch);
        if (digit >= 1 && digit <= REASONING_EFFORT_LEVELS.length) {
          this.picker.selectedEffortIndex = digit - 1;
        }
      }
      this.paint();
      return;
    }
    this.picker.query += clean;
    this.picker.selectedRow = 0;
    this.picker.notice = null;
    this.paint();
  }

  private handlePickerKey(sequence: string): void {
    if (this.picker.stage === "effort") {
      const count = REASONING_EFFORT_LEVELS.length;
      switch (sequence) {
        case "\x03":
        case "\x1be":
          this.closeModelPicker();
          return;
        case "\x1b":
        case "\x7f":
        case "\b":
          if (this.picker.effortOnly) {
            this.closeModelPicker();
          } else {
            this.picker.stage = "model";
            this.paint();
          }
          return;
        case "\r":
        case "\n":
          this.commitEffortSelection(false);
          return;
        case "\x13": // Ctrl+S
        case "\x1bs": // Alt+S
          this.commitEffortSelection(true);
          return;
        case "\t":
        case "\x1b[C":
        case "\x1b[B":
        case "\x0e":
          this.picker.selectedEffortIndex =
            (this.picker.selectedEffortIndex + 1) % count;
          this.paint();
          return;
        case "\x1b[Z":
        case "\x1b[D":
        case "\x1b[A":
        case "\x10":
          this.picker.selectedEffortIndex =
            (this.picker.selectedEffortIndex - 1 + count) % count;
          this.paint();
          return;
        case "\x1b[H":
        case "\x1b[1~":
          this.picker.selectedEffortIndex = 0;
          this.paint();
          return;
        case "\x1b[F":
        case "\x1b[4~":
          this.picker.selectedEffortIndex = count - 1;
          this.paint();
          return;
        default:
          return;
      }
    }

    const tabs = this.pickerTabs();
    const rows = this.pickerRows();
    const pageStep = Math.max(4, Math.floor((this.rows() - 8) * 0.75));

    const selectTab = (delta: number): void => {
      if (tabs.length === 0) return;
      this.picker.selectedTab =
        (this.picker.selectedTab + delta + tabs.length) % tabs.length;
      const nextRows = this.pickerRows();
      const activeIdx = nextRows.findIndex((r) => r.active);
      this.picker.selectedRow = activeIdx >= 0 ? activeIdx : 0;
      this.picker.notice = null;
    };

    switch (sequence) {
      case "\x1b":
      case "\x03":
      case "\x1bm":
      case "\x1bc":
      case "\x1bOQ":
      case "\x1b[12~":
      case "\x1b[[B":
        this.closeModelPicker();
        return;
      case "\x1be":
        if (this.picker.purpose === "compaction") return;
        this.picker.stage = "effort";
        this.picker.effortOnly = false;
        break;
      case "\r":
      case "\n":
        this.commitPickerSelection(false);
        return;
      case "\x13": // Ctrl+S
      case "\x1bs": // Alt+S
        this.commitPickerSelection(true);
        return;
      case "\x12": // Ctrl+R
      case "\x1br": // Alt+R
        this.picker.loading = true;
        this.picker.notice = (t) => t("picker.refreshing");
        this.syncFlowTimer();
        this.paint();
        this.options.onRefreshModels?.();
        return;
      case "\t":
      case "\x1b[C":
        selectTab(1);
        break;
      case "\x1b[Z":
      case "\x1b[D":
        selectTab(-1);
        break;
      case "\x1b[A":
      case "\x10": // Ctrl+P
        if (rows.length > 0) {
          this.picker.selectedRow =
            (this.picker.selectedRow - 1 + rows.length) % rows.length;
        }
        this.picker.notice = null;
        break;
      case "\x1b[B":
      case "\x0e": // Ctrl+N
        if (rows.length > 0) {
          this.picker.selectedRow = (this.picker.selectedRow + 1) % rows.length;
        }
        this.picker.notice = null;
        break;
      case "\x1b[5~": // PgUp
        this.picker.selectedRow = Math.max(
          0,
          this.picker.selectedRow - pageStep,
        );
        break;
      case "\x1b[6~": // PgDn
        this.picker.selectedRow = Math.min(
          Math.max(0, rows.length - 1),
          this.picker.selectedRow + pageStep,
        );
        break;
      case "\x1b[H":
      case "\x1b[1~":
        this.picker.selectedRow = 0;
        break;
      case "\x1b[F":
      case "\x1b[4~":
        this.picker.selectedRow = Math.max(0, rows.length - 1);
        break;
      case "\x7f":
        if (this.picker.query.length > 0) {
          const prev = prevCodePointIndex(
            this.picker.query,
            this.picker.query.length,
          );
          this.picker.query = this.picker.query.slice(0, prev);
          this.picker.selectedRow = 0;
          this.picker.notice = null;
        }
        break;
      case "\x15": // Ctrl+U
        this.picker.query = "";
        this.picker.selectedRow = 0;
        this.picker.notice = null;
        break;
      case "\x17": // Ctrl+W
      case "\x1b\x7f":
      case "\b": // Ctrl+Backspace
      case "\x1b[127;5u":
      case "\x1b[8;5u":
      case "\x1b[27;5;127~":
      case "\x1b[27;5;8~": {
        let idx = this.picker.query.length;
        while (idx > 0 && /\s/.test(this.picker.query[idx - 1]!)) idx -= 1;
        while (idx > 0 && !/\s/.test(this.picker.query[idx - 1]!)) idx -= 1;
        this.picker.query = this.picker.query.slice(0, idx);
        this.picker.selectedRow = 0;
        this.picker.notice = null;
        break;
      }
      case "\x0c": // Ctrl+L
        this.prevLines = [];
        this.stdout.write(`${ESC}2J${ESC}H`);
        break;
      default:
        return;
    }
    this.paint();
  }

  private commitPickerSelection(saveDefault: boolean): void {
    const rows = this.pickerRows();
    const selected = rows[this.picker.selectedRow];
    if (!selected) {
      const tab = this.pickerTabs()[this.picker.selectedTab];
      if (tab?.provider && !tab.provider.connected && !tab.provider.local) {
        const { envHint } = tab.provider;
        this.picker.notice = (t) => t("picker.needsKey", { key: envHint });
        this.paint();
      }
      return;
    }
    if (
      this.picker.purpose === "compaction" &&
      selected.source === "inherit-active"
    ) {
      this.picker.open = false;
      this.picker.loading = false;
      this.syncFlowTimer();
      this.options.onSelectCompactionModel?.(null, saveDefault);
      this.paint();
      return;
    }
    if (!selected.provider.connected && !selected.provider.local) {
      this.picker.notice = (t) => t("picker.needsProviderKey", { key: selected.provider.envHint, provider: selected.provider.name });
      this.paint();
      return;
    }
    if (!selected.provider.baseUrl) {
      this.picker.notice = (t) => t("picker.needsUrl", { key: selected.provider.envHint });
      this.paint();
      return;
    }
    if (this.picker.purpose === "compaction") {
      this.picker.open = false;
      this.picker.loading = false;
      this.syncFlowTimer();
      this.options.onSelectCompactionModel?.(
        `${selected.provider.id}:${selected.modelId}`,
        saveDefault,
      );
      this.paint();
      return;
    }
    // Step 2 (omp-style): reveal bottom Thinking / Reasoning Effort selector before applying!
    this.picker.pendingProviderId = selected.provider.id;
    this.picker.pendingModelId = selected.modelId;
    this.picker.pendingSaveDefault = saveDefault;
    this.picker.stage = "effort";
    this.picker.effortOnly = false;
    this.picker.notice = null;
    this.paint();
  }

  private commitEffortSelection(saveDefault: boolean): void {
    const chosen =
      REASONING_EFFORT_LEVELS[this.picker.selectedEffortIndex]?.id ??
      this.status.effort;
    const finalSave = saveDefault || this.picker.pendingSaveDefault;
    const effortOnly = this.picker.effortOnly;
    const provId = this.picker.pendingProviderId;
    const modId = this.picker.pendingModelId;

    this.picker.open = false;
    this.picker.stage = "model";
    this.picker.effortOnly = false;
    this.picker.loading = false;
    this.syncFlowTimer();

    if (effortOnly || !provId || !modId) {
      this.options.onSelectEffort?.(chosen, finalSave);
    } else {
      this.options.onSelectModel?.(provId, modId, chosen, finalSave);
    }
    this.paint();
  }

  private deleteBefore(): void {
    if (this.cursor === 0) {
      if (this.composer.length === 0 && this.stagedImages.length > 0) {
        const removed = this.stagedImages.pop()!;
        this.setClipboardNotice((t) => t("clipboard.removed", { label: removed.label }));
      }
      return;
    }
    const prev = prevCodePointIndex(this.composer, this.cursor);
    this.composer =
      this.composer.slice(0, prev) + this.composer.slice(this.cursor);
    this.cursor = prev;
    this.syncPalette();
  }

  private deleteAfter(): void {
    if (this.cursor >= this.composer.length) return;
    const next = nextCodePointIndex(this.composer, this.cursor);
    this.composer =
      this.composer.slice(0, this.cursor) + this.composer.slice(next);
    this.syncPalette();
  }

  private moveWordLeft(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.composer[i - 1]!)) i -= 1;
    while (i > 0 && !/\s/.test(this.composer[i - 1]!)) i -= 1;
    this.cursor = i;
  }

  private moveWordRight(): void {
    let i = this.cursor;
    while (i < this.composer.length && /\s/.test(this.composer[i]!)) i += 1;
    while (i < this.composer.length && !/\s/.test(this.composer[i]!)) i += 1;
    this.cursor = i;
  }

  private moveLineStart(): void {
    const prevNl = this.composer.lastIndexOf(
      "\n",
      Math.max(0, this.cursor - 1),
    );
    this.cursor = prevNl < 0 ? 0 : prevNl + 1;
  }

  private moveLineEnd(): void {
    const nextNl = this.composer.indexOf("\n", this.cursor);
    this.cursor = nextNl < 0 ? this.composer.length : nextNl;
  }

  private moveCursorVertical(delta: -1 | 1): boolean {
    if (!this.composer.includes("\n")) return false;
    const lines = this.composer.split("\n");
    let pos = 0;
    let curLine = 0;
    let curCol = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const len = lines[i]!.length;
      if (this.cursor <= pos + len) {
        curLine = i;
        curCol = this.cursor - pos;
        break;
      }
      pos += len + 1;
    }
    const targetLine = curLine + delta;
    if (targetLine < 0 || targetLine >= lines.length) return false;
    let targetStart = 0;
    for (let i = 0; i < targetLine; i += 1) targetStart += lines[i]!.length + 1;
    this.cursor = targetStart + Math.min(curCol, lines[targetLine]!.length);
    return true;
  }

  private deleteWord(): void {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.composer[index - 1]!)) index -= 1;
    while (index > 0 && !/\s/.test(this.composer[index - 1]!)) index -= 1;
    this.composer =
      this.composer.slice(0, index) + this.composer.slice(this.cursor);
    this.cursor = index;
    this.syncPalette();
  }

  private moveHistory(direction: number): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.draft = this.composer;
      this.historyIndex = this.history.length;
    }
    const next = Math.min(
      this.history.length,
      Math.max(0, this.historyIndex + direction),
    );
    this.historyIndex = next;
    this.composer =
      next === this.history.length ? this.draft : (this.history[next] ?? "");
    this.cursor = this.composer.length;
    this.paletteOpen = false;
  }

  private isPathCommandContext(): {
    command: UiCommand;
    argPrefix: string;
    headPrefix: string;
  } | null {
    if (!this.composer.startsWith("/") || this.composer.includes("\n"))
      return null;
    const space = this.composer.indexOf(" ");
    if (space < 0) return null;
    const cmdName = this.composer.slice(1, space).toLowerCase();
    const cmd = this.commandsList.find(
      (c) => c.name === cmdName || (c.aliases?.includes(cmdName) ?? false),
    );
    if (!cmd?.pathCompletion) return null;
    const rest = this.composer.slice(space + 1);
    // Support completing the last path token (for `/compare left right` and `/diff-cve left right`)
    const lastSpace =
      cmd.name === "compare" || cmd.name === "diff-cve"
        ? rest.lastIndexOf(" ")
        : -1;
    if (lastSpace >= 0 && !rest.startsWith('"')) {
      return {
        command: cmd,
        headPrefix: `${this.composer.slice(0, space + 1)}${rest.slice(0, lastSpace + 1)}`,
        argPrefix: rest.slice(lastSpace + 1),
      };
    }
    return {
      command: cmd,
      headPrefix: this.composer.slice(0, space + 1),
      argPrefix: rest,
    };
  }

  private syncPalette(): void {
    const mention = completeAtMention(this.composer, this.cursor, this.cwd);
    if (mention && mention.candidates.length > 0) {
      this.paletteOpen = true;
      this.paletteSelected = 0;
      return;
    }
    if (!this.composer.startsWith("/") || this.composer.includes("\n")) {
      this.paletteOpen = false;
      this.paletteSelected = 0;
      return;
    }
    if (!this.composer.includes(" ")) {
      this.paletteOpen = true;
      this.paletteSelected = 0;
      return;
    }
    const items = this.paletteItems();
    this.paletteOpen = items.length > 0;
    this.paletteSelected = 0;
  }

  private subArgPaletteItems(): readonly PaletteItem[] | null {
    if (!this.composer.startsWith("/") || this.composer.includes("\n"))
      return null;
    const space = this.composer.indexOf(" ");
    if (space < 0) return null;
    const rawCmd = this.composer.slice(1, space).toLowerCase();
    const cmd = this.commandsList.find(
      (c) => c.name === rawCmd || (c.aliases?.includes(rawCmd) ?? false),
    );
    if (!cmd) return null;
    const arg = this.composer.slice(space + 1).trimStart();
    const q = arg.toLowerCase();
    if (cmd.name === "lang") {
      return (["en", "tr"] as const).filter((code) => code.startsWith(q)).map((code) => ({
        kind: "arg", badge: code === this.i18n.language ? "NOW" : "ARG", badgeKind: "arg",
        label: code, usage: "", description: this.i18n.t(code === "en" ? "language.english" : "language.turkish"),
        completion: `/lang ${code}`, submitOnEnter: true,
      }));
    }

    if (cmd.paletteArgs && cmd.paletteArgs.length > 0) {
      if (arg.includes(" ")) return [];
      return cmd.paletteArgs
        .filter(
          (item) =>
            !q ||
            item.id.toLowerCase().startsWith(q) ||
            this.i18n.lower(item.description).includes(this.i18n.lower(arg)),
        )
        .map((item) => {
          const submit = item.submitOnEnter ?? false;
          return {
            kind: "arg" as const,
            badge: item.badge ?? "ARG",
            badgeKind: item.badgeKind ?? "local",
            label: item.id,
            usage: item.usage ?? "",
            description: item.description,
            completion: submit
              ? `/${cmd.name} ${item.id}`
              : `/${cmd.name} ${item.id} `,
            submitOnEnter: submit,
          };
        });
    }

    if (cmd.name === "binary") {
      const modes: Array<{ mode: BinaryFlowMode; desc: string }> = [
        {
          mode: "on",
          desc: this.i18n.t("palette.binaryOn"),
        },
        {
          mode: "eco",
          desc: this.i18n.t("palette.binaryEco"),
        },
        {
          mode: "busy",
          desc: this.i18n.t("palette.binaryBusy"),
        },
        { mode: "off", desc: this.i18n.t("palette.binaryOff") },
      ];
      return modes
        .filter(
          (m) => !q || m.mode.startsWith(q) || m.desc.toLowerCase().includes(q),
        )
        .map((m) => ({
          kind: "arg" as const,
          badge: m.mode === this.binaryMode ? "NOW" : "MODE",
          badgeKind: "arg" as const,
          label: m.mode,
          usage: "",
          description: `${m.desc}${m.mode === this.binaryMode ? this.i18n.t("palette.activeSuffix") : ""}`,
          completion: `/binary ${m.mode}`,
          submitOnEnter: true,
        }));
    }

    if (cmd.name === "compact" || cmd.name === "compaction") {
      const providers = this.options.providers?.() ?? [];
      if (q.startsWith("model=") || q.startsWith("--model ")) {
        const prefix = q.startsWith("model=") ? "model=" : "--model ";
        const mQuery = q.slice(prefix.length).trim();
        const out: PaletteItem[] = [
          {
            kind: "arg",
            badge: "DFLT",
            badgeKind: "arg",
            label: `${prefix}active`,
            usage: "",
            description:
              this.i18n.t("palette.compactDefault"),
            completion: `/${cmd.name} ${prefix}active`,
            submitOnEnter: true,
          },
        ];
        for (const p of providers) {
          if (!p.connected && !p.local) continue;
          for (const m of p.models) {
            const spec = `${p.id}:${m.id}`;
            if (
              mQuery &&
              !spec.toLowerCase().includes(mQuery) &&
              !p.name.toLowerCase().includes(mQuery)
            ) {
              continue;
            }
            out.push({
              kind: "arg",
              badge: p.connected ? "CONN" : "LOCAL",
              badgeKind: p.connected ? "workflow" : "local",
              label: `${prefix}${spec}`,
              usage: "",
              description: this.i18n.t("palette.compactUsing", { provider: p.name, model: m.id }),
              completion: `/${cmd.name} ${prefix}${spec}`,
              submitOnEnter: cmd.name === "compaction",
            });
            if (out.length >= 24) break;
          }
          if (out.length >= 24) break;
        }
        return out;
      }

      const modes: Array<{
        mode: string;
        desc: string;
        shortcut?: string;
        submit?: boolean;
      }> = [
        {
          mode: "soft",
          desc: this.i18n.t("palette.soft"),
        },
        {
          mode: "remote",
          desc: this.i18n.t("palette.remote"),
        },
        {
          mode: "snapcompact",
          desc: this.i18n.t("palette.snapcompact"),
        },
        {
          mode: "handoff",
          desc: this.i18n.t("palette.handoff"),
        },
        {
          mode: "shake",
          desc: this.i18n.t("palette.shake"),
        },
        {
          mode: "model",
          desc: this.i18n.t("palette.compactPicker"),
          shortcut: "Alt+C",
          submit: true,
        },
      ];
      if (cmd.name === "compaction") {
        modes.push({ mode: "off", desc: this.i18n.t("palette.neverCompact") });
      }
      const head = arg.split(/\s+/)[0] ?? "";
      const completed = arg.includes(" ");
      return completed
        ? []
        : modes
            .filter(
              (m) =>
                !head ||
                m.mode.startsWith(q) ||
                m.desc.toLowerCase().includes(q),
            )
            .map((m) => ({
              kind: "arg" as const,
              badge:
                m.mode === "model"
                  ? "UI"
                  : cmd.name === "compact"
                    ? "NOW"
                    : "MODE",
              badgeKind: "arg" as const,
              label: m.mode,
              usage: "",
              ...(m.shortcut ? { shortcut: m.shortcut } : {}),
              description: m.desc,
              completion: `/${cmd.name} ${m.mode}`,
              submitOnEnter: m.submit ?? cmd.name === "compact",
            }));
    }

    if (cmd.name === "effort") {
      const savePrefix = q.startsWith("--save ") ? "--save " : "";
      const effQuery = savePrefix ? q.slice("--save ".length).trim() : q;
      const out: PaletteItem[] = [];
      if (!effQuery) {
        out.push({
          kind: "arg",
          badge: "UI",
          badgeKind: "arg",
          label: this.i18n.t("palette.effortPicker"),
          usage: "",
          shortcut: "Alt+E",
          description: this.i18n.t("palette.currentEffort", { effort: this.status.effort }),
          completion: "/effort",
          submitOnEnter: true,
        });
      }
      for (const lvl of REASONING_EFFORT_LEVELS) {
        if (
          effQuery &&
          !lvl.id.startsWith(effQuery) &&
          !this.i18n.lower(this.i18n.t(`effort.${lvl.id}`)).includes(this.i18n.lower(effQuery))
        ) {
          continue;
        }
        const active = lvl.id === this.status.effort;
        out.push({
          kind: "arg",
          badge: active ? "NOW" : "THINK",
          badgeKind: active ? "workflow" : "arg",
          label: lvl.id,
          usage: "",
          description: `${this.i18n.t(`effort.${lvl.id}`)}${active ? this.i18n.t("palette.activeSuffix") : ""}`,
          completion: `/effort ${savePrefix}${lvl.id}`,
          submitOnEnter: true,
        });
      }
      return out;
    }

    if (cmd.name === "providers") {
      const providers = this.options.providers?.() ?? [];
      const out: PaletteItem[] = [];
      if (!q) {
        out.push({
          kind: "arg",
          badge: "UI",
          badgeKind: "arg",
          label: this.i18n.t("palette.providerPicker"),
          usage: "",
          shortcut: "Alt+M",
          description: this.i18n.t("palette.providerPickerHint", { count: providers.length }),
          completion: "/providers",
          submitOnEnter: true,
        });
      }
      for (const p of providers) {
        const hay = `${p.id} ${p.name}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        out.push({
          kind: "arg",
          badge: p.connected ? "CONN" : p.local ? "LOCAL" : "SETUP",
          badgeKind: p.connected ? "workflow" : p.local ? "local" : "path",
          label: p.id,
          usage: p.name,
          description: p.connected
            ? this.i18n.t("palette.providerModels", { count: p.models.length, source: p.keySource })
            : p.local
              ? this.i18n.t("palette.localEndpoint", { url: p.baseUrl })
              : this.i18n.t("palette.exportKey", { key: p.envHint }),
          completion: `/providers ${p.id}`,
          submitOnEnter: true,
        });
      }
      return out.slice(0, 24);
    }

    if (cmd.name === "model") {
      const providers = this.options.providers?.() ?? [];
      if (providers.some((p) => p.connected && !p.local && !p.liveLoaded)) {
        this.options.onRefreshModels?.();
      }
      const out: PaletteItem[] = [];
      if (!q) {
        out.push(
          {
            kind: "arg",
            badge: "UI",
            badgeKind: "arg",
            label: this.i18n.t("palette.modelPicker"),
            usage: "",
            shortcut: "Alt+M",
            description:
              this.i18n.t("palette.modelPickerHint"),
            completion: "/model",
            submitOnEnter: true,
          },
          {
            kind: "arg",
            badge: "SYNC",
            badgeKind: "local",
            label: "refresh",
            usage: "",
            description: this.i18n.t("palette.refreshModels"),
            completion: "/model refresh",
            submitOnEnter: true,
          },
          {
            kind: "arg",
            badge: "LIST",
            badgeKind: "local",
            label: "list",
            usage: "[search_query]",
            description: this.i18n.t("palette.listModels"),
            completion: "/model list",
            submitOnEnter: true,
          },
          {
            kind: "arg",
            badge: "ENDP",
            badgeKind: "arg",
            label: "endpoint",
            usage: "<base_url> [api_key_or_env] [default_model]",
            description:
              this.i18n.t("palette.endpoint"),
            completion: "/model endpoint ",
            submitOnEnter: false,
          },
        );
      }
      const savePrefix = q.startsWith("--save ") ? "--save " : "";
      const modelQuery = savePrefix ? q.slice("--save ".length).trim() : q;
      const maxOut = modelQuery ? 80 : 40;
      for (const p of providers) {
        if (!p.connected && !p.local) continue;
        for (const m of p.models) {
          const spec = `${p.id}:${m.id}`;
          if (
            modelQuery &&
            !spec.toLowerCase().includes(modelQuery) &&
            !p.name.toLowerCase().includes(modelQuery) &&
            !(m.note ?? "").toLowerCase().includes(modelQuery)
          ) {
            continue;
          }
          out.push({
            kind: "arg",
            badge: p.connected ? "CONN" : "LOCAL",
            badgeKind: p.connected ? "workflow" : "local",
            label: spec,
            usage: "",
            description: m.note
              ? `${p.name} · ${m.note}`
              : `${p.name} · ${m.source}`,
            completion: `/model ${savePrefix}${spec}`,
            submitOnEnter: true,
          });
          if (out.length >= maxOut) break;
        }
        if (out.length >= maxOut) break;
      }
      return out;
    }

    return null;
  }

  private paletteItems(): readonly PaletteItem[] {
    const mention = completeAtMention(this.composer, this.cursor, this.cwd);
    if (mention && mention.candidates.length > 0) {
      const before = this.composer.slice(0, mention.prefixStart);
      const after = this.composer.slice(this.cursor);
      return mention.candidates.map((c) => {
        const completedPrefix = `${before}${c.replacement}`;
        return {
          kind: "mention" as const,
          badge: c.badge,
          badgeKind:
            c.badge === "IMG"
              ? ("workflow" as const)
              : c.badge === "BIN"
                ? ("arg" as const)
                : ("path" as const),
          label: c.display,
          usage: "",
          description: c.description,
          completion: `${completedPrefix}${after}`,
          cursorAfter: completedPrefix.length,
          submitOnEnter: false,
        };
      });
    }
    if (!this.composer.startsWith("/") || this.composer.includes("\n"))
      return [];
    const subArgs = this.subArgPaletteItems();
    const pathCtx = this.isPathCommandContext();
    if (pathCtx) {
      const paths = completePathInput(pathCtx.argPrefix, this.cwd);
      const pathItems: PaletteItem[] = paths.map((candidate) => ({
        kind: "path" as const,
        badge: candidate.endsWith("/") ? "DIR" : "FILE",
        badgeKind: "path" as const,
        label: candidate,
        usage: "",
        description: candidate.endsWith("/")
          ? this.i18n.t("palette.browseDirectory")
          : this.i18n.t("palette.selectFor", { command: pathCtx.command.name }),
        completion: `${pathCtx.headPrefix}${candidate}`,
        submitOnEnter:
          !candidate.endsWith("/") && pathCtx.command.name !== "compare",
      }));
      return subArgs && subArgs.length > 0
        ? [...subArgs, ...pathItems]
        : pathItems;
    }

    if (subArgs !== null) return subArgs;

    if (this.composer.includes(" ")) return [];
    const query = this.composer.slice(1).toLowerCase();
    const scored: Array<{ score: number; item: PaletteItem }> = [];
    for (const cmd of this.commandsList) {
      const names = [cmd.name, ...(cmd.aliases ?? [])];
      let score = -1;
      if (!query) score = 100;
      else if (cmd.name === query) score = 1000;
      else if (cmd.name.startsWith(query)) score = 800 - cmd.name.length;
      else if (names.some((n) => n.startsWith(query))) score = 700;
      else if (cmd.name.includes(query)) score = 500;
      else if (this.i18n.lower(cmd.description).includes(this.i18n.lower(this.composer.slice(1)))) score = 300;
      if (score < 0) continue;

      const kind: CommandKind = cmd.kind ?? "local";
      const badge =
        kind === "workflow" ? "FLOW" : kind === "prompt" ? "ASK" : "LOCAL";
      const needsArg = /^\/\S+\s+</.test(cmd.usage ?? "");
      scored.push({
        score,
        item: {
          kind: "command",
          badge,
          badgeKind: kind,
          label: `/${cmd.name}`,
          usage: cmd.usage ? cmd.usage.slice(cmd.name.length + 1).trim() : "",
          ...(cmd.shortcut ? { shortcut: cmd.shortcut } : {}),
          description: cmd.description,
          completion: `/${cmd.name}${needsArg ? " " : ""}`,
          submitOnEnter: !needsArg,
        },
      });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
  }

  private ghostCompletionSuffix(): string {
    if (
      !this.composer.startsWith("/") ||
      this.composer.length < 2 ||
      this.composer.includes("\n") ||
      this.cursor !== this.composer.length
    ) {
      return "";
    }
    const items = this.paletteItems();
    const active = items[this.paletteSelected] ?? items[0];
    if (!active) return "";
    if (
      active.completion.length > this.composer.length &&
      active.completion.toLowerCase().startsWith(this.composer.toLowerCase())
    ) {
      return active.completion.slice(this.composer.length);
    }
    return "";
  }

  private movePalette(direction: number): void {
    const items = this.paletteItems();
    if (items.length === 0) return;
    this.paletteSelected =
      (this.paletteSelected + direction + items.length) % items.length;
    this.paint();
  }

  private handleTab(): void {
    const pathCtx = this.isPathCommandContext();
    if (pathCtx && !this.paletteOpen) {
      const matches = completePathInput(pathCtx.argPrefix, this.cwd);
      if (matches.length === 1) {
        this.composer = `${pathCtx.headPrefix}${matches[0]!}`;
        this.cursor = this.composer.length;
        this.syncPalette();
        this.paint();
        return;
      }
      if (matches.length > 1) {
        this.paletteOpen = true;
        this.paletteSelected = 0;
        this.paint();
        return;
      }
    }
    if (this.paletteOpen) {
      this.completePalette();
      return;
    }
    this.insertText("  ", false);
    this.paint();
  }

  private completePalette(): void {
    const item = this.paletteItems()[this.paletteSelected];
    if (!item) return;
    this.composer = item.completion;
    this.cursor = item.cursorAfter ?? this.composer.length;
    this.syncPalette();
    this.paint();
  }

  private submit(): void {
    if (this.paletteOpen) {
      const item = this.paletteItems()[this.paletteSelected];
      if (item) {
        if (
          item.kind === "path" ||
          item.kind === "arg" ||
          item.kind === "mention"
        ) {
          this.composer = item.completion;
          this.cursor = item.cursorAfter ?? this.composer.length;
          if (!item.submitOnEnter) {
            this.syncPalette();
            this.paint();
            return;
          }
        } else {
          const typed = this.composer.trim();
          if (typed !== item.label) {
            this.composer = item.completion;
            this.cursor = item.cursorAfter ?? this.composer.length;
            if (!item.submitOnEnter) {
              this.syncPalette();
              this.paint();
              return;
            }
          }
        }
      }
    }
    const line = this.composer.trim();
    const hasImages = this.stagedImages.length > 0;
    const now = Date.now();

    // Double-Enter while busy on an empty composer with queued steering messages:
    // immediately interrupt the active step and flush the queued steering message(s)!
    if (!line && !hasImages) {
      if (this.busy !== null && this.queuedSteers.length > 0) {
        this.lastBusySubmitAt = 0;
        this.options.onSubmit("", { immediate: true });
      }
      this.paint();
      return;
    }

    const isSlashOrBang = line.startsWith("/") || line.startsWith("!");
    const attachedImages: ChatImageBlock[] | undefined =
      hasImages && !isSlashOrBang
        ? this.stagedImages
            .splice(0, this.stagedImages.length)
            .map(toChatImageBlock)
        : undefined;

    if (line) {
      this.history.push(timelineText(this.i18n, line));
      if (this.history.length > 200) this.history.shift();
    }
    this.historyIndex = -1;
    this.composer = "";
    this.cursor = 0;
    this.paletteOpen = false;
    this.scroll = 0;

    if (this.busy !== null) {
      const immediate =
        this.lastBusySubmitAt > 0 &&
        now - this.lastBusySubmitAt <= DOUBLE_ENTER_STEER_WINDOW_MS;
      this.lastBusySubmitAt = immediate ? 0 : now;
      this.options.onSubmit(line, {
        immediate,
        ...(attachedImages ? { images: attachedImages } : {}),
      });
    } else {
      this.lastBusySubmitAt = 0;
      this.options.onSubmit(
        line,
        attachedImages ? { images: attachedImages } : undefined,
      );
    }
    this.paint();
  }

  private rows(): number {
    return this.stdout.rows || 24;
  }

  private cols(): number {
    return this.stdout.columns || 80;
  }

  private paint(): void {
    if (!this.started) return;
    const rows = this.rows();
    const cols = this.cols();
    const frame = this.renderFrame(cols, rows);
    const out: string[] = [SYNC_START];

    if (rows !== this.prevRows || cols !== this.prevCols) {
      out.push(`${ESC}2J`);
      this.prevLines = [];
      this.prevRows = rows;
      this.prevCols = cols;
    }

    for (let r = 0; r < rows; r += 1) {
      const next = frame.lines[r] ?? "";
      if (this.prevLines[r] !== next) {
        out.push(`${ESC}${r + 1};1H${next}${ESC}K`);
      }
    }
    this.prevLines = frame.lines;

    const cRow = Math.min(Math.max(1, frame.cursor.row), rows);
    const cCol = Math.min(Math.max(1, frame.cursor.col), cols);
    out.push(
      `${ESC}${cRow};${cCol}H${frame.cursor.visible ? `${ESC}?25h` : `${ESC}?25l`}`,
    );
    out.push(SYNC_END);
    this.stdout.write(out.join(""));
  }

  /**
   * Pure deterministic frame builder — produces exact `rows` ANSI lines of
   * display width `<= cols` with zero direct I/O, making every layout testable.
   */
  renderFrame(cols: number, rows: number): RenderedFrame {
    const safeCols = Math.max(24, cols);
    const safeRows = Math.max(8, rows);
    if (this.picker.open) {
      return this.renderModelPickerModalFrame(safeCols, safeRows);
    }
    if (this.sessionPicker.open) {
      return this.renderSessionPickerModalFrame(safeCols, safeRows);
    }
    if (this.outputExpanded) {
      return this.renderOutputModalFrame(safeCols, safeRows);
    }
    return this.renderMainFrame(safeCols, safeRows);
  }

  private renderMainFrame(cols: number, rows: number): RenderedFrame {
    const t = this.theme;
    const hudWidth =
      cols >= 116 && this.binaryMode !== "off"
        ? Math.min(38, Math.floor(cols * 0.3))
        : 0;
    // Exact column math so `╭`/`│`/`╰` (col 1), `┬`/`│`/`┴` (col cols-hudWidth), and `╮`/`│`/`╯` (col cols) align:
    const leftCellWidth =
      hudWidth > 0 ? Math.max(4, cols - hudWidth - 4) : Math.max(4, cols - 4);
    const rightCellWidth = hudWidth > 0 ? Math.max(4, hudWidth - 3) : 0;

    // 1. Composer layout (3 to 8 rows total: top border + 1..6 input lines + bottom border)
    const maxComposerInner = Math.min(6, Math.max(1, Math.floor(rows * 0.25)));
    const promptPrefix = "❯ ";
    const composerTextWidth = Math.max(6, cols - 4 - visibleWidth(promptPrefix));
    const wrappedComposer = wrapComposerWithCursor(
      this.composer,
      this.cursor,
      composerTextWidth,
    );
    const composerInnerHeight = Math.min(
      maxComposerInner,
      Math.max(1, wrappedComposer.lines.length),
    );
    const composerBoxRows = composerInnerHeight + 2;

    // Viewport window over wrapped composer lines so cursor is always visible
    const composerStartLine = Math.max(
      0,
      Math.min(
        wrappedComposer.lines.length - composerInnerHeight,
        wrappedComposer.row - composerInnerHeight + 1,
      ),
    );

    // 2. Optional Network Guard mini-panel (3-row box when rows >= 13, 1-row compact strip on tiny screens)
    const netGuardLines = this.networkGuard
      ? rows >= 13
        ? this.renderNetworkGuardBox(cols)
        : [this.renderNetworkGuardCompactLine(cols)]
      : [];

    // 2b. Optional omp-style Queued Steering box + Staged Image Attachments strip
    const steerLines =
      this.queuedSteers.length > 0 && rows >= 12
        ? this.renderSteeringBox(cols)
        : [];
    const imageLines =
      this.stagedImages.length > 0 && rows >= 11
        ? [this.renderStagedImagesStrip(cols)]
        : [];

    const fixedRows = 3 + composerBoxRows + netGuardLines.length + steerLines.length + imageLines.length;
    const supportRows = rows >= fixedRows + 3 ? 1 : 0;

    // 3. Optional overlay (Palette takes priority over Output Drawer)
    const maxOverlayBudget = Math.max(0, rows - fixedRows - supportRows - 4);
    const paletteItems = this.paletteOpen ? this.paletteItems() : [];
    let overlayLines: string[] = [];
    if (this.paletteOpen && maxOverlayBudget >= 3) {
      overlayLines = this.renderPaletteBox(
        cols,
        maxOverlayBudget,
        paletteItems,
      );
    } else if (
      this.outputDrawerOpen &&
      this.output.text &&
      maxOverlayBudget >= 4
    ) {
      overlayLines = this.renderOutputDrawerBox(
        cols,
        Math.min(11, maxOverlayBudget),
      );
    }

    // 4. Main viewport body height
    const viewportBodyRows = Math.max(2, rows - fixedRows - supportRows - overlayLines.length);

    // Assemble frame top-to-bottom
    const frame: string[] = [];
    frame.push(this.renderTopBar(cols, hudWidth));

    const leftRows = this.renderViewportLeft(leftCellWidth, viewportBodyRows);
    const rightRows =
      hudWidth > 0
        ? this.renderHudSidebar(rightCellWidth, viewportBodyRows)
        : [];
    // Row 0 is the top bar; `│ ` + left cell + ` │ ` puts the HUD cell at column leftCellWidth + 5.
    const hudRegion: FrameRegion | null = hudWidth > 0
      ? { top: VIEWPORT_TOP_ROW, height: viewportBodyRows, left: leftCellWidth + VIEWPORT_LEFT_COL + 3, width: rightCellWidth }
      : null;
    const hudLinks = this.decorateHudLinks(hudRegion, rightRows);

    for (let r = 0; r < viewportBodyRows; r += 1) {
      const leftCell = padEndAnsi(leftRows[r] ?? "", leftCellWidth);
      if (hudWidth === 0) {
        frame.push(
          truncateAnsi(
            `${t.border}│${t.reset} ${leftCell} ${t.border}│${t.reset}`,
            cols,
          ),
        );
      } else {
        const rightCell = padEndAnsi(rightRows[r] ?? "", rightCellWidth);
        frame.push(
          truncateAnsi(
            `${t.border}│${t.reset} ${leftCell} ${t.border}│${t.reset} ${rightCell} ${t.border}│${t.reset}`,
            cols,
          ),
        );
      }
    }

    frame.push(this.renderViewportBottom(cols, hudWidth));
    for (const line of overlayLines) frame.push(line);
    for (const line of netGuardLines) frame.push(line);
    for (const line of steerLines) frame.push(line);
    for (const line of imageLines) frame.push(line);
    if (supportRows) {
      frame.push(centerAnsi(renderSupportLine(cols - 2, this.i18n, t, this.hyperlinks), cols));
    }

    // Composer box
    const composerTopRowIndex = frame.length; // 0-based
    const hasStagedImages = this.stagedImages.length > 0;
    const composerFocusedBorder =
      this.busy || hasStagedImages ? t.borderActive : t.border;
    const composerTitle = hasStagedImages
      ? this.i18n.t("composer.images", { count: this.stagedImages.length })
      : this.i18n.t("composer.title");
    const composerRightHint = this.composer.includes("\n")
      ? this.i18n.t("composer.lines", { count: wrappedComposer.lines.length })
      : this.busy && this.queuedSteers.length > 0
        ? this.i18n.t("composer.queued")
        : this.busy
          ? this.i18n.t("composer.busy")
          : hasStagedImages
            ? this.i18n.t("composer.sendImage")
            : this.i18n.t("composer.shortcuts");
    frame.push(
      this.renderBoxTop(
        cols,
        composerTitle,
        supportRows ? composerRightHint : renderSupportLine(
          cols - visibleWidth(composerTitle) - 9, this.i18n, t, this.hyperlinks,
        ),
        composerFocusedBorder,
        t.neonCyan,
      ),
    );

    const ghostSuffix = this.ghostCompletionSuffix();
    for (let i = 0; i < composerInnerHeight; i += 1) {
      const absIdx = composerStartLine + i;
      const lineObj = wrappedComposer.lines[absIdx];
      const prefix =
        absIdx === 0
          ? `${t.neonMint}${t.bold}${promptPrefix}${t.reset}`
          : `${t.subtle}· ${t.reset}`;
      let content: string;
      if (this.composer.length === 0 && i === 0) {
        if (hasStagedImages) {
          const imgSummary = this.stagedImages.map((img) => img.label).join(", ");
          const placeholder = this.i18n.t("composer.imageReady", { images: imgSummary });
          content = `${t.neonCyan}${truncateAnsi(placeholder, composerTextWidth)}${t.reset}`;
        } else {
          const placeholder = this.status.target
            ? this.i18n.t("composer.askTarget", { target: basenameOf(this.status.target) })
            : this.i18n.t("composer.ask");
          content = `${t.muted}${truncateAnsi(placeholder, composerTextWidth)}${t.reset}`;
        }
      } else {
        const typedText = lineObj?.text ?? "";
        const isLastLine = absIdx === wrappedComposer.lines.length - 1;
        if (isLastLine && ghostSuffix.length > 0) {
          const rem = Math.max(0, composerTextWidth - visibleWidth(typedText));
          const ghostClipped =
            rem > 0
              ? `${t.subtle}${truncateAnsi(ghostSuffix, rem)}${t.reset}`
              : "";
          content = `${t.fgBright}${typedText}${t.reset}${ghostClipped}`;
        } else {
          content = `${t.fgBright}${typedText}${t.reset}`;
        }
      }
      const padded = padEndAnsi(`${prefix}${content}`, cols - 4);
      frame.push(
        `${composerFocusedBorder}│${t.reset} ${padded} ${composerFocusedBorder}│${t.reset}`,
      );
    }
    frame.push(`${composerFocusedBorder}╰${hline(cols - 2)}╯${t.reset}`);

    // Status bar (capped to cols - 1 so bottom-right terminal auto-wrap never scrolls)
    frame.push(this.renderStatusBar(Math.max(10, cols - 1)));

    // Normalize exact row count
    while (frame.length < rows) frame.push("");
    if (frame.length > rows) frame.length = rows;

    // Links below the transcript (drawers, support row, composer title) are clickable too; the
    // HUD/transcript links were collected above. Then the selection is drawn over everything.
    const linkRows: number[] = [];
    for (let row = VIEWPORT_TOP_ROW + viewportBodyRows; row <= composerTopRowIndex && row < frame.length; row += 1) linkRows.push(row);
    this.collectFrameLinks(frame, linkRows, hudLinks);
    this.frameRegions = {
      hud: hudRegion,
      composer: {
        top: composerTopRowIndex + 1,
        height: composerInnerHeight,
        left: VIEWPORT_LEFT_COL + visibleWidth(promptPrefix),
        width: composerTextWidth,
      },
    };
    for (const span of this.selectionScreenSpans(frame)) {
      frame[span.row] = highlightVisualCols(frame[span.row] ?? "", span.from, span.to);
    }
    this.lastFrameLines = frame;

    const cursorLineInBox = wrappedComposer.row - composerStartLine;
    const cursorRow1Based =
      composerTopRowIndex +
      2 +
      Math.max(0, Math.min(composerInnerHeight - 1, cursorLineInBox));
    const cursorCol1Based = 3 + visibleWidth(promptPrefix) + wrappedComposer.col;

    return {
      lines: frame,
      cursor: {
        row: cursorRow1Based,
        col: Math.min(cols - 2, cursorCol1Based),
        visible: true,
      },
    };
  }

  private isFlowEnabled(): boolean {
    return (
      this.busy !== null ||
      this.binaryMode === "on" ||
      (this.binaryMode === "eco" &&
        Date.now() - this.lastInteractionAt < IDLE_FLOW_GRACE_MS)
    );
  }

  private renderTopBar(cols: number, hudWidth: number): string {
    const t = this.theme;
    const targetLabel = this.status.target
      ? basenameOf(this.status.target)
      : this.i18n.t("hud.noTarget");
    const magicBadge = this.status.magic ? ` · ${this.status.magic.label}` : "";
    const pulseBits = cols >= 68 ? 8 : 6;
    const pulse =
      this.isFlowEnabled() && cols >= 54
        ? ` ${renderBinaryPulse(this.tick, this.status.magic?.bytes ?? null, t, pulseBits)} `
        : "";

    const reaState = this.status.reaConnected
      ? `${t.emerald}● rea:${this.status.reaTools}${t.reset}`
      : `${t.amber}◌ rea${t.reset}`;

    if (hudWidth === 0) {
      const leftPlainBudget = Math.max(10, cols - 26);
      const targetClipped = truncateAnsi(
        `${targetLabel}${magicBadge}`,
        Math.max(8, leftPlainBudget - 12),
      );
      const left = `${t.border}╭─ ${t.reset}${t.neonMint}${t.bold}◈ OMR${t.reset}${t.border} ─ ${t.reset}${t.fgBright}${t.bold}${targetClipped}${t.reset}${pulse}`;
      const right = ` ${reaState}${t.border} ─╮${t.reset}`;
      const fill = Math.max(0, cols - visibleWidth(left) - visibleWidth(right));
      return truncateAnsi(
        `${left}${t.border}${hline(fill)}${t.reset}${right}`,
        cols,
      );
    }

    const leftWidth = cols - hudWidth;
    const targetBudget = Math.max(8, leftWidth - (pulse ? 28 : 15));
    const targetClipped = truncateAnsi(
      `${targetLabel}${magicBadge}`,
      targetBudget,
    );
    const leftPart = `${t.border}╭─ ${t.reset}${t.neonMint}${t.bold}◈ OMR${t.reset}${t.border} ─ ${t.reset}${t.fgBright}${t.bold}${targetClipped}${t.reset}${pulse}`;
    const leftFill = Math.max(0, leftWidth - visibleWidth(leftPart) - 1);
    const leftComplete = `${leftPart}${t.border}${hline(leftFill)}┬${t.reset}`;

    const rightTitle = ` ${t.neonCyan}${t.bold}${this.i18n.t("hud.title")}${t.reset} ${t.muted}·${t.reset} ${reaState} `;
    const rightFill = Math.max(0, hudWidth - visibleWidth(rightTitle) - 1);
    const rightComplete = `${rightTitle}${t.border}${hline(rightFill)}╮${t.reset}`;
    return truncateAnsi(`${leftComplete}${rightComplete}`, cols);
  }

  private renderViewportBottom(cols: number, hudWidth: number): string {
    const t = this.theme;
    const scrollPill = this.scroll > 0 ? this.i18n.t("hud.scrolled", { count: this.scroll }) : "";
    const scrollWidth = visibleWidth(scrollPill);
    if (hudWidth === 0) {
      if (scrollPill && cols > scrollWidth + 6) {
        const fill = Math.max(0, cols - 2 - scrollWidth - 1);
        return `${t.border}╰${hline(fill)}${t.reset}${t.amber}${scrollPill}${t.reset}${t.border}─╯${t.reset}`;
      }
      return `${t.border}╰${hline(cols - 2)}╯${t.reset}`;
    }
    const leftSpan = Math.max(0, cols - hudWidth - 2);
    const rightSpan = Math.max(0, hudWidth - 1);
    if (scrollPill && leftSpan > scrollWidth + 4) {
      const fill = Math.max(0, leftSpan - scrollWidth - 1);
      return `${t.border}╰${hline(fill)}${t.reset}${t.amber}${scrollPill}${t.reset}${t.border}─┴${hline(rightSpan)}╯${t.reset}`;
    }
    return `${t.border}╰${hline(leftSpan)}┴${hline(rightSpan)}╯${t.reset}`;
  }

  private renderBoxTop(
    cols: number,
    title: string,
    hint: string,
    borderColor: string,
    titleColor: string,
  ): string {
    const t = this.theme;
    const titleBudget = hint ? Math.floor(cols * 0.55) : cols - 6;
    const left = `${borderColor}╭─ ${t.reset}${titleColor}${t.bold}${truncateAnsi(title, titleBudget)}${t.reset}${borderColor} `;
    const fittedHint = truncateAnsi(hint, Math.max(0, cols - visibleWidth(left) - 5));
    const right = fittedHint
      ? `${t.reset}${t.muted} ${fittedHint} ${borderColor}─╮${t.reset}`
      : `─╮${t.reset}`;
    const fill = Math.max(0, cols - visibleWidth(left) - visibleWidth(right));
    return truncateAnsi(`${left}${borderColor}${hline(fill)}${right}`, cols);
  }

  private renderViewportLeft(width: number, height: number): string[] {
    // Release notes and other startup messages stay visible without replacing the empty-session splash.
    if (this.timeline.every(isStartupNotice)) {
      // The update box gets its own room on top of the notice budget, so it never clips release notes.
      const update = this.timeline.find((entry) => entry.kind === "update");
      const updateRows = update ? this.renderSingleEntry(update, width).length + 1 : 0;
      const noticeBudget = Math.min(Math.floor(height / 3) + updateRows, Math.max(0, height - 8));
      const notices = this.renderTimelineLines(width).slice(0, noticeBudget);
      const hero = renderHeroLines({
        i18n: this.i18n,
        width,
        height: height - notices.length,
        tick: this.tick,
        binaryEnabled: this.isFlowEnabled(),
        model: this.status.model,
        reaConnected: this.status.reaConnected,
        reaTools: this.status.reaTools,
        target: this.status.target,
        magic: this.status.magic,
        candidates: this.status.candidates,
        sessionId: this.status.session,
        theme: this.theme,
        hyperlinks: this.hyperlinks,
      });
      const topPadding = Math.max(0, Math.floor((height - hero.length - notices.length) / 2));
      const shownHero = [
        ...Array.from({ length: topPadding }, () => ""),
        ...hero,
        ...notices,
      ];
      if (this.lastViewportLayout.hero === false && this.selection?.region === "transcript") this.selection = null;
      this.lastViewportLayout = {
        startLine: 0,
        height,
        leftCellWidth: width,
        lines: shownHero,
        hero: true,
      };
      return this.decorateViewportLinks(shownHero, 0, shownHero, width);
    }

    const lines = this.renderTimelineLines(width);
    const maxScroll = Math.max(0, lines.length - height);
    this.scroll = Math.min(this.scroll, maxScroll);
    const start = Math.max(0, lines.length - height - this.scroll);
    // Hero-splash line indices mean nothing in the transcript, so a splash selection ends with it.
    if (this.lastViewportLayout.hero && this.selection?.region === "transcript") this.selection = null;
    this.lastViewportLayout = {
      startLine: start,
      height,
      leftCellWidth: width,
      lines,
      hero: false,
    };
    return this.decorateViewportLinks(lines, start, lines.slice(start, start + height), width);
  }

  private linkStyle(): string {
    return this.theme.enabled ? `${this.theme.underline}${this.theme.sky}` : "";
  }

  /**
   * Underlines and colours the links on the visible transcript rows (wrapped URLs included), wraps
   * them in OSC 8 for terminals that open links themselves, and records them for Ctrl+click.
   */
  private decorateViewportLinks(
    lines: readonly string[],
    start: number,
    visible: readonly string[],
    width: number,
  ): string[] {
    this.viewportLinks = [];
    const found = linkSpansForLines(lines, start, start + visible.length, width);
    if (found.size === 0) return [...visible];
    return visible.map((line, rel) => {
      const spans = found.get(start + rel);
      if (!spans) return line;
      for (const span of spans) this.viewportLinks.push({ row: rel, span });
      return this.decorateLinks(line, spans);
    });
  }

  private decorateLinks(line: string, spans: readonly LinkSpan[]): string {
    const style = this.linkStyle();
    const styled = spans
      .filter((span) => !span.osc8)
      .map((span) => ({ from: span.from, to: span.to, on: style, href: this.hyperlinks ? span.url : undefined }));
    return styled.length > 0 ? styleVisualSpans(line, styled) : line;
  }

  /** Styles links inside HUD cells (in place) and returns them by frame row in frame columns. */
  private decorateHudLinks(hud: FrameRegion | null, hudRows: string[]): Map<number, LinkSpan[]> {
    const links = new Map<number, LinkSpan[]>();
    if (!hud) return links;
    for (const [rel, spans] of linkSpansForLines(hudRows, 0, hudRows.length, Number.POSITIVE_INFINITY, 0)) {
      hudRows[rel] = this.decorateLinks(hudRows[rel]!, spans);
      links.set(hud.top + rel, spans.map((span) => ({ ...span, from: span.from + hud.left, to: span.to + hud.left })));
    }
    return links;
  }

  /**
   * Records every clickable link of the frame by row (absolute columns): transcript links from
   * the viewport, HUD links, and links on `rows` (drawers, support row, composer title), which
   * are styled here.
   */
  private collectFrameLinks(frame: string[], rows: readonly number[], hudLinks: Map<number, LinkSpan[]>): void {
    const links = new Map<number, LinkSpan[]>(hudLinks);
    const push = (row: number, span: LinkSpan): void => {
      const list = links.get(row) ?? [];
      list.push(span);
      links.set(row, list);
    };
    for (const { row, span } of this.viewportLinks) {
      push(VIEWPORT_TOP_ROW + row, { ...span, from: span.from + VIEWPORT_LEFT_COL, to: span.to + VIEWPORT_LEFT_COL });
    }
    for (const row of rows) {
      const spans = linkSpansForLines(frame, row, row + 1, Number.POSITIVE_INFINITY, 0).get(row);
      if (!spans) continue;
      frame[row] = this.decorateLinks(frame[row]!, spans);
      for (const span of spans) push(row, span);
    }
    for (const list of links.values()) list.sort((a, b) => a.from - b.from);
    this.frameLinks = links;
  }

  /** Amber-bordered "Update Available" box: one line per outdated package, then the update command. */
  private renderUpdateBox(info: UpdateInfo, width: number): string[] {
    const t = this.theme;
    const inner = Math.max(8, width - 4);
    const title = ` ⬆ ${this.i18n.t("update.title")} `;
    const fittedTitle = truncateAnsi(title, Math.max(0, inner - 1));
    const out = [
      `${t.amber}╭─${t.bold}${fittedTitle}${t.reset}${t.amber}${hline(width - 3 - visibleWidth(fittedTitle))}╮${t.reset}`,
    ];
    const row = (content: string): string =>
      `${t.amber}│${t.reset} ${padEndAnsi(content, inner)} ${t.amber}│${t.reset}`;
    for (const pkg of info.packages) {
      const body = this.i18n.t("update.body", { name: pkg.name, latest: pkg.latest, installed: pkg.installed });
      for (const line of wrapPlain(body, inner, true)) {
        out.push(row(`${t.fg}${line.replace(pkg.latest, `${t.bold}${t.fgBright}${pkg.latest}${t.reset}${t.fg}`)}${t.reset}`));
      }
    }
    out.push(row(`${t.fg}${this.i18n.t("update.run")}${t.reset} ${t.neonCyan}${t.bold}omr update${t.reset}${t.muted} · /changelog${t.reset}`));
    out.push(`${t.amber}╰${hline(width - 2)}╯${t.reset}`);
    return out;
  }

  private isTickAnimatedEntry(entry: TimelineEntry): boolean {
    if (entry.kind === "reasoning") return entry.active;
    if (entry.kind === "tools")
      return entry.calls.some((call) => call.status === "running");
    return false;
  }

  private renderSingleEntry(
    entry: TimelineEntry,
    width: number,
  ): readonly string[] {
    const animated = this.isTickAnimatedEntry(entry);
    if (
      !animated &&
      entry.cache &&
      entry.cache.width === width &&
      entry.cache.language === this.i18n.language &&
      entry.cache.rev === entry.rev
    ) {
      return entry.cache.lines;
    }

    const t = this.theme;
    const out: string[] = [];

    if (entry.kind === "user") {
      const innerW = Math.max(4, width - 4);
      const wrapped = wrapPlain(entry.text, innerW, true);
      wrapped.forEach((uLine, lineIdx) => {
        const lead =
          lineIdx === 0
            ? `${t.neonCyan}${t.bold}┃ ❯ ${t.reset}`
            : `${t.neonCyan}┃   ${t.reset}`;
        const body = padEndAnsi(
          `${t.userBg}${t.fgBright}${t.bold}${uLine}${t.reset}`,
          innerW,
        );
        out.push(`${lead}${t.userBg}${body}${t.reset}`);
      });
    } else if (entry.kind === "reasoning") {
      const clean = entry.text.trim();
      if (entry.active) {
        const star =
          THINKING_STAR_FRAMES[this.tick % THINKING_STAR_FRAMES.length];
        const elapsed = formatDuration(
          Math.max(0, Date.now() - entry.startedAt),
        );
        const wordBadge = entry.words > 0 ? this.i18n.t("timeline.words", { count: entry.words }) : "";
        out.push(
          `${t.violet}${t.bold}${star} ${this.i18n.t("timeline.thinking")}${t.reset} ${t.muted}· ${elapsed}${wordBadge}${t.reset} ${renderBinaryPulse(this.tick, this.status.magic?.bytes ?? null, t, 6)}`,
        );
      } else if (clean || entry.words > 0) {
        const dur = this.i18n.t("timeline.elapsed", { time: formatDuration(Math.max(0, entry.durationMs)) });
        const wordBadge = entry.words > 0 ? this.i18n.t("timeline.words", { count: entry.words }) : "";
        out.push(
          `${t.violet}✻ ${this.i18n.t("timeline.thought")}${dur}${t.reset}${t.muted}${wordBadge}${t.reset}`,
        );
      }
      if (clean) {
        const wrappedThought = wrapPlain(clean, Math.max(6, width - 5), true);
        for (const pLine of wrappedThought) {
          out.push(
            `  ${t.borderActive}│${t.reset} ${t.subtle}${t.italic}${pLine}${t.reset}`,
          );
        }
      }
    } else if (entry.kind === "tools") {
      const total = entry.calls.length;
      let doneCount = 0;
      let failCount = 0;
      for (const c of entry.calls) {
        if (c.status !== "running") doneCount += 1;
        if (c.status === "fail") failCount += 1;
      }
      const headerStatus =
        doneCount < total
          ? `${t.neonCyan}${this.i18n.t("timeline.running", { step: doneCount + 1, total })}${t.reset}`
          : failCount > 0
            ? `${t.crimson}${this.i18n.t("timeline.failed", { ok: total - failCount, total, failed: failCount })}${t.reset}`
            : `${t.emerald}${this.i18n.t("timeline.complete", { total })}${t.reset}`;
      out.push(
        `${t.borderActive}╭─${t.reset} ${t.muted}${this.i18n.t("timeline.reaTools")} ·${t.reset} ${headerStatus}`,
      );

      entry.calls.forEach((call, cIdx) => {
        const isLast = cIdx === entry.calls.length - 1;
        const branch = `${t.borderActive}${isLast ? "╰─" : "├─"}${t.reset}`;
        const argText = call.summary
          ? `${t.muted}(${call.summary})${t.reset}`
          : "";
        if (call.status === "running") {
          const elapsed = formatDuration(Date.now() - call.startedAt);
          const pulse = renderBinaryPulse(
            this.tick + cIdx,
            this.status.magic?.bytes ?? null,
            t,
            6,
          );
          out.push(
            truncateAnsi(
              `${branch} ${t.neonCyan}${SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length]} ${t.bold}${call.displayTool}${t.reset}${argText} ${pulse} ${t.muted}${elapsed}${t.reset}`,
              width,
            ),
          );
        } else {
          const icon =
            call.status === "ok"
              ? `${t.emerald}✓${t.reset}`
              : `${t.crimson}✗${t.reset}`;
          const evChips =
            call.evidenceIds.length > 0
              ? ` ${t.pillMintBg}${t.neonMint}⟦${call.evidenceIds[0]!.slice(0, 11)}…⟧${call.evidenceIds.length > 1 ? `+${call.evidenceIds.length - 1}` : ""}${t.reset}`
              : "";
          const durText =
            call.durationMs > 0
              ? ` ${t.muted}· ${formatDuration(call.durationMs)}${t.reset}`
              : "";
          out.push(
            truncateAnsi(
              `${branch} ${icon} ${t.fgBright}${call.displayTool}${t.reset}${argText}${durText}${evChips}`,
              width,
            ),
          );
        }
      });
    } else if (entry.kind === "assistant") {
      const mdLines = renderMarkdown(
        entry.text,
        Math.max(6, width - 2),
        t,
        entry.streaming,
        true,
        this.i18n.language,
      );
      mdLines.forEach((mLine, mIdx) => {
        const startsWithSectionBadge =
          mIdx === 0 && /^\s*(?:\x1b\[[0-9;]*m)*\s*[◈◇△◆◌]/.test(mLine);
        const lead =
          mIdx === 0 && !startsWithSectionBadge
            ? `${t.neonMint}◈${t.reset} `
            : "  ";
        out.push(truncateAnsi(`${lead}${mLine}`, width));
      });
      if (entry.meta && !entry.streaming) {
        out.push(`  ${t.subtle}${entry.meta}${t.reset}`);
      }
    } else if (entry.kind === "system") {
      const text = entry.localize ? timelineText(this.i18n, entry.localize(this.i18n.t)) : entry.text;
      for (const sLine of wrapPlain(text, Math.max(6, width - 3), true)) {
        out.push(
          `${t.muted}· ${styleInlineMarkdown(sLine, t, t.muted)}${t.reset}`,
        );
      }
    } else if (entry.kind === "update") {
      out.push(...this.renderUpdateBox(entry.info, width));
    } else if (entry.kind === "error") {
      for (const eLine of wrapPlain(entry.text, Math.max(6, width - 3), true)) {
        out.push(`${t.crimson}✗ ${eLine}${t.reset}`);
      }
    }

    if (!animated) {
      entry.cache = { width, rev: entry.rev, language: this.i18n.language, lines: out };
    }
    return out;
  }

  private renderTimelineLines(width: number): string[] {
    const lines: string[] = [];
    for (let idx = 0; idx < this.timeline.length; idx += 1) {
      const entry = this.timeline[idx]!;
      const entryLines = this.renderSingleEntry(entry, width);
      if (entryLines.length === 0) continue;
      const prev = idx > 0 ? this.timeline[idx - 1] : null;
      if (
        lines.length > 0 &&
        !(
          prev?.kind === "reasoning" &&
          (entry.kind === "assistant" || entry.kind === "tools")
        )
      ) {
        lines.push("");
      }
      for (const l of entryLines) lines.push(l);
    }
    return lines;
  }

  private renderHudSidebar(width: number, height: number): string[] {
    const t = this.theme;
    const rows: string[] = [];

    // 1. Live Binary / Hex Oscilloscope
    rows.push(
      `${t.neonMint}${t.bold}◈ ${this.i18n.upper(this.i18n.t("hud.bitstream"))}${t.reset} ${t.subtle}(${this.i18n.t(binaryModeKeys[this.binaryMode])})${t.reset}`,
    );
    const binaryRows = renderHudBinaryStrip(
      width,
      this.tick,
      this.isFlowEnabled(),
      this.status.magic,
      this.busy !== null,
      t,
    );
    for (const bRow of binaryRows) rows.push(bRow);

    rows.push(`${t.border}${hline(width)}${t.reset}`);

    if (this.subagentActivity.size) {
      const heading = this.i18n.t("hud.subagents", { count: this.subagentActivity.size });
      rows.push(`${t.neonCyan}${t.bold}${heading}${t.reset}`);
      const capacity = Math.max(0, height - rows.length - 1);
      const shown = Math.min(this.subagentActivity.size, capacity);
      for (const [id, activity] of [...this.subagentActivity].slice(0, shown)) {
        rows.push(truncateAnsi(`${t.neonCyan}${id}${t.reset} ${activity(this.i18n.t)}`, width));
      }
      if (shown < this.subagentActivity.size) rows.push(`+${this.subagentActivity.size - shown} · /subagents`);
      rows.push(`${t.border}${hline(width)}${t.reset}`);
    }

    // 2. Session & Target Telemetry
    rows.push(`${t.neonCyan}${t.bold}◈ ${this.i18n.upper(this.i18n.t("hud.telemetry"))}${t.reset}`);
    const kv = (k: string, v: string, color = t.fg): string =>
      truncateAnsi(
        `${t.muted}${padEndAnsi(k, 11)}${t.reset}${color}${v}${t.reset}`,
        width,
      );

    const targetName = this.status.target
      ? basenameOf(this.status.target)
      : this.status.analysisScope ? `${basenameOf(this.status.analysisScope.value)} (${this.status.analysisScope.historical ? this.i18n.t("hud.history") : this.i18n.t("hud.analysis")})` : this.i18n.t("hud.none");
    rows.push(
      kv(this.i18n.t("hud.target"), targetName, this.status.target ? t.fgBright : t.muted),
    );
    const binding = { open: "hud.open", closed: "hud.closed", unknown: "hud.bindingUnknown" } as const;
    if (this.status.nativeBinding) rows.push(kv(this.i18n.t("hud.binding"), this.i18n.t("hud.nativeBinding", { state: this.i18n.t(binding[this.status.nativeBinding]) }), t.muted));
    if (this.status.magic) {
      const sz = formatBytes(this.status.magic.sizeBytes);
      rows.push(
        kv(
          this.i18n.t("hud.format"),
          `${this.status.magic.label}${sz ? ` (${sz})` : ""}`,
          t.neonCyan,
        ),
      );
    }
    if (this.status.provider) {
      rows.push(kv(this.i18n.t("hud.provider"), this.status.provider, t.emerald));
    }
    const shortModel =
      this.status.model === "no-model" ? this.i18n.t("status.noModel")
        : this.status.model.split("/").at(-1) || this.status.model || "-";
    const hudModelLabel = this.status.modelProvider
      ? `${this.status.modelProvider}:${shortModel}`
      : shortModel;
    rows.push(kv(this.i18n.t("hud.model"), hudModelLabel, t.violet));
    rows.push(
      kv(
        this.i18n.t("hud.thinking"),
        this.status.effort === "auto" ? this.i18n.t("hud.effortAuto") : this.status.effort,
        this.status.effort === "auto" ? t.fg : t.neonMint,
      ),
    );
    const hasTps =
      typeof this.status.tps === "number" &&
      Number.isFinite(this.status.tps) &&
      this.status.tps > 0;
    const tpsText = hasTps
      ? `⚡ ${this.status.tps!.toFixed(1)} tok/s${this.status.ttftMs ? ` (${this.status.ttftMs}ms)` : ""}`
      : "⚡ -- tok/s";
    rows.push(
      kv(
        this.i18n.t("hud.speed"),
        tpsText,
        hasTps ? (this.status.tpsLive ? t.emerald : t.neonMint) : t.muted,
      ),
    );
    if (this.status.compactor) {
      rows.push(kv(this.i18n.t("hud.compact"), this.status.compactor, t.neonCyan));
    }
    if (this.networkGuard) {
      const g = this.networkGuard;
      const netVal =
        g.state === "restored"
          ? this.i18n.t("hud.online", { latency: g.latencyMs !== null ? ` (${g.latencyMs}ms)` : "" })
          : this.i18n.t("hud.ping", { attempt: g.attempt, time: g.target });
      rows.push(
        kv(this.i18n.t("hud.network"), netVal, g.state === "restored" ? t.emerald : t.amber),
      );
    }
    {
      const ctx = this.status.context;
      const barWidth = Math.max(4, Math.min(12, width - 9 - 8));
      rows.push(
        truncateAnsi(
          `${t.muted}${padEndAnsi(this.i18n.t("hud.context"), 11)}${t.reset}${contextBar(ctx.percent, barWidth, t)} ${contextColor(ctx.percent, t)}${ctx.source === "estimate" ? "~" : ""}${ctx.percent}%${t.reset}`,
          width,
        ),
      );
      rows.push(
        kv(
          "",
          `${ctx.source === "estimate" ? "~" : ""}${formatTokenCountShort(ctx.tokens)} / ${formatTokenCountShort(ctx.window)}${ctx.windowSource?.startsWith("conservative") ? this.i18n.t("hud.safe") : ""}`,
          t.muted,
        ),
      );
    }
    rows.push(
      kv(
        this.i18n.t("hud.ledger"),
        this.i18n.t("hud.ledgerCounts", { evidence: this.ledgerCount(this.status.evidence), unknowns: this.ledgerCount(this.status.unknowns) }),
        (this.status.evidence ?? 0) > 0 ? t.neonMint : t.fg,
      ),
    );
    if (this.status.unknownTotal !== undefined) rows.push(kv(this.i18n.t("hud.unknowns"), this.i18n.t("hud.unknownCounts", { total: this.ledgerCount(this.status.unknownTotal), resolved: this.ledgerCount(this.status.unknownResolved ?? null) }), t.muted));
    if (this.status.ledgerHealth) rows.push(kv(this.i18n.t("hud.source"),
      this.status.ledgerHealth === "live" ? this.i18n.t("hud.liveLedger") : ledgerHealthLabel(this.i18n, this.status.ledgerHealth),
      this.status.ledgerHealth === "live" ? t.muted : t.amber));
    rows.push(
      kv(
        this.i18n.t("hud.journal"),
        this.i18n.t("hud.events", { count: this.status.journalHealth === "unavailable" ? "?" : `#${this.status.journal}`, invalid: this.status.journalMalformed ? this.i18n.t("hud.invalid", { count: this.status.journalMalformed }) : "" }),
        t.fg,
      ),
    );
    rows.push(kv(this.i18n.t("hud.usage"), `${formatTokenCount(this.status.tokens)} tok${this.status.estimatedTokens ? this.i18n.t("hud.estimated", { count: formatTokenCount(this.status.estimatedTokens) }) : ""}${this.status.priorUsageUnknown ? this.i18n.t("hud.prior") : ""}`, t.muted));

    if (rows.length + 2 >= height) return rows.slice(0, height);

    rows.push(`${t.border}${hline(width)}${t.reset}`);
    rows.push(`${t.indigo}${t.bold}◈ ${this.i18n.upper(this.i18n.t("hud.calls"))}${t.reset}`);

    const remaining = Math.max(0, height - rows.length);
    const recentCalls: ToolCallItem[] = [];
    for (
      let i = this.timeline.length - 1;
      i >= 0 && recentCalls.length < remaining;
      i -= 1
    ) {
      const entry = this.timeline[i]!;
      if (entry.kind !== "tools") continue;
      for (
        let j = entry.calls.length - 1;
        j >= 0 && recentCalls.length < remaining;
        j -= 1
      ) {
        recentCalls.push(entry.calls[j]!);
      }
    }
    recentCalls.reverse();

    if (recentCalls.length === 0) {
      rows.push(`${t.muted}${this.i18n.t("hud.noCalls")}${t.reset}`);
    } else {
      for (const call of recentCalls) {
        const icon =
          call.status === "running"
            ? `${t.neonCyan}${SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length]}${t.reset}`
            : call.status === "ok"
              ? `${t.emerald}✓${t.reset}`
              : `${t.crimson}✗${t.reset}`;
        const dur =
          call.status === "running"
            ? " …"
            : call.durationMs > 0
              ? ` ${formatDuration(call.durationMs)}`
              : "";
        rows.push(
          truncateAnsi(
            `${icon} ${t.fg}${call.displayTool}${t.reset}${t.muted}${dur}${t.reset}`,
            width,
          ),
        );
      }
    }

    return rows.slice(0, height);
  }

  private wrappedOutputLines(innerW: number): readonly string[] {
    if (
      this.outputWrapCache &&
      this.outputWrapCache.text === this.output.text &&
      this.outputWrapCache.width === innerW
    ) {
      return this.outputWrapCache.lines;
    }
    const wrapped = this.output.label === "/changelog"
      ? renderMarkdown(this.output.text, innerW, this.theme, false, true, this.i18n.language)
      : wrapPlain(this.output.text, innerW, true);
    this.outputWrapCache = {
      text: this.output.text,
      width: innerW,
      lines: wrapped,
    };
    return wrapped;
  }

  private renderPaletteBox(
    cols: number,
    maxRows: number,
    items: readonly PaletteItem[],
  ): string[] {
    const t = this.theme;
    const visibleCount = Math.max(
      1,
      Math.min(Math.max(1, items.length), maxRows - 2),
    );
    const sel =
      items.length > 0 ? Math.min(this.paletteSelected, items.length - 1) : 0;
    const offset =
      sel >= visibleCount
        ? Math.min(items.length - visibleCount, sel - visibleCount + 1)
        : 0;

    const lines: string[] = [];
    const title =
      items[0]?.kind === "mention"
        ? this.i18n.t("palette.mentions")
        : items[0]?.kind === "path"
          ? this.i18n.t("palette.files")
          : items[0]?.kind === "arg"
            ? this.i18n.t("palette.options")
            : this.i18n.t("palette.commands");
    const hint = this.i18n.t("palette.hint", { count: items.length });
    lines.push(
      this.renderBoxTop(cols, title, hint, t.borderActive, t.neonCyan),
    );

    const hasScroll = items.length > visibleCount;
    const thumbSize = hasScroll
      ? Math.max(1, Math.round((visibleCount / items.length) * visibleCount))
      : visibleCount;
    const thumbStart = hasScroll
      ? Math.min(
          visibleCount - thumbSize,
          Math.round(
            (offset / Math.max(1, items.length - visibleCount)) *
              (visibleCount - thumbSize),
          ),
        )
      : 0;

    const innerW = Math.max(8, cols - 4);
    for (let i = 0; i < visibleCount; i += 1) {
      const item = items[offset + i];
      const active = offset + i === sel;
      const rightBorder =
        hasScroll && i >= thumbStart && i < thumbStart + thumbSize
          ? `${t.neonMint}┃${t.reset}`
          : `${t.borderActive}│${t.reset}`;
      if (!item) {
        const empty = padEndAnsi(
          `${t.muted}${this.i18n.t("palette.noMatches")}${t.reset}`,
          innerW,
        );
        lines.push(`${t.borderActive}│${t.reset} ${empty} ${rightBorder}`);
        continue;
      }
      const badgeColor =
        item.badgeKind === "workflow"
          ? `${t.pillMintBg}${t.neonMint}`
          : item.badgeKind === "prompt" || item.badgeKind === "arg"
            ? `${t.pillVioletBg}${t.violet}`
            : item.badgeKind === "path"
              ? `${t.pillAmberBg}${t.amber}`
              : `${t.pillCyanBg}${t.neonCyan}`;
      const marker = active ? `${t.neonMint}${t.bold}▸${t.reset}` : " ";
      const usagePart = item.usage ? ` ${t.muted}${item.usage}${t.reset}` : "";
      const leftCol = `${marker} ${badgeColor} ${padEndAnsi(this.paletteBadge(item.badge), 5)} ${t.reset} ${active ? `${t.bold}${t.fgBright}` : t.fg}${item.label}${t.reset}${usagePart}`;
      const paddedLeft = padEndAnsi(
        leftCol,
        Math.min(38, Math.floor(innerW * 0.48)),
      );
      const shortcutBadge =
        item.shortcut && innerW >= 54
          ? ` ${t.neonCyan}[${item.shortcut}]${t.reset}`
          : "";
      const shortcutW = visibleWidth(shortcutBadge);
      const descBudget = Math.max(
        4,
        innerW - visibleWidth(paddedLeft) - 2 - shortcutW,
      );
      const desc = truncateAnsi(
        `${active ? t.fg : t.muted}${item.description}${t.reset}`,
        descBudget,
      );
      const leftAndDesc = padEndAnsi(
        `${paddedLeft}  ${desc}`,
        Math.max(4, innerW - shortcutW),
      );
      const rowBody = padEndAnsi(`${leftAndDesc}${shortcutBadge}`, innerW);
      const bg = active ? t.selBg : "";
      lines.push(
        `${t.borderActive}│${t.reset} ${bg}${rowBody}${t.reset} ${rightBorder}`,
      );
    }

    lines.push(`${t.borderActive}╰${hline(cols - 2)}╯${t.reset}`);
    return lines;
  }

  private renderOutputDrawerBox(cols: number, maxRows: number): string[] {
    const t = this.theme;
    const innerW = Math.max(8, cols - 4);
    const wrapped = this.wrappedOutputLines(innerW);
    const bodyRows = Math.max(1, Math.min(wrapped.length, maxRows - 2));
    const shown = wrapped.slice(0, bodyRows);
    const more = wrapped.length - shown.length;
    const hint =
      more > 0
        ? this.i18n.t("drawer.more", { count: more })
        : this.i18n.t("drawer.lines", { count: wrapped.length });
    const isErr = this.output.label.includes("error") || this.output.label === this.i18n.t("common.errorTitle");
    const borderColor = isErr ? t.crimson : t.borderActive;
    const titleColor = isErr ? t.crimson : t.neonMint;

    const lines: string[] = [];
    lines.push(
      this.renderBoxTop(
        cols,
        `◈ ${this.output.label}`,
        hint,
        borderColor,
        titleColor,
      ),
    );
    for (let i = 0; i < bodyRows; i += 1) {
      const styled = styleInlineMarkdown(
        shown[i] ?? "",
        t,
        isErr ? t.crimson : t.fg,
      );
      const row = padEndAnsi(styled, innerW);
      lines.push(`${borderColor}│${t.reset} ${row} ${borderColor}│${t.reset}`);
    }
    lines.push(`${borderColor}╰${hline(cols - 2)}╯${t.reset}`);
    return lines;
  }

  private renderNetworkGuardBox(cols: number): string[] {
    const t = this.theme;
    const g = this.networkGuard;
    if (!g) return [];
    const innerW = Math.max(8, cols - 4);
    const isRestored = g.state === "restored";
    const borderColor = isRestored ? t.emerald : t.amber;
    const titleColor = isRestored ? t.emerald : t.amber;
    const elapsed = formatDuration(Math.max(0, Date.now() - g.startedAt));
    const title = isRestored
      ? this.i18n.t("net.restored")
      : cols >= 72
        ? this.i18n.t("net.paused")
        : this.i18n.t("net.hold");
    const hint = isRestored
      ? this.i18n.t("net.resumed", { time: elapsed })
      : this.i18n.t("net.ping", { attempt: g.attempt, time: elapsed });

    let bodyText: string;
    if (isRestored) {
      const lat =
        g.latencyMs !== null ? ` ${t.neonMint}(${g.latencyMs}ms)${t.reset}` : "";
      bodyText =
        `${t.emerald}${t.bold}✓ ${this.i18n.t("net.pingOk")} ──▸ ${g.target}${t.reset}${lat}` +
        `${t.muted} · ${t.reset}${t.emerald}✓ ${this.i18n.t("net.continuing")}${t.reset}`;
    } else {
      const spin = SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length];
      const reasonClipped = g.reason
        ? truncateAnsi(g.reason, Math.max(12, Math.floor(innerW * 0.36)))
        : this.i18n.t("net.waiting");
      const holdNote =
        cols >= 84
          ? `${t.muted} · ${this.i18n.t("net.holding")}${t.reset}`
          : "";
      bodyText =
        `${t.amber}${spin}${t.reset} ${t.neonCyan}${t.bold}${this.i18n.t("net.pingLabel")} ──▸ ${g.target}${t.reset}` +
        `${t.muted} · ${t.reset}${t.amber}${reasonClipped}${t.reset}${holdNote}`;
    }

    const row = padEndAnsi(truncateAnsi(bodyText, innerW), innerW);
    return [
      this.renderBoxTop(cols, title, hint, borderColor, titleColor),
      `${borderColor}│${t.reset} ${row} ${borderColor}│${t.reset}`,
      `${borderColor}╰${hline(cols - 2)}╯${t.reset}`,
    ];
  }

  private renderNetworkGuardCompactLine(cols: number): string {
    const t = this.theme;
    const g = this.networkGuard;
    if (!g) return "";
    const innerW = Math.max(8, cols - 4);
    if (g.state === "restored") {
      const lat = g.latencyMs !== null ? ` (${g.latencyMs}ms)` : "";
      const body = padEndAnsi(
        truncateAnsi(
          `${t.emerald}${t.bold}✓ ${this.i18n.upper(this.i18n.t("net.title"))} · ${this.i18n.t("net.pingOk")} ──▸ ${g.target}${lat} · ${this.i18n.t("net.resuming")}${t.reset}`,
          innerW,
        ),
        innerW,
      );
      return `${t.emerald}│${t.reset} ${body} ${t.emerald}│${t.reset}`;
    }
    const spin = SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length];
    const body = padEndAnsi(
      truncateAnsi(
        `${t.amber}${spin} ${this.i18n.upper(this.i18n.t("net.title"))} · ${t.neonCyan}${this.i18n.t("net.pingLabel")} ──▸ ${g.target}${t.amber} #${g.attempt} · ${g.reason || this.i18n.t("net.offline")}${t.reset}`,
        innerW,
      ),
      innerW,
    );
    return `${t.amber}│${t.reset} ${body} ${t.amber}│${t.reset}`;
  }

  private renderSteeringBox(cols: number): string[] {
    const t = this.theme;
    if (this.queuedSteers.length === 0) return [];
    const innerW = Math.max(8, cols - 4);
    const star = THINKING_STAR_FRAMES[this.tick % THINKING_STAR_FRAMES.length];
    const title = this.i18n.t("steer.queue", { icon: star, count: this.queuedSteers.length });
    const hint =
      cols >= 84
        ? this.i18n.t("steer.fullHint")
        : this.i18n.t("steer.hint");
    const out: string[] = [
      this.renderBoxTop(cols, title, hint, t.amber, t.amber),
    ];
    const shown = this.queuedSteers.slice(-3);
    const startIdx = Math.max(0, this.queuedSteers.length - shown.length);
    for (let i = 0; i < shown.length; i += 1) {
      const msg = shown[i]!.replace(/\s+/g, " ");
      const rowText = `${t.amber}${t.bold}${startIdx + i + 1}.${t.reset} ${t.fgBright}${msg}${t.reset}`;
      const padded = padEndAnsi(truncateAnsi(rowText, innerW), innerW);
      out.push(`${t.amber}│${t.reset} ${padded} ${t.amber}│${t.reset}`);
    }
    out.push(`${t.amber}╰${hline(cols - 2)}╯${t.reset}`);
    return out;
  }

  private renderStagedImagesStrip(cols: number): string {
    const t = this.theme;
    const innerW = Math.max(8, cols - 4);
    const pills = this.stagedImages
      .map(
        (img) =>
          `${t.pillCyanBg}${t.neonCyan}${t.bold} 📎 ${img.label} ${t.reset}`,
      )
      .join(" ");
    const hint = `${t.muted} · ${this.i18n.t("clipboard.strip")}${t.reset}`;
    const body = padEndAnsi(truncateAnsi(`${pills}${hint}`, innerW), innerW);
    return `${t.borderActive}│${t.reset} ${body} ${t.borderActive}│${t.reset}`;
  }

  private ledgerCount(value: number | null): string {
    const old=this.status.ledgerObservedAt&&Date.now()-Date.parse(this.status.ledgerObservedAt)>30000;
    return value === null ? "?" : old||this.status.ledgerHealth && this.status.ledgerHealth !== "live" ? `~${value}` : String(value);
  }

  private renderStatusBar(width: number): string {
    const t = this.theme;
    const shortModel =
      this.status.model && this.status.model !== "no-model"
        ? this.status.model.split("/").at(-1) || this.status.model
        : this.i18n.t("status.noModel");
    const modelLabel = this.status.modelProvider
      ? `${this.status.modelProvider}:${shortModel}`
      : shortModel;
    const effortTag =
      this.status.effort !== "auto"
        ? ` ${t.neonCyan}[${this.status.effort}]${t.reset}`
        : "";
    const hasTps =
      typeof this.status.tps === "number" &&
      Number.isFinite(this.status.tps) &&
      this.status.tps > 0;
    const tpsTag = hasTps
      ? `${t.muted} · ${t.reset}${this.status.tpsLive ? t.emerald : t.neonMint}⚡ ${this.status.tps!.toFixed(1)} tps${t.reset}`
      : "";
    const ctx = this.status.context;
    const ctxTag =
      `${t.muted} · ${this.i18n.t("status.context")} ${t.reset}${contextColor(ctx.percent, t)}${ctx.source === "estimate" ? "~" : ""}${ctx.percent}%${t.reset}` +
      (width >= 148
        ? `${t.muted} ${formatTokenCountShort(ctx.tokens)}/${formatTokenCountShort(ctx.window)}${t.reset}`
        : "");
    const target = this.status.target
      ? basenameOf(this.status.target)
      : this.status.analysisScope ? `${basenameOf(this.status.analysisScope.value)}[${this.status.analysisScope.historical ? this.i18n.t("hud.history") : this.i18n.t("hud.analysis")}]` : "";
    const scrollTag = this.scroll > 0 ? ` · ↑${this.scroll}` : "";
    const tokTag =
      this.status.tokens > 0
        ? ` · ${formatTokenCount(this.status.tokens)} tok`
        : "";

    let rightRendered: string;
    if (this.clipboardNotice && Date.now() < this.clipboardNotice.until) {
      rightRendered = `${t.neonMint}${t.bold}${this.clipboardNotice.text(this.i18n.t)}${t.reset}`;
    } else if (this.hasActiveSelection()) {
      rightRendered = `${t.neonCyan}${t.bold}${this.i18n.t("status.selection")}${t.reset}`;
    } else if (this.busy) {
      const label = typeof this.busy === "function" ? this.busy(this.i18n.t) : this.busy;
      const spin = SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length];
      const elapsed =
        this.busyStartedAt > 0
          ? ` ${formatDuration(Date.now() - this.busyStartedAt)}`
          : "";
      const pulse =
        this.binaryMode !== "off"
          ? `${renderBinaryPulse(this.tick, this.status.magic?.bytes ?? null, t, 6)} `
          : "";
      rightRendered = label ? `${pulse}${t.neonCyan}${spin} ${label}${elapsed}${t.reset} ${t.muted}(${this.i18n.t("status.cancel")})${t.reset}` : "";
    } else if (Date.now() < this.ctrlCArmedUntil) {
      rightRendered = `${t.amber}${t.bold}${this.i18n.t("status.exit")}${t.reset}`;
    } else if (width < 96) {
      rightRendered = `${t.muted}Alt+M · Ctrl+V · /${t.reset}`;
    } else if (width < 148) {
      rightRendered = `${t.muted}${this.i18n.t("status.models")} · ${this.i18n.t("status.commands")}${this.output.text ? this.i18n.t("status.output") : ""}${t.reset}`;
    } else {
      const thinkHint = width >= 108 ? this.i18n.t("status.think") : "";
      const clipHint = this.i18n.t("status.paste");
      rightRendered = `${t.muted}${this.i18n.t("status.models")}${thinkHint}${clipHint} · ${this.i18n.t("status.commands")}${this.output.text ? this.i18n.t("status.output") : ""}${t.reset}`;
    }

    if (this.subagentActivity.size) {
      const title = this.i18n.t("status.subagents", { count: this.subagentActivity.size });
      const ids = [...this.subagentActivity.keys()].map((id) => /^sub-\d+/.exec(id)?.[0] ?? id);
      const budget = Math.floor(width * 0.63);
      const parts = [title];
      for (const [index, id] of ids.entries()) {
        const remaining = ids.length - index - 1;
        if (visibleWidth(`${parts.join(" ")} ${id}${remaining ? ` +${remaining}` : ""}`) > budget) {
          parts.push(`+${remaining + 1}`);
          break;
        }
        parts.push(id);
      }
      const spin = SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length];
      const workers = `${t.neonCyan}${spin} ${parts.join(" ")}${t.reset}`;
      const spare = Math.max(0, width - visibleWidth(workers) - 42);
      rightRendered = spare >= 15 ? `${workers} · ${truncateAnsi(rightRendered, spare - 3)}` : workers;
    }
    const rightW = visibleWidth(rightRendered);
    const leftBudget = Math.max(8, width - rightW - 2);
    const metrics = effortTag + tpsTag + ctxTag +
      `${t.muted} · ${this.i18n.t("status.evidence")}:${t.reset}${t.neonMint}${this.ledgerCount(this.status.evidence)}${t.reset}` +
      `${t.muted} · ${this.i18n.t("status.unknowns")}:${t.reset}${(this.status.unknowns ?? 0) > 0 ? t.amber : t.muted}${this.ledgerCount(this.status.unknowns)}${t.reset}` +
      `${t.muted} · ${this.i18n.t("status.journal")}:${this.status.journal}${tokTag}${scrollTag}${t.reset}`;

    const identityBudget = Math.max(0, leftBudget - visibleWidth(metrics) - 3);
    const modelBudget = target ? Math.ceil(identityBudget * 0.6) : identityBudget;
    const shownModel = truncateAnsi(modelLabel, modelBudget);
    const shownTarget = truncateAnsi(target, Math.max(0, identityBudget - visibleWidth(shownModel) - 3));
    const targetTag = shownTarget ? `${t.muted} · ${t.reset}${t.fg}${shownTarget}${t.reset}` : "";
    const leftText = ` ${t.violet}◆ ${shownModel}${t.reset}${targetTag}${metrics}`;

    const leftPadded = padEndAnsi(leftText, leftBudget);
    return truncateAnsi(`${leftPadded}  ${rightRendered}`, width);
  }

  private renderModelPickerModalFrame(
    cols: number,
    rows: number,
  ): RenderedFrame {
    const t = this.theme;
    const tabs = this.pickerTabs();
    const selTab =
      tabs.length > 0
        ? Math.min(Math.max(0, this.picker.selectedTab), tabs.length - 1)
        : 0;
    const activeTab = tabs[selTab];
    const rowsList = this.pickerRows();
    const selRow =
      rowsList.length > 0
        ? Math.min(Math.max(0, this.picker.selectedRow), rowsList.length - 1)
        : 0;

    const isEffortStage = this.picker.stage === "effort";
    const connectedCount = this.picker.providers.filter(
      (p) => p.connected,
    ).length;
    const localCount = this.picker.providers.filter((p) => p.local).length;
    const innerW = Math.max(8, cols - 4);
    const twoPane = cols >= 76 && rows >= 12;
    const hasFooter = isEffortStage ? rows >= 10 : rows >= 13;
    const footerInfoRows = isEffortStage
      ? rows >= 14
        ? 3
        : rows >= 11
          ? 2
          : hasFooter
            ? 1
            : 0
      : rows >= 15
        ? 2
        : hasFooter
          ? 1
          : 0;
    const overhead = 3 + (hasFooter ? 1 + footerInfoRows : 0) + 2;
    const bodyRows = Math.max(2, rows - overhead);

    const lines: string[] = [];

    // 1. Top title border
    const spinBadge = this.picker.loading
      ? this.i18n.t("picker.live", { count: SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length] })
      : "";
    const isCompactionPicker = this.picker.purpose === "compaction";
    const modalTitle = isEffortStage
      ? this.picker.effortOnly
        ? this.i18n.t("picker.effort")
        : this.i18n.t("picker.effortStep")
      : isCompactionPicker
        ? this.i18n.t("picker.compactionTitle", { live: spinBadge })
        : this.i18n.t("picker.modelsTitle", { live: spinBadge });
    const topHint =
      cols >= 74
        ? this.i18n.t("picker.connectionCounts", { connected: connectedCount, local: localCount, total: this.picker.providers.length, action: this.i18n.t(isEffortStage && !this.picker.effortOnly ? "picker.backAction" : "picker.close") })
        : `${connectedCount}/${this.picker.providers.length} · esc`;
    lines.push(
      this.renderBoxTop(cols, modalTitle, topHint, t.borderActive, t.neonMint),
    );

    // 2. Search & active indicator bar
    const activeShort =
      this.picker.activeModelId.split("/").at(-1) ||
      this.picker.activeModelId ||
      this.i18n.t("hud.none");
    const primarySummary = this.picker.activeProviderId
      ? `${this.picker.activeProviderId}:${activeShort}`
      : activeShort;
    const activeSummary = isCompactionPicker
      ? this.i18n.t("picker.compactLabel", { model: this.picker.compactionModelSpec || this.i18n.t("picker.activeLabel", { model: primarySummary }) })
      : primarySummary;
    const rightActive =
      innerW >= 44
        ? `${t.violet}◆ ${truncateAnsi(activeSummary, Math.min(28, Math.floor(innerW * 0.36)))}${t.reset}`
        : "";
    const rightActiveW = visibleWidth(rightActive);
    const searchTextBudget = Math.max(
      6,
      innerW - (rightActiveW > 0 ? rightActiveW + 2 : 0) - 2,
    );

    let shownQuery = this.picker.query;
    while (visibleWidth(shownQuery) > searchTextBudget) {
      shownQuery = shownQuery.slice(1);
    }
    const searchLeft =
      shownQuery.length > 0
        ? `${t.neonCyan}${t.bold}⌕ ${t.reset}${t.fgBright}${shownQuery}${t.reset}`
        : `${t.neonCyan}${t.bold}⌕ ${t.reset}${t.muted}${truncateAnsi(
            this.i18n.t("picker.filter"),
            searchTextBudget,
          )}${t.reset}`;
    const searchLeftPadded = padEndAnsi(
      searchLeft,
      Math.max(4, innerW - (rightActiveW > 0 ? rightActiveW : 0)),
    );
    const searchRowInner = padEndAnsi(
      `${searchLeftPadded}${rightActive}`,
      innerW,
    );
    lines.push(
      `${t.borderActive}│${t.reset} ${searchRowInner} ${t.borderActive}│${t.reset}`,
    );

    // 3. Body (Two-pane on >= 76 cols, compact single-pane on < 76 cols)
    if (twoPane) {
      const leftPaneW = Math.min(
        28,
        Math.max(20, Math.floor((cols - 7) * 0.3)),
      );
      const rightPaneW = Math.max(16, cols - 7 - leftPaneW);

      lines.push(
        `${t.borderActive}├${hline(leftPaneW + 2)}┬${hline(rightPaneW + 2)}┤${t.reset}`,
      );

      const hasHeader = bodyRows >= 3;
      const listRows = hasHeader ? bodyRows - 1 : bodyRows;

      if (hasHeader) {
        const leftHdr = padEndAnsi(
          `${t.neonCyan}${t.bold}${this.i18n.upper(this.i18n.t("picker.providers"))}${t.reset} ${t.muted}(Tab/←→)${t.reset}`,
          leftPaneW,
        );
        const rightHdr = padEndAnsi(
          `${t.neonMint}${t.bold}${this.i18n.upper(this.i18n.t("picker.models"))}${t.reset} ${t.muted}(${this.i18n.t("picker.shown", { count: rowsList.length })})${t.reset}`,
          rightPaneW,
        );
        lines.push(
          `${t.borderActive}│${t.reset} ${leftHdr} ${t.borderActive}│${t.reset} ${rightHdr} ${t.borderActive}│${t.reset}`,
        );
      }

      const tabOffset =
        selTab >= listRows
          ? Math.min(Math.max(0, tabs.length - listRows), selTab - listRows + 1)
          : 0;
      const rowOffset =
        selRow >= listRows
          ? Math.min(
              Math.max(0, rowsList.length - listRows),
              selRow - listRows + 1,
            )
          : 0;

      for (let i = 0; i < listRows; i += 1) {
        const tabIdx = tabOffset + i;
        const tab = tabs[tabIdx];
        const isTabSel = tabIdx === selTab;
        let leftCell = "";
        if (tab) {
          const dot =
            tab.id === "all"
              ? `${t.neonMint}◈${t.reset}`
              : tab.connected
                ? `${t.emerald}●${t.reset}`
                : tab.local
                  ? `${t.neonCyan}◌${t.reset}`
                  : `${t.subtle}○${t.reset}`;
          const ptr = isTabSel ? `${t.neonCyan}${t.bold}▸${t.reset}` : " ";
          const cnt = `${t.muted}${String(tab.modelCount)}${t.reset}`;
          const cntW = visibleWidth(cnt);
          const nameBudget = Math.max(6, leftPaneW - 5 - cntW);
          const nameColor = isTabSel
            ? `${t.bold}${t.fgBright}`
            : tab.connected
              ? t.fg
              : t.muted;
          const namePart = truncateAnsi(
            `${nameColor}${tab.label}${t.reset}`,
            nameBudget,
          );
          const leftLead = padEndAnsi(
            `${ptr}${dot} ${namePart}`,
            Math.max(4, leftPaneW - cntW),
          );
          leftCell = `${isTabSel ? t.selBg : ""}${padEndAnsi(`${leftLead}${cnt}`, leftPaneW)}${t.reset}`;
        } else {
          leftCell = padEndAnsi("", leftPaneW);
        }

        const rIdx = rowOffset + i;
        const mRow = rowsList[rIdx];
        const isRowSel = rIdx === selRow;
        let rightCell = "";
        if (rowsList.length === 0 && i === 0) {
          const emptyHint =
            activeTab?.provider &&
            !activeTab.provider.connected &&
            !activeTab.provider.local
              ? this.i18n.t("picker.connect", { key: activeTab.provider.envHint, provider: activeTab.provider.name })
              : this.i18n.t("picker.noResults");
          rightCell = padEndAnsi(
            `${t.muted}${truncateAnsi(emptyHint, rightPaneW)}${t.reset}`,
            rightPaneW,
          );
        } else if (mRow) {
          const ptr = isRowSel
            ? `${t.neonMint}${t.bold}▸${t.reset}`
            : mRow.active
              ? `${t.violet}★${t.reset}`
              : " ";
          const badge = mRow.active
            ? `${t.pillVioletBg}${t.violet} ACTV ${t.reset}`
            : mRow.source === "inherit-active"
              ? `${t.pillMintBg}${t.neonMint} DFLT ${t.reset}`
              : mRow.source === "custom-input"
                ? `${t.pillAmberBg}${t.amber} USE+ ${t.reset}`
                : mRow.source === "live"
                  ? `${t.pillMintBg}${t.neonMint} LIVE ${t.reset}`
                  : mRow.source === "configured"
                    ? `${t.pillCyanBg}${t.neonCyan} CFG  ${t.reset}`
                    : !mRow.provider.connected && !mRow.provider.local
                      ? `${t.pillAmberBg}${t.amber} KEY? ${t.reset}`
                      : mRow.provider.local
                        ? `${t.pillCyanBg}${t.neonCyan} LOCL ${t.reset}`
                        : `${t.pillCyanBg}${t.neonCyan} RDY  ${t.reset}`;
          const provPrefix =
            selTab === 0 && mRow.source !== "inherit-active"
              ? `${t.muted}${mRow.provider.id}:${t.reset}`
              : "";
          const modelColor = isRowSel
            ? `${t.bold}${t.fgBright}`
            : mRow.active
              ? t.fgBright
              : t.fg;
          const customSuffix =
            mRow.source === "custom-input"
              ? ` ${t.muted}${this.i18n.t("picker.customId")}${t.reset}`
              : mRow.note
                ? ` ${t.muted}· ${mRow.note}${t.reset}`
                : "";
          const rawRight = truncateAnsi(
            `${ptr} ${badge} ${provPrefix}${modelColor}${mRow.modelId}${t.reset}${customSuffix}`,
            rightPaneW,
          );
          rightCell = `${isRowSel ? t.selBg : ""}${padEndAnsi(rawRight, rightPaneW)}${t.reset}`;
        } else {
          rightCell = padEndAnsi("", rightPaneW);
        }

        lines.push(
          `${t.borderActive}│${t.reset} ${leftCell} ${t.borderActive}│${t.reset} ${rightCell} ${t.borderActive}│${t.reset}`,
        );
      }

      if (hasFooter) {
        lines.push(
          `${t.borderActive}├${hline(leftPaneW + 2)}┴${hline(rightPaneW + 2)}┤${t.reset}`,
        );
      }
    } else {
      lines.push(`${t.borderActive}├${hline(cols - 2)}┤${t.reset}`);
      const tabBanner = activeTab
        ? `${t.neonCyan}◀${t.reset} ${t.bold}${t.fgBright}${activeTab.label}${t.reset} ${t.muted}(${rowsList.length}) · ${this.i18n.t("picker.providerNav")} ▶${t.reset}`
        : "";
      lines.push(
        `${t.borderActive}│${t.reset} ${padEndAnsi(tabBanner, innerW)} ${t.borderActive}│${t.reset}`,
      );

      const listRows = Math.max(1, bodyRows - 1);
      const rowOffset =
        selRow >= listRows
          ? Math.min(
              Math.max(0, rowsList.length - listRows),
              selRow - listRows + 1,
            )
          : 0;
      for (let i = 0; i < listRows; i += 1) {
        const rIdx = rowOffset + i;
        const mRow = rowsList[rIdx];
        const isRowSel = rIdx === selRow;
        let cell = "";
        if (!mRow) {
          cell = padEndAnsi(
            i === 0 ? `${t.muted}${this.i18n.t("picker.noMatching")}${t.reset}` : "",
            innerW,
          );
        } else {
          const ptr = isRowSel
            ? `${t.neonMint}${t.bold}▸${t.reset}`
            : mRow.active
              ? `${t.violet}★${t.reset}`
              : " ";
          const provPrefix =
            selTab === 0 ? `${t.muted}${mRow.provider.id}:${t.reset}` : "";
          const raw = `${ptr} ${provPrefix}${isRowSel ? `${t.bold}${t.fgBright}` : t.fg}${mRow.modelId}${t.reset}`;
          cell = `${isRowSel ? t.selBg : ""}${padEndAnsi(raw, innerW)}${t.reset}`;
        }
        lines.push(
          `${t.borderActive}│${t.reset} ${cell} ${t.borderActive}│${t.reset}`,
        );
      }

      if (hasFooter) {
        lines.push(`${t.borderActive}├${hline(cols - 2)}┤${t.reset}`);
      }
    }

    // 4. Detail / Setup OR Thinking Effort Footer
    if (hasFooter && footerInfoRows > 0) {
      if (isEffortStage) {
        const selEffIdx = Math.min(
          Math.max(0, this.picker.selectedEffortIndex),
          REASONING_EFFORT_LEVELS.length - 1,
        );
        const targetProv =
          this.picker.pendingProviderId ?? this.picker.activeProviderId;
        const rawTargetModel =
          this.picker.pendingModelId ||
          this.picker.activeModelId ||
          this.status.model ||
          "current-model";
        const shortTargetModel =
          rawTargetModel.split("/").at(-1) || rawTargetModel;
        const targetSpec = targetProv
          ? `${targetProv}:${shortTargetModel}`
          : shortTargetModel;
        const saveBadge = this.picker.pendingSaveDefault
          ? ` ${t.pillAmberBg}${t.amber} ${this.i18n.upper(this.i18n.t("picker.saveDefault"))} ${t.reset}`
          : "";
        const backHint = this.picker.effortOnly
          ? this.i18n.t("picker.cancel")
          : this.i18n.t("picker.back");

        const pillStrings = REASONING_EFFORT_LEVELS.map((lvl, idx) => {
          const isSel = idx === selEffIdx;
          const isCur = lvl.id === this.picker.activeEffort;
          if (innerW >= 60) {
            if (isSel)
              return `${t.pillMintBg}${t.neonMint}${t.bold} ▸ ${lvl.label} ${t.reset}`;
            if (isCur)
              return `${t.pillVioletBg}${t.violet} ★ ${lvl.label} ${t.reset}`;
            return `${t.muted} ${lvl.label} ${t.reset}`;
          }
          const compact =
            lvl.id === "minimal"
              ? "min"
              : lvl.id === "medium"
                ? "med"
                : lvl.label;
          if (isSel)
            return `${t.pillMintBg}${t.neonMint}${t.bold}▸${compact}${t.reset}`;
          if (isCur) return `${t.violet}*${compact}${t.reset}`;
          return `${t.muted}${compact}${t.reset}`;
        });
        const pillsLine = pillStrings.join(" ");

        if (footerInfoRows === 1) {
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(pillsLine, innerW)} ${t.borderActive}│${t.reset}`,
          );
        } else {
          const info1 =
            `${t.neonMint}${t.bold}◈ ${this.i18n.upper(this.i18n.t("picker.thinkingTitle"))}${t.reset} ${t.muted}${this.i18n.t("picker.for")}${t.reset} ` +
            `${t.violet}${t.bold}◆ ${targetSpec}${t.reset}${saveBadge}` +
            `${t.muted} · ←/→ or 1-7 · ${backHint}${t.reset}`;
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(info1, innerW)} ${t.borderActive}│${t.reset}`,
          );
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(pillsLine, innerW)} ${t.borderActive}│${t.reset}`,
          );

          if (footerInfoRows >= 3) {
            const chosenLvl =
              REASONING_EFFORT_LEVELS[selEffIdx] ?? REASONING_EFFORT_LEVELS[0]!;
            const budgetNote = chosenLvl.anthropicBudget
              ? this.i18n.t("picker.thinkingBudget", { budget: chosenLvl.anthropicBudget.toLocaleString(this.i18n.language), effort: chosenLvl.id })
              : chosenLvl.id === "off"
                ? this.i18n.t("picker.disablesThinking")
                : this.i18n.t("picker.defaultThinking");
            const info3 = `${t.neonCyan}▸ ${chosenLvl.label}${t.reset}${t.muted} — ${this.i18n.t(`effort.${chosenLvl.id}`)}${budgetNote}${t.reset}`;
            lines.push(
              `${t.borderActive}│${t.reset} ${padEndAnsi(info3, innerW)} ${t.borderActive}│${t.reset}`,
            );
          }
        }
      } else {
        const focusProvider =
          rowsList[selRow]?.provider ??
          activeTab?.provider ??
          this.picker.providers.find((p) => p.connected) ??
          this.picker.providers[0];

        if (focusProvider) {
          const statePill = focusProvider.connected
            ? `${t.emerald}${this.i18n.t("picker.connected")}${t.reset}`
            : focusProvider.local
              ? `${t.neonCyan}${this.i18n.t("picker.local")}${t.reset}`
              : `${t.amber}${this.i18n.t("picker.keyMissing")}${t.reset}`;
          const authInfo =
            focusProvider.connected || focusProvider.local
              ? focusProvider.keySource
              : this.i18n.t("picker.export", { key: focusProvider.envHint });
          const info1 =
            `${statePill} ${t.fgBright}${t.bold}${focusProvider.name}${t.reset}` +
            `${t.muted} · ${focusProvider.protocol} · ${focusProvider.baseUrl || this.i18n.t("picker.urlRequired")} · ${authInfo}${t.reset}`;
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(info1, innerW)} ${t.borderActive}│${t.reset}`,
          );
        } else {
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi("", innerW)} ${t.borderActive}│${t.reset}`,
          );
        }

        if (footerInfoRows >= 2) {
          let info2: string;
          if (this.picker.notice) {
            const notice = typeof this.picker.notice === "function" ? this.picker.notice(this.i18n.t) : this.picker.notice;
            info2 = `${t.amber}◈ ${notice}${t.reset}`;
          } else if (
            focusProvider &&
            !focusProvider.connected &&
            !focusProvider.local
          ) {
            info2 = `${t.muted}${this.i18n.t("picker.configure", { key: `export ${focusProvider.envHint}="…"`, provider: focusProvider.id })}${t.reset}`;
          } else if (focusProvider?.error) {
            info2 = `${t.amber}${this.i18n.t("picker.modelNote", { message: focusProvider.error })}${t.reset}`;
          } else {
            info2 = `${t.muted}${this.i18n.t("picker.modelKeys")}${t.reset}`;
          }
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(info2, innerW)} ${t.borderActive}│${t.reset}`,
          );
        }
      }
    }

    // 5. Bottom border & keybar
    lines.push(`${t.borderActive}╰${hline(cols - 2)}╯${t.reset}`);
    const foot = isEffortStage
      ? `${t.muted} ${this.i18n.t("picker.effortKeys", { action: this.i18n.t(this.picker.effortOnly ? "picker.close" : "picker.backAction") })}${t.reset}`
      : `${t.muted} ${this.i18n.t("picker.nav")}${t.reset}`;
    lines.push(truncateAnsi(foot, Math.max(10, cols - 1)));

    while (lines.length < rows) lines.push("");
    const cursorCol = Math.min(cols - 2, 3 + 2 + visibleWidth(shownQuery));
    return {
      lines: lines.slice(0, rows),
      cursor: { row: 2, col: cursorCol, visible: !isEffortStage },
    };
  }

  private renderOutputModalFrame(cols: number, rows: number): RenderedFrame {
    const t = this.theme;
    const innerW = Math.max(8, cols - 4);
    const bodyRows = Math.max(2, rows - 3);
    const wrapped = this.wrappedOutputLines(innerW);
    const maxScroll = Math.max(0, wrapped.length - bodyRows);
    this.outputScroll = Math.min(Math.max(0, this.outputScroll), maxScroll);

    const visible = wrapped.slice(
      this.outputScroll,
      this.outputScroll + bodyRows,
    );
    const rangeEnd = Math.min(wrapped.length, this.outputScroll + bodyRows);
    const rangeLabel =
      wrapped.length === 0
        ? this.i18n.t("drawer.empty")
        : this.i18n.t("drawer.range", { start: this.outputScroll + 1, end: rangeEnd, total: wrapped.length });

    const lines: string[] = [];
    lines.push(
      this.renderBoxTop(
        cols,
        this.i18n.t("drawer.title", { label: this.output.label }),
        this.i18n.t("drawer.keys", { range: rangeLabel }),
        t.borderActive,
        t.neonMint,
      ),
    );
    for (let i = 0; i < bodyRows; i += 1) {
      const rawLine = visible[i] ?? "";
      const styled = this.output.label === "/changelog" ? rawLine : styleInlineMarkdown(rawLine, t);
      lines.push(
        `${t.borderActive}│${t.reset} ${padEndAnsi(styled, innerW)} ${t.borderActive}│${t.reset}`,
      );
    }
    lines.push(`${t.borderActive}╰${hline(cols - 2)}╯${t.reset}`);
    const foot = `${t.muted} ${this.i18n.t("drawer.footer")}${t.reset}`;
    lines.push(truncateAnsi(foot, Math.max(10, cols - 1)));

    while (lines.length < rows) lines.push("");
    return {
      lines: lines.slice(0, rows),
      cursor: { row: rows, col: 1, visible: false },
    };
  }

  private handleSessionPickerPlain(text: string): void {
    const clean = sanitizeText(text).replace(/\s+/g, " ");
    if (!clean) return;
    this.sessionPicker.query += clean;
    this.sessionPicker.selectedRow = 0;
    this.paint();
  }

  private handleSessionPickerKey(sequence: string): void {
    const rows = this.filteredSessionPickerRows();
    const pageStep = Math.max(2, this.rows() - 10);
    switch (sequence) {
      case "\x1b": // Esc
      case "\x03": // Ctrl+C
        this.closeSessionPicker();
        return;
      case "\r":
      case "\n":
      case "\t":
      case "\x1b[C": {
        const chosen = rows[this.sessionPicker.selectedRow];
        this.closeSessionPicker();
        if (chosen) {
          this.options.onSubmit(`/resume ${chosen.id}`);
        }
        return;
      }
      case "\x7f": // Backspace
        if (this.sessionPicker.query.length > 0) {
          this.sessionPicker.query = this.sessionPicker.query.slice(
            0,
            prevCodePointIndex(
              this.sessionPicker.query,
              this.sessionPicker.query.length,
            ),
          );
          this.sessionPicker.selectedRow = 0;
        }
        break;
      case "\x15": // Ctrl+U
      case "\b": // Ctrl+Backspace
      case "\x17": // Ctrl+W
      case "\x1b\x7f":
      case "\x1b[127;5u":
      case "\x1b[8;5u":
      case "\x1b[27;5;127~":
      case "\x1b[27;5;8~":
        this.sessionPicker.query = "";
        this.sessionPicker.selectedRow = 0;
        break;
      case "\x1b[A": // Up
      case "\x1bOA":
        if (rows.length > 0) {
          this.sessionPicker.selectedRow =
            (this.sessionPicker.selectedRow - 1 + rows.length) % rows.length;
        }
        break;
      case "\x1b[B": // Down
      case "\x1bOB":
        if (rows.length > 0) {
          this.sessionPicker.selectedRow =
            (this.sessionPicker.selectedRow + 1) % rows.length;
        }
        break;
      case "\x1b[5~": // PgUp
        if (rows.length > 0) {
          this.sessionPicker.selectedRow = Math.max(
            0,
            this.sessionPicker.selectedRow - pageStep,
          );
        }
        break;
      case "\x1b[6~": // PgDn
        if (rows.length > 0) {
          this.sessionPicker.selectedRow = Math.min(
            rows.length - 1,
            this.sessionPicker.selectedRow + pageStep,
          );
        }
        break;
      case "\x1b[H":
      case "\x1b[1~":
        this.sessionPicker.selectedRow = 0;
        break;
      case "\x1b[F":
      case "\x1b[4~":
        if (rows.length > 0) {
          this.sessionPicker.selectedRow = rows.length - 1;
        }
        break;
      default:
        return;
    }
    this.paint();
  }

  private renderSessionPickerModalFrame(
    cols: number,
    rows: number,
  ): RenderedFrame {
    const t = this.theme;
    const innerW = Math.max(8, cols - 4);
    const filtered = this.filteredSessionPickerRows();
    const selIdx =
      filtered.length > 0
        ? Math.min(
            Math.max(0, this.sessionPicker.selectedRow),
            filtered.length - 1,
          )
        : 0;
    const selected = filtered[selIdx] ?? null;

    const lines: string[] = [];
    // 1. Header
    lines.push(
      this.renderBoxTop(
        cols,
        this.i18n.t("sessionPicker.title", { shown: filtered.length, total: this.sessionPicker.sessions.length }),
        this.i18n.t("sessionPicker.shortcuts"),
        t.borderActive,
        t.neonCyan,
      ),
    );

    // 2. Search bar
    const qPrefix = `${t.neonCyan}${t.bold}❯ ${t.reset}`;
    const shownQuery = this.sessionPicker.query;
    const qBody = shownQuery
      ? `${qPrefix}${t.fgBright}${shownQuery}${t.reset}`
      : `${qPrefix}${t.subtle}${this.i18n.t("sessionPicker.filter")}${t.reset}`;
    lines.push(
      `${t.borderActive}│${t.reset} ${padEndAnsi(truncateAnsi(qBody, innerW), innerW)} ${t.borderActive}│${t.reset}`,
    );
    lines.push(`${t.borderActive}├${hline(cols - 2)}┤${t.reset}`);

    // Reserve bottom preview (4 rows when rows >= 14) + bottom border + footer
    const previewRows = rows >= 14 ? 4 : 0;
    const listHeight = Math.max(
      2,
      rows - 3 - (previewRows > 0 ? previewRows + 1 : 0) - 2,
    );

    const windowStart = Math.max(
      0,
      Math.min(
        Math.max(0, filtered.length - listHeight),
        selIdx - Math.floor(listHeight / 2),
      ),
    );

    for (let i = 0; i < listHeight; i += 1) {
      const item = filtered[windowStart + i];
      if (!item) {
        if (i === 0 && filtered.length === 0) {
          const emptyMsg = `${t.muted}  ${this.i18n.t("sessionPicker.noResults")}${t.reset}`;
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(emptyMsg, innerW)} ${t.borderActive}│${t.reset}`,
          );
        } else {
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi("", innerW)} ${t.borderActive}│${t.reset}`,
          );
        }
        continue;
      }
      const isSelected = windowStart + i === selIdx;
      const pointer = isSelected
        ? `${t.neonCyan}${t.bold}▸${t.reset}`
        : " ";
      const statusDot = item.inFlight
        ? `${t.amber}⚡${t.reset}`
        : `${t.emerald}●${t.reset}`;
      const numIdx = item.index ?? windowStart + i + 1;
      const shortBadge = item.shortId
        ? `${t.neonCyan}#${numIdx}${t.reset} ${t.muted}[${item.shortId}]${t.reset}`
        : `${t.neonCyan}#${numIdx}${t.reset}`;
      const titleText = item.title || item.shortId || item.id;
      const turnsTag =
        item.userTurnCount !== undefined && item.userTurnCount > 0
          ? this.i18n.t("sessionPicker.turns", { count: item.userTurnCount })
          : "";
      const toolsTag =
        item.toolCallCount !== undefined && item.toolCallCount > 0
          ? this.i18n.t("sessionPicker.tools", { count: item.toolCallCount })
          : "";
      const stamp = String(item.updatedAt ?? "")
        .replace("T", " ")
        .replace(/\.\d+Z$/, "")
        .slice(0, 16);
      const rightMeta = `${turnsTag}${this.i18n.t("sessionPicker.messages", { count: item.messageCount })}${toolsTag} · ${stamp}`;
      const rightW = visibleWidth(rightMeta);
      const leftMax = Math.max(12, innerW - rightW - 4);
      const leftTitle = truncateAnsi(
        `${pointer} ${statusDot} ${shortBadge}  ${isSelected ? `${t.fgBright}${t.bold}` : t.fg}${titleText}${t.reset}`,
        leftMax,
      );
      const gap = " ".repeat(
        Math.max(1, innerW - visibleWidth(leftTitle) - rightW),
      );
      const rowRendered = `${leftTitle}${gap}${isSelected ? t.neonCyan : t.muted}${rightMeta}${t.reset}`;
      const rowPadded = isSelected
        ? `${t.pillCyanBg}${padEndAnsi(rowRendered, innerW)}${t.reset}`
        : padEndAnsi(rowRendered, innerW);
      lines.push(
        `${t.borderActive}│${t.reset} ${rowPadded} ${t.borderActive}│${t.reset}`,
      );
    }

    if (previewRows > 0) {
      lines.push(`${t.borderActive}├${hline(cols - 2)}┤${t.reset}`);
      if (selected) {
        const tgt = selected.target
          ? basenameOf(selected.target)
          : this.i18n.t("status.noTarget");
        const mdl = selected.model ?? this.i18n.t("sessionPicker.default");
        const statusBadge = selected.inFlight
          ? `${t.amber}${this.i18n.t("sessionPicker.inFlight")}${t.reset}`
          : `${t.emerald}${this.i18n.t("sessionPicker.completed")}${t.reset}`;
        const selNum = selected.index ?? selIdx + 1;
        const selShort = selected.shortId ?? selected.id;
        const p1 = `${t.neonMint}${t.bold}${this.i18n.t("sessionPicker.session")}${t.reset} ${t.neonCyan}${t.bold}#${selNum}${t.reset} ${t.fgBright}[${selShort}]${t.reset} ${t.muted}·${t.reset} ${statusBadge} ${t.muted}${this.i18n.t("sessionPicker.select", { number: selNum })}${t.reset}`;
        const p2 = `${t.neonCyan}${this.i18n.t("sessionPicker.model")}${t.reset} ${t.fg}${mdl}${t.reset} ${t.muted}·${t.reset} ${t.neonCyan}${this.i18n.t("sessionPicker.target")}${t.reset} ${t.fg}${tgt}${t.reset} ${t.muted}· ${this.i18n.t("sessionPicker.messages", { count: selected.messageCount })}${selected.toolCallCount ? this.i18n.t("sessionPicker.tools", { count: selected.toolCallCount }) : ""}${t.reset}`;
        const p3 = `${t.violet}${this.i18n.t("sessionPicker.work")}${t.reset} ${t.fgBright}${t.bold}${selected.title || selected.firstUserPrompt || selShort}${t.reset}`;
        const p4 = selected.lastMessagePreview
          ? `${t.indigo}${this.i18n.t("sessionPicker.last")}${t.reset} ${t.subtle}${selected.lastMessagePreview}${t.reset}`
          : `${t.muted}${this.i18n.t("sessionPicker.load")}${t.reset}`;
        for (const pLine of [p1, p2, p3, p4]) {
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi(truncateAnsi(pLine, innerW), innerW)} ${t.borderActive}│${t.reset}`,
          );
        }
      } else {
        for (let r = 0; r < previewRows; r += 1) {
          lines.push(
            `${t.borderActive}│${t.reset} ${padEndAnsi("", innerW)} ${t.borderActive}│${t.reset}`,
          );
        }
      }
    }

    lines.push(`${t.borderActive}╰${hline(cols - 2)}╯${t.reset}`);
    const foot = `${t.muted} ${this.i18n.t("sessionPicker.footer")}${t.reset}`;
    lines.push(truncateAnsi(foot, Math.max(10, cols - 1)));

    while (lines.length < rows) lines.push("");
    const cursorCol = Math.min(cols - 2, 3 + 2 + visibleWidth(shownQuery));
    return {
      lines: lines.slice(0, rows),
      cursor: { row: 2, col: cursorCol, visible: true },
    };
  }
}
