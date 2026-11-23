import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ChatImageBlock, ChatMessage } from "./model.js";
import { normalizeChatMessage, repairChatHistory } from "./history.js";
import { LARGE_HISTORY_BYTES, readHistoryHeader, readHistoryTail, readLargeHistory } from "./historyFile.js";
import { writeJsonAtomic } from "./durable.js";
import { asArray, asRecord, asString } from "./values.js";
import { VERSION } from "./version.js";

export interface SessionInfo {
  id: string;
  dir: string;
  target: string | null;
  journalPath: string;
  reportPath: string;
  evidencePath: string;
  omrMetaPath: string;
  scriptsDir: string;
  historyPath: string;
}

export interface SavedSessionSummary {
  readonly id: string;
  readonly shortId: string;
  readonly index?: number;
  readonly dir: string;
  readonly target: string | null;
  readonly model: string | null;
  readonly messageCount: number;
  readonly updatedAt: string;
  readonly title?: string;
  readonly firstUserPrompt?: string;
  readonly lastMessagePreview?: string;
  readonly userTurnCount?: number;
  readonly toolCallCount?: number;
  readonly inFlight?: boolean;
}

export const sessionInfoFromSummary = (summary: Pick<SavedSessionSummary, "id" | "dir" | "target">): SessionInfo => ({
  id: summary.id, dir: summary.dir, target: summary.target,
  journalPath: join(summary.dir, "journal.jsonl"), reportPath: join(summary.dir, "report.md"),
  evidencePath: join(summary.dir, "evidence.json"), omrMetaPath: join(summary.dir, "omr.json"),
  scriptsDir: join(summary.dir, "scripts"), historyPath: join(summary.dir, "history.json"),
});

/**
 * Strip internal OMR workflow/turn-context suffix notes appended to user messages
 * before sending to the model, returning the operator's original prompt text.
 */
export const stripInternalPromptNotes = (text: string): string =>
  text
    .replace(/\n\n\[omr autonomous workflow match:[\s\S]*$/i, "")
    .replace(/\n\n\[omr turn context:[\s\S]*$/i, "")
    .trim();

/**
 * Format a compact, human-friendly short session identifier from a raw session folder ID.
 * E.g. `2026-11-10T17-49-13-994Z-session` -> `1110-1749`, `2026-11-08T16-10-50-239Z-ls` -> `1108-1610·ls`.
 */
export const formatShortSessionId = (id: string): string => {
  const isoMatch =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+Z)?-(.+)$/.exec(
      id.trim(),
    );
  if (isoMatch) {
    const [, , mm, dd, hh, min, , rawSuffix] = isoMatch;
    const suffix =
      rawSuffix && rawSuffix !== "session" ? `·${rawSuffix.slice(0, 12)}` : "";
    return `${mm}${dd}-${hh}${min}${suffix}`;
  }
  return id.length > 16 ? id.slice(0, 16) : id;
};

const BOILERPLATE_PROMPT_PATTERNS: readonly RegExp[] = [
  /^this document is the operating specification/i,
  /^\d+\.\s*(?:role|capabilities|values|constraints|authority|communication|scope)\b/i,
  /^the assistant is (?:a capable|strong across)/i,
  /^the operator is the sole consumer/i,
  /^software engineering in all common languages/i,
  /^security research and engineering/i,
  /^\[supervisor course-correction/i,
  /^<(?:context-summary|conversation-handoff|previous-summary)\b/i,
  /^\[omr\b/i,
];

const CONVERSATIONAL_NUDGE_PATTERNS: readonly RegExp[] = [
  /^(?:yes|no|ok|okay|tamam|evet|hayır|hayir|devam|devam et|continue|go ahead|sure|alright)\b/i,
  /^(?:check every step|do what you need|make it perfect|just make it)\b/i,
  /^[ab]\s+i\s+pick\b/i,
  /^(?:bunu yapma|şunu etme|sunu etme)\b/i,
];

const GENERIC_HEADING_PATTERNS: readonly RegExp[] = [
  /^(?:\d+\.\s*)?(?:operating specification|role|capabilities|consumer\s*&\s*authority|values|constraints|communication)$/i,
  /^reverse engineering\s*[—–-]/i,
  /^(?:summary|result|results|conclusion|sonuç|sonuc|özet|ozet|status|durum|final state|still not proven)$/i,
  /^(?:öneriler|oneriler|recommendations|next steps|sonraki adımlar|sonraki adimlar)/i,
  /^(?:the real(?:\s+answer.*)?|the correction|proof it works(?:\s+now)?|new defects found|what changed|to actually\b.*|why\b.*)$/i,
];

const GENERIC_BOLD_LEAD_PATTERNS: readonly RegExp[] = [
  /^(?:you were right|mystery solved|the operator is|four more real bugs|tail flick)/i,
];

const isBoilerplatePrompt = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return BOILERPLATE_PROMPT_PATTERNS.some((re) => re.test(trimmed));
};

const isConversationalNudge = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length < 4) return true;
  return CONVERSATIONAL_NUDGE_PATTERNS.some((re) => re.test(trimmed));
};

/**
 * Clean conversational filler and negative clauses ("do not push...", "dont ...", "bunu yapma...")
 * from a user prompt so only the positive task/work description remains.
 */
const cleanTaskDescription = (raw: string): string => {
  let s = raw.replace(/\s+/g, " ").trim();
  // Extract quoted goal if present (e.g. `now we do this "With these keys grab all free proxies..."`)
  const quoted = /"([^"]{12,100})"/.exec(s);
  if (quoted?.[1]) {
    s = quoted[1].trim();
  }
  s = s
    .replace(
      /^(?:okay\s+bud|ok\s+bud|bud|dude|dostum|hocam|hey|now\s+these[^?]*\?\s*now\s+we\s+do\s+this|now|so)\b[,:\s]*/i,
      "",
    )
    .replace(
      /\b(?:and\s+)?(?:do\s+not|don't|dont|never|sakın|sakin|asla)\s+[^.!?,;\n]+/gi,
      "",
    )
    .replace(
      /\b(?:bunu\s+yapma|şunu\s+etme|sunu\s+etme|that'?s\s+it)\b[^.!?,;\n]*/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  return s;
};

/**
 * Derive a meaningful, work-based title and first task prompt from a session's messages & target.
 */
export const deriveSessionTitle = (
  rawMessages: readonly unknown[],
  target: string | null,
  explicitTitle?: string | null,
): {
  title: string;
  firstTaskPrompt: string;
  lastMessagePreview: string;
  userTurnCount: number;
  toolCallCount: number;
} => {
  const custom = explicitTitle?.trim();
  let firstAnyUserPrompt = "";
  let firstTaskPrompt = "";
  const substantiveTasks: string[] = [];
  let lastMessagePreview = "";
  let userTurnCount = 0;
  let toolCallCount = 0;

  let projectSubject: string | null = target
    ? (target.split(/[\\/]/).filter(Boolean).at(-1) ?? null)
    : null;
  const discoveredFiles = new Set<string>();
  const assistantHeadings: string[] = [];
  const assistantOutcomes: string[] = [];

  for (const rawMsg of rawMessages) {
    const rec = asRecord(rawMsg);
    if (!rec) continue;
    const role = asString(rec["role"]);
    const content = asString(rec["content"]);

    if (role === "user" && content) {
      const clean = stripInternalPromptNotes(content);
      if (!clean || clean.startsWith("[omr")) continue;
      userTurnCount += 1;
      const singleLine = clean.replace(/\s+/g, " ").trim();
      if (!firstAnyUserPrompt) firstAnyUserPrompt = singleLine.slice(0, 120);
      if (!isBoilerplatePrompt(clean)) {
        if (!firstTaskPrompt) firstTaskPrompt = singleLine.slice(0, 120);
        if (!isConversationalNudge(clean)) {
          const cleanedTask = cleanTaskDescription(clean);
          if (cleanedTask.length >= 6) {
            substantiveTasks.push(cleanedTask);
          }
        }
      }
      if (!clean.startsWith("[SUPERVISOR COURSE-CORRECTION")) {
        lastMessagePreview = `❯ ${singleLine.slice(0, 120)}`;
      }
    } else if (role === "assistant") {
      const tcs = asArray(rec["tool_calls"]);
      toolCallCount += tcs.length;
      for (const tc of tcs) {
        const fn = asRecord(asRecord(tc)?.["function"]);
        const argsStr = asString(fn?.["arguments"]);
        if (!argsStr) continue;
        if (!projectSubject) {
          const repoMatch =
            /\/(?:Projects|Githup-repos|github|repos|workspace|Desktop|Masaüstü|work)\/([A-Za-z0-9._-]{2,45})/i.exec(
              argsStr,
            );
          if (repoMatch?.[1]) {
            projectSubject = repoMatch[1];
          }
        }
        for (const fm of argsStr.matchAll(
          /\b([A-Za-z0-9_-]+\.(?:elf|apk|exe|dll|so|dylib|bin|py|sh|txt|csv|json))\b/g,
        )) {
          if (fm[1] && !fm[1].startsWith("peek.")) {
            discoveredFiles.add(fm[1]);
          }
        }
      }

      if (content && content.trim()) {
        // Extract top-level markdown headings (# and ##)
        for (const line of content.split(/\r?\n/)) {
          const hMatch = /^(#{1,2})\s+(.+?)\s*$/.exec(line.trim());
          if (hMatch?.[2]) {
            const headingText = hMatch[2]
              .replace(/[`*_~]/g, "")
              .replace(/^\d+\.\s*/, "")
              .trim();
            if (
              headingText.length >= 4 &&
              headingText.length <= 72 &&
              !GENERIC_HEADING_PATTERNS.some((re) => re.test(headingText))
            ) {
              assistantHeadings.push(headingText);
            }
          }
        }
        // Extract bold lead outcome lines from final (non-tool-call) assistant summaries
        if (tcs.length === 0) {
          const strippedPrefix = content
            .replace(/^(?:[A-Za-z0-9_-]+:\s*|\[[^\]]+\]\s*)+/, "")
            .trim();
          for (const line of strippedPrefix.split(/\r?\n/)) {
            const trimmedLine = line.trim();
            const boldKV = /^\*\*`?([^*`]{2,36})`?\*\*:\s*(.{6,68})$/.exec(
              trimmedLine,
            );
            if (boldKV?.[2]) {
              const lead = boldKV[2].replace(/\.$/, "").trim();
              if (
                lead.length >= 6 &&
                !GENERIC_BOLD_LEAD_PATTERNS.some((re) => re.test(lead))
              ) {
                assistantOutcomes.push(lead);
              }
              continue;
            }
            const boldLead = /^\*\*([^*]{8,78})\*\*/.exec(trimmedLine);
            if (boldLead?.[1]) {
              const lead = boldLead[1].replace(/\.$/, "").trim();
              if (
                lead.length >= 8 &&
                !GENERIC_BOLD_LEAD_PATTERNS.some((re) => re.test(lead))
              ) {
                assistantOutcomes.push(lead);
              }
            }
          }
        }

        const singleLine = content
          .replace(/^(?:ratman\d*:|\[rat\])\s*/i, "")
          .replace(/```[\s\S]*?```/g, "[code]")
          .replace(/\s+/g, " ")
          .trim();
        if (singleLine) {
          lastMessagePreview = `◈ ${singleLine.slice(0, 120)}`;
        }
      }
    }
  }

  if (custom) {
    return {
      title: custom.slice(0, 76),
      firstTaskPrompt: firstTaskPrompt || firstAnyUserPrompt,
      lastMessagePreview,
      userTurnCount,
      toolCallCount,
    };
  }

  // Pick the strongest work headline from outcomes, headings, or cleaned user tasks
  const latestOutcome = assistantOutcomes.at(-1) ?? "";
  const latestHeading = assistantHeadings.at(-1) ?? "";
  const bestUserTask =
    substantiveTasks.find((t) => t.length >= 16) ??
    substantiveTasks[0] ??
    firstTaskPrompt;

  let workHeadline = "";
  if (latestOutcome) {
    workHeadline = latestOutcome;
  } else if (latestHeading) {
    const prevHeading =
      assistantHeadings.length >= 2 ? assistantHeadings.at(-2)! : "";
    workHeadline =
      prevHeading &&
      prevHeading !== latestHeading &&
      prevHeading.length + latestHeading.length <= 54
        ? `${prevHeading}: ${latestHeading}`
        : latestHeading;
  } else if (bestUserTask) {
    workHeadline = bestUserTask;
  } else if (discoveredFiles.size > 0) {
    workHeadline = [...discoveredFiles].slice(0, 3).join(", ");
  }

  workHeadline = workHeadline.replace(/\s+/g, " ").trim();

  let title = "";
  if (projectSubject && workHeadline) {
    if (
      workHeadline.toLowerCase().includes(projectSubject.toLowerCase())
    ) {
      title = workHeadline;
    } else {
      title = `${projectSubject} · ${workHeadline}`;
    }
  } else if (workHeadline) {
    title = workHeadline;
  } else if (projectSubject) {
    title = `Hedef: ${projectSubject}`;
  } else {
    title = firstTaskPrompt || firstAnyUserPrompt || "Yeni Oturum";
  }

  if (title.length > 76) {
    title = `${title.slice(0, 75).trimEnd()}…`;
  }

  return {
    title,
    firstTaskPrompt: firstTaskPrompt || firstAnyUserPrompt,
    lastMessagePreview,
    userTurnCount,
    toolCallCount,
  };
};

export interface ExtractedCodeBlock {
  readonly language: string;
  readonly code: string;
  readonly suggestedExt: string;
}

const slugOf = (target: string | null): string => {
  const base = target?.split(/[\\/]/).at(-1) ?? "session";
  const slug = base
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "session";
};

export const sessionsRootDir = (overrideRoot?: string): string =>
  overrideRoot?.trim() ||
  process.env["OMR_SESSIONS_DIR"]?.trim() ||
  join(homedir(), ".rea", "sessions");

export interface CreateSessionOptions {
  readonly rootDir?: string | undefined;
  readonly suffix?: string | undefined;
  readonly forkedFrom?: string | null | undefined;
}

export const createSession = async (
  target: string | null,
  model: string | null,
  options: CreateSessionOptions = {},
): Promise<SessionInfo> => {
  const root = sessionsRootDir(options.rootDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const cleanSuffix = (options.suffix ?? "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const baseId = cleanSuffix
    ? `${timestamp}-${slugOf(target)}-${cleanSuffix}`
    : `${timestamp}-${slugOf(target)}`;
  let id = baseId;
  let seq = 2;
  while (existsSync(join(root, id))) {
    id = `${baseId}-${seq}`;
    seq += 1;
  }
  const dir = join(root, id);
  const scriptsDir = join(dir, "scripts");
  await mkdir(join(dir, "checkpoints"), { recursive: true, mode: 0o700 });
  await mkdir(scriptsDir, { recursive: true, mode: 0o700 });

  const info: SessionInfo = {
    id,
    dir,
    target,
    journalPath: join(dir, "journal.jsonl"),
    reportPath: join(dir, "report.md"),
    evidencePath: join(dir, "evidence.json"),
    omrMetaPath: join(dir, "omr.json"),
    scriptsDir,
    historyPath: join(dir, "history.json"),
  };

  await writeFile(
    join(dir, "session.json"),
    `${JSON.stringify(
      {
        protocol: "agent-session/v1",
        session_id: id,
        created_at: new Date().toISOString(),
        target: null,
        workflow: null,
        backend: "omr",
        provider: null,
        host_version: VERSION,
        rea_version: null,
        ...(options.forkedFrom ? { forked_from: options.forkedFrom } : {}),
      },
      null,
      2,
    )}\n`,
  );

  await writeOmrMeta(info, target, model, options.forkedFrom ?? null);
  return info;
};

export const writeOmrMeta = async (
  info: SessionInfo,
  target: string | null,
  model: string | null,
  forkedFrom: string | null = null,
): Promise<void> => {
  await writeFile(
    info.omrMetaPath,
    `${JSON.stringify(
      {
        version: VERSION,
        target,
        model,
        updated_at: new Date().toISOString(),
        host: { kind: "in-process" },
        journal: info.journalPath,
        report: info.reportPath,
        scripts_dir: info.scriptsDir,
        history: info.historyPath,
        ...(forkedFrom ? { forked_from: forkedFrom } : {}),
      },
      null,
      2,
    )}\n`,
  );
};

/** Content-addressed bitmap store: snapcompact frames live here once instead of inside every `history.json` rewrite. */
const HISTORY_ASSET_DIR = "history-assets";
const ASSET_NAME_RE = /^[0-9a-f]{64}\.(?:png|jpg|webp|gif|bin)$/;
const EVIDENCE_ID_GLOBAL_RE = /\bev_[0-9a-f]{64}\b/g;
const MESSAGE_ROLES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "assistant",
  "tool",
]);

const assetExtension = (mimeType: string): string => {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
};

/** Move each inline image into the asset store and return the message with `{ mimeType, asset }` references. */
const externalizeImages = async (
  info: SessionInfo,
  message: ChatMessage,
): Promise<Record<string, unknown>> => {
  if (!message.images || message.images.length === 0) return { ...message };
  const assetDir = join(info.dir, HISTORY_ASSET_DIR);
  await mkdir(assetDir, { recursive: true, mode: 0o700 });
  const refs: Array<Record<string, unknown>> = [];
  for (const image of message.images) {
    const bytes = Buffer.from(image.data, "base64");
    const name = `${createHash("sha256").update(bytes).digest("hex")}.${assetExtension(image.mimeType)}`;
    // Content-addressed: an existing file already holds these exact bytes.
    await writeFile(join(assetDir, name), bytes, {
      flag: "wx",
      mode: 0o600,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    refs.push({
      mimeType: image.mimeType,
      asset: name,
      ...(image.detail ? { detail: image.detail } : {}),
    });
  }
  return { ...message, images: refs };
};

/**
 * Atomically persist non-system conversation messages so `/resume` can restore the session.
 * `options.inFlight` marks a mid-turn checkpoint: if omr dies before the turn ends, the flag stays
 * set and `/resume` / `--resume` continue the interrupted turn automatically.
 */
export const saveSessionHistory = async (
  info: SessionInfo,
  messages: readonly ChatMessage[],
  target: string | null,
  model: string | null,
  options?: { readonly inFlight?: boolean; readonly customTitle?: string | null },
): Promise<void> => {
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 0) {
    if (existsSync(info.historyPath)) {
      await unlink(info.historyPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    await writeOmrMeta(info, target, model);
    return;
  }
  let existingCustomTitle: string | null = options?.customTitle ?? null;
  if (!existingCustomTitle && existsSync(info.historyPath)) {
    try {
      const prev = (await readHistoryHeader(info.historyPath))?.fields;
      const ct = asString(prev?.["custom_title"]).trim();
      if (ct) existingCustomTitle = ct;
    } catch {
      // Ignore unreadable prior history header
    }
  }
  const stored: Array<Record<string, unknown>> = [];
  for (const message of nonSystem)
    stored.push(await externalizeImages(info, message));
  const derived = deriveSessionTitle(stored, target, existingCustomTitle);
  const payload = {
    version: VERSION,
    session_id: info.id,
    updated_at: new Date().toISOString(),
    target,
    model,
    title: derived.title,
    ...(existingCustomTitle ? { custom_title: existingCustomTitle } : {}),
    ...(options?.inFlight ? { in_flight: true } : {}),
    messages: stored,
  };
  const staging = `${info.historyPath}.${process.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(staging, info.historyPath);
  await writeOmrMeta(info, target, model);
};

/**
 * Clone the current session's conversation history, archived snapcompact frames, report, scripts,
 * and operator directives into an independent branched session directory (`/fork` / `/branch`).
 */
export const forkSession = async (
  source: SessionInfo,
  messages: readonly ChatMessage[],
  target: string | null,
  model: string | null,
  options: { label?: string | undefined; rootDir?: string | undefined } = {},
): Promise<SessionInfo> => {
  const suffix = options.label?.trim()
    ? `fork-${options.label.trim()}`
    : "fork";
  const forked = await createSession(target, model, {
    rootDir: options.rootDir,
    suffix,
    forkedFrom: source.id,
  });

  // Copy content-addressed snapcompact assets if present
  const srcAssets = join(source.dir, HISTORY_ASSET_DIR);
  if (existsSync(srcAssets)) {
    const dstAssets = join(forked.dir, HISTORY_ASSET_DIR);
    await mkdir(dstAssets, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(srcAssets).catch(() => [])) {
      if (!ASSET_NAME_RE.test(entry)) continue;
      await copyFile(join(srcAssets, entry), join(dstAssets, entry));
    }
  }

  // Copy markdown report and operator directives if present
  for (const fileName of ["report.md", "operator-directives.md", "evidence-bundle.json", "execution.jsonl", "usage.json", "task-state.json", "browser-state.json", "investigation-state.json"]) {
    const srcFile = join(source.dir, fileName);
    await copyFile(srcFile, join(forked.dir, fileName)).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }

  // Copy versioned tools and their historical verification/run records together.
  for (const directory of ["forge", "screenshots", "browser-captures", "recipes", "context-archive"]) {
    const from = join(source.dir, directory);
    if (existsSync(from)) await cp(from, join(forked.dir, directory), { recursive: true, errorOnExist: true, force: false });
  }
  const browserState = join(forked.dir, "browser-state.json");
  if (existsSync(browserState)) {
    const rebase = (value: unknown, key = ""): unknown => {
      if (typeof value === "string" && ["path", "screenshotPath"].includes(key) && value.startsWith(`${source.dir}/`)) return join(forked.dir, value.slice(source.dir.length + 1));
      if (Array.isArray(value)) return value.map(item => rebase(item));
      const record = asRecord(value); return record ? Object.fromEntries(Object.entries(record).map(([field, item]) => [field, rebase(item, field)])) : value;
    };
    await writeJsonAtomic(browserState, rebase(JSON.parse(await readFile(browserState, "utf8"))));
  }

  const recipeDirectory = join(forked.dir, "recipes");
  if (existsSync(recipeDirectory)) for (const id of await readdir(recipeDirectory)) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    const path = join(recipeDirectory, id, "run.json"); const raw = asRecord(JSON.parse(await readFile(path, "utf8")));
    if (!raw) throw new Error("Invalid copied recipe run");
    const rebase = (value: unknown): unknown => typeof value === "string" && value.startsWith(`${source.dir}/`) ? join(forked.dir, value.slice(source.dir.length + 1)) : value;
    if (Array.isArray(raw["artifacts"])) raw["artifacts"] = raw["artifacts"].map(value => { const item = asRecord(value); return item ? { ...item, path: rebase(item["path"]) } : value; });
    if (Array.isArray(raw["steps"])) raw["steps"] = raw["steps"].map(value => { const item = asRecord(value); return item ? { ...item, resultPath: rebase(item["resultPath"]) } : value; });
    await writeJsonAtomic(path, raw);
  }

  // Copy generated scripts (excluding hidden `.runs` audit directory)
  if (existsSync(source.scriptsDir)) {
    for (const entry of await readdir(source.scriptsDir).catch(() => [])) {
      if (entry.startsWith(".")) continue;
      const srcScript = join(source.scriptsDir, entry);
      const st = await stat(srcScript);
      if (st?.isFile()) {
        await copyFile(srcScript, join(forked.scriptsDir, entry));
      }
    }
  }

  await saveSessionHistory(forked, messages, target, model);
  await writeOmrMeta(forked, target, model, source.id);
  return forked;
};

/**
 * Parse one stored message at the file boundary. Malformed entries are dropped; images are rehydrated
 * from the asset store, and an unreadable frame degrades to its plain-text ledger instead of failing the resume.
 */
const parseStoredMessage = async (
  sessionDir: string,
  raw: unknown,
): Promise<ChatMessage | null> => {
  const record = asRecord(raw);
  if (!record) return null;
  const role = asString(record["role"]);
  if (!MESSAGE_ROLES.has(role)) return null;
  const content = record["content"];
  if (content !== null && typeof content !== "string") return null;

  const { images: storedImages, ...rest } = record;
  const message = normalizeChatMessage(rest);
  if (!message) return null;
  if (!Array.isArray(storedImages) || storedImages.length === 0) return message;

  const restored: ChatImageBlock[] = [];
  for (const entry of storedImages) {
    const ref = asRecord(entry);
    const asset = asString(ref?.["asset"]);
    // The name comes from a file on disk: only a bare content-addressed name may reach the filesystem.
    if (!ref || !ASSET_NAME_RE.test(asset)) continue;
    const data = await readFile(
      join(sessionDir, HISTORY_ASSET_DIR, asset),
    ).catch(() => null);
    if (!data) continue;
    const detail = asString(ref["detail"]);
    restored.push({
      mimeType: asString(ref["mimeType"]) || "image/png",
      data: data.toString("base64"),
      ...(detail === "auto" ||
      detail === "low" ||
      detail === "high" ||
      detail === "original"
        ? { detail }
        : {}),
    });
  }
  if (restored.length === storedImages.length) {
    const tokens = record["image_tokens"];
    return {
      ...message,
      images: restored,
      ...(typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
        ? { image_tokens: tokens }
        : {}),
    };
  }
  const { image_tokens: _omitted, ...withoutTokens } = message;
  return {
    ...withoutTokens,
    content:
      `${message.content ?? ""}\n\n[omr: ${storedImages.length - restored.length} archived bitmap frame(s) were unavailable on resume; the plain-text ledger above is intact]`.trim(),
    ...(restored.length > 0 ? { images: restored } : {}),
  };
};

/** Distinct full `ev_<64-hex>` identifiers cited anywhere in `messages`, in first-seen order. */
export const evidenceIdsInMessages = (
  messages: readonly ChatMessage[],
  limit = 512,
): string[] => {
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message.content) continue;
    for (const match of message.content.matchAll(EVIDENCE_ID_GLOBAL_RE)) {
      seen.add(match[0]);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
};

/** List recent sessions that have saved conversation history or non-empty reports. */
const readHistoryDocument = async (path: string) => {
  if ((await stat(path)).size > LARGE_HISTORY_BYTES) return readLargeHistory(path);
  const fields = asRecord(JSON.parse(await readFile(path, "utf8")));
  if (!fields) return null;
  const entries = asArray(fields["messages"]);
  return { fields, entries, count: entries.length, firstUser: undefined };
};

/** A bounded preview for the common startup selectors. Other selectors fall through to the picker lookup. */
export const previewSavedSession = async (query: string, excludeId?: string, rootDir?: string) => {
  const clean = query.trim().toLowerCase();
  const latest = !clean || clean === "last" || clean === "latest";
  const root = sessionsRootDir(rootDir);
  const entries = await readdir(root).catch(() => []);
  const names = latest ? entries.sort((a, b) => b.localeCompare(a)) : entries.filter((name) => name.toLowerCase() === clean);
  for (const id of names) {
    if (id === excludeId) continue;
    const path = join(root, id, "history.json");
    try {
      const header = await readHistoryHeader(path);
      if (!header) continue;
      const records = await readHistoryTail(path);
      const messages = records.flatMap((entry) => {
        const message = normalizeChatMessage(entry);
        return message ? [message] : [];
      });
      if (messages.length > 0) return { id, messages };
      // A latest session can be empty or use a format the preview does not recognize.
      // Let the regular loader resolve it, using its normal ordering and validation.
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return null;
};

export const listRecentSessions = async (
  limit = 15,
  excludeId?: string,
  rootDir?: string,
): Promise<SavedSessionSummary[]> => {
  const root = sessionsRootDir(rootDir);
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  entries.sort((a, b) => b.localeCompare(a));
  const summaries: SavedSessionSummary[] = [];
  const seenLargeClones = new Set<string>();
  for (const name of entries) {
    if (name === excludeId) continue;
    const dir = join(root, name);
    const historyPath = join(dir, "history.json");
    const metaPath = join(dir, "omr.json");
    try {
      const document = await readHistoryDocument(historyPath);
      if (!document?.count) continue;
      const { fields: parsed, entries: msgs, count, firstUser } = document;
      const rawMeta = await readFile(metaPath, "utf8").catch(() => "");
      const meta = rawMeta ? asRecord(JSON.parse(rawMeta)) : null;
      const target =
        asString(parsed?.["target"]) || asString(meta?.["target"]) || null;
      const model =
        asString(parsed?.["model"]) || asString(meta?.["model"]) || null;
      const updatedAt =
        asString(parsed?.["updated_at"]) ||
        asString(meta?.["updated_at"]) ||
        (await stat(historyPath)).mtime.toISOString();
      const customTitle =
        asString(parsed?.["custom_title"]) ||
        asString(meta?.["custom_title"]) ||
        null;

      const derived = deriveSessionTitle(msgs, target, customTitle);
      const isFork = Boolean(asString(meta?.["forked_from"]));
      if (count >= 20 && !isFork) {
        const cloneSig = `${count}|${derived.userTurnCount}|${derived.toolCallCount}|${derived.title}|${derived.lastMessagePreview}`;
        if (seenLargeClones.has(cloneSig)) continue;
        seenLargeClones.add(cloneSig);
      }

      const index = summaries.length + 1;
      summaries.push({
        id: name,
        shortId: formatShortSessionId(name),
        index,
        dir,
        target,
        model,
        messageCount: count,
        updatedAt,
        title: asString(parsed["title"]) || derived.title,
        firstUserPrompt: firstUser ? stripInternalPromptNotes(firstUser) : derived.firstTaskPrompt,
        lastMessagePreview: derived.lastMessagePreview,
        userTurnCount: derived.userTurnCount,
        toolCallCount: derived.toolCallCount,
        inFlight: parsed?.["in_flight"] === true,
      });
      if (summaries.length >= limit) break;
    } catch {
      continue;
    }
  }
  return summaries;
};

/** Load a saved session by numeric index (`1`, `#1`), short ID, full ID, target name, title, or `"last"`. */
export const loadSavedSession = async (
  query: string,
  excludeId?: string,
  rootDir?: string,
): Promise<{
  summary: SavedSessionSummary;
  messages: ChatMessage[];
  /** True when the session ended mid-turn (crash / kill / power loss) rather than finishing or being cancelled. */
  inFlight: boolean;
  /** Invalid or incomplete stored messages removed while repairing the protocol history. */
  droppedMessages: number;
  archivedMessages: number;
} | null> => {
  const clean = query.trim().toLowerCase();
  const numMatch = /^#?(\d+)$/.exec(clean);
  // Every candidate costs a full read + JSON.parse of its history.json, so only list as many as the query
  // can address: `last` is the first summary, `#N` is the Nth. Name/id/title queries need the whole window.
  const isLast = !clean || clean === "last" || clean === "latest";
  const wanted = isLast ? 1 : numMatch && Number(numMatch[1]) >= 1 ? Math.min(50, Number(numMatch[1])) : 50;
  const recent = await listRecentSessions(wanted, excludeId, rootDir);
  if (recent.length === 0) return null;
  const byIndex = numMatch ? recent[Number(numMatch[1]) - 1] : undefined;
  const match =
    !clean || clean === "last" || clean === "latest"
      ? recent[0]
      : (byIndex ??
        recent.find((s) => s.id.toLowerCase() === clean) ??
        recent.find((s) => s.shortId.toLowerCase() === clean) ??
        recent.find((s) => s.shortId.toLowerCase().includes(clean)) ??
        recent.find((s) => s.id.toLowerCase().includes(clean)) ??
        recent.find((s) => (s.target ?? "").toLowerCase().includes(clean)) ??
        recent.find((s) => (s.title ?? "").toLowerCase().includes(clean)) ??
        recent.find((s) =>
          (s.firstUserPrompt ?? "").toLowerCase().includes(clean),
        ));
  if (!match) return null;
  try {
    const document = await readHistoryDocument(join(match.dir, "history.json"));
    if (!document?.count) return null;
    const entries: Array<ChatMessage | null> = [];
    for (const entry of document.entries) {
      const message = await parseStoredMessage(match.dir, entry);
      entries.push(message);
    }
    const repaired = repairChatHistory(entries);
    return {
      summary: match,
      messages: repaired.messages,
      inFlight: document.fields["in_flight"] === true,
      droppedMessages: repaired.report.droppedMessages,
      archivedMessages: document.count - document.entries.length,
    };
  } catch {
    return null;
  }
};

const EXT_BY_LANG: Readonly<Record<string, string>> = {
  js: "js",
  javascript: "js",
  ts: "ts",
  typescript: "ts",
  frida: "js",
  py: "py",
  python: "py",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  h: "h",
  rs: "rs",
  rust: "rs",
  go: "go",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  gdb: "gdb",
  rizin: "rz",
  rz: "rz",
  r2: "rz",
  yara: "yar",
  yar: "yar",
  json: "json",
  sql: "sql",
};

/** Extract fenced markdown code blocks (` ```lang ... ``` `) from assistant output. */
export const extractCodeBlocks = (markdown: string): ExtractedCodeBlock[] => {
  const blocks: ExtractedCodeBlock[] = [];
  const regex = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(regex)) {
    const lang = (match[1] ?? "").trim().toLowerCase();
    const code = (match[2] ?? "").replace(/\s+$/, "");
    if (!code.trim()) continue;
    const suggestedExt = EXT_BY_LANG[lang] ?? "txt";
    blocks.push({ language: lang || "text", code, suggestedExt });
  }
  return blocks;
};

/**
 * Save the most substantive (or last) code block from `markdown` to disk.
 * When `explicitPath` is omitted, writes into `<session.scriptsDir>/<prefix>-<timestamp>.<ext>`.
 */
export const saveCodeBlockToDisk = async (
  session: SessionInfo,
  markdown: string,
  options: {
    explicitPath?: string | undefined;
    cwd?: string | undefined;
    defaultPrefix?: string | undefined;
  } = {},
): Promise<{
  path: string;
  language: string;
  bytes: number;
  evidenceIds: string[];
} | null> => {
  const blocks = extractCodeBlocks(markdown);
  if (blocks.length === 0) return null;

  // Prefer the largest executable script block (.js, .py, .c, .gdb, .rz, .yar, .sh) over tiny snippets
  const sorted = [...blocks].sort((a, b) => {
    const aExec = a.suggestedExt !== "txt" ? 1 : 0;
    const bExec = b.suggestedExt !== "txt" ? 1 : 0;
    if (aExec !== bExec) return bExec - aExec;
    return b.code.length - a.code.length;
  });
  const chosen = sorted[0]!;

  const evMatches = new Set<string>();
  for (const m of markdown.matchAll(/\bev_[0-9a-f]{64}\b/g)) {
    evMatches.add(m[0]);
    if (evMatches.size >= 16) break;
  }
  const evidenceIds = [...evMatches];

  // Prepend an Evidence provenance header comment when not already present
  let finalCode = chosen.code;
  if (evidenceIds.length > 0 && !finalCode.includes(evidenceIds[0]!)) {
    const commentPrefix =
      chosen.suggestedExt === "py" ||
      chosen.suggestedExt === "sh" ||
      chosen.suggestedExt === "gdb" ||
      chosen.suggestedExt === "rz"
        ? "#"
        : chosen.suggestedExt === "js" ||
            chosen.suggestedExt === "ts" ||
            chosen.suggestedExt === "c" ||
            chosen.suggestedExt === "cpp" ||
            chosen.suggestedExt === "yar"
          ? "//"
          : null;
    if (commentPrefix) {
      finalCode =
        `${commentPrefix} Generated by OMR (oh-my-rea) · Session ${session.id}\n` +
        `${commentPrefix} Target: ${session.target ?? "(unbound)"}\n` +
        `${commentPrefix} Retained Evidence: ${evidenceIds.join(", ")}\n\n` +
        finalCode;
    }
  }

  let outPath: string;
  const rawExplicit = options.explicitPath?.trim();
  if (rawExplicit) {
    const baseCwd = options.cwd ?? process.cwd();
    const hasSlash = rawExplicit.includes("/") || rawExplicit.includes("\\");
    const withExt = /\.[a-z0-9]{1,6}$/i.test(rawExplicit)
      ? rawExplicit
      : `${rawExplicit}.${chosen.suggestedExt}`;
    outPath = isAbsolute(withExt)
      ? withExt
      : hasSlash
        ? resolve(baseCwd, withExt)
        : join(session.scriptsDir, withExt);
  } else {
    const prefix = (options.defaultPrefix ?? "omr-script").replace(
      /[^a-z0-9_-]+/gi,
      "-",
    );
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    outPath = join(
      session.scriptsDir,
      `${prefix}-${stamp}.${chosen.suggestedExt}`,
    );
  }

  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  const contentWithNewline = finalCode.endsWith("\n")
    ? finalCode
    : `${finalCode}\n`;
  await writeFile(outPath, contentWithNewline, { mode: 0o600 });
  return {
    path: outPath,
    language: chosen.language,
    bytes: Buffer.byteLength(contentWithNewline, "utf8"),
    evidenceIds,
  };
};

const OMR_DIRECTIVE_BEGIN = "<!-- BEGIN:omr-operator-directive -->";
const OMR_DIRECTIVE_END = "<!-- END:omr-operator-directive -->";

/**
 * Read active operator directives from `<sessionDir>/operator-directives.md` or
 * the managed `<!-- BEGIN:omr-operator-directive -->` block in `<cwd>/AGENTS.md`.
 */
export const readOperatorDirective = (
  cwd: string,
  sessionDir: string,
): string | null => {
  const sessionFile = join(sessionDir, "operator-directives.md");
  if (existsSync(sessionFile)) {
    try {
      const text = readFileSync(sessionFile, "utf8").trim();
      if (text) return text;
    } catch {
      // ignore
    }
  }
  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    try {
      const raw = readFileSync(agentsPath, "utf8");
      const start = raw.indexOf(OMR_DIRECTIVE_BEGIN);
      const end = raw.indexOf(OMR_DIRECTIVE_END);
      if (start >= 0 && end > start) {
        const block = raw
          .slice(start + OMR_DIRECTIVE_BEGIN.length, end)
          .trim()
          .replace(/^#+\s*OMR Operator Directives\s*/i, "")
          .trim();
        if (block) return block;
      }
    } catch {
      // ignore
    }
  }
  return null;
};

/**
 * Additively persist an operator directive (`/jb <prompt>`) into both
 * `<sessionDir>/operator-directives.md` and `<cwd>/AGENTS.md` (with `.bak` backup
 * when `AGENTS.md` already exists) so it is immediately active in the system prompt.
 */
export const writeOperatorDirective = async (
  cwd: string,
  sessionDir: string,
  directive: string | null,
): Promise<{
  agentsPath: string;
  sessionDirectivePath: string;
  backupPath: string | null;
}> => {
  const sessionDirectivePath = join(sessionDir, "operator-directives.md");
  const agentsPath = join(cwd, "AGENTS.md");
  let backupPath: string | null = null;

  const clean = (directive ?? "").trim();
  await writeFile(sessionDirectivePath, clean ? `${clean}\n` : "", {
    mode: 0o600,
  });

  const existing = existsSync(agentsPath)
    ? await readFile(agentsPath, "utf8").catch(() => "")
    : "";
  if (existing) {
    backupPath = `${agentsPath}.bak`;
    await copyFile(agentsPath, backupPath).catch(() => {
      backupPath = null;
    });
  }

  const managedBlock = clean
    ? `${OMR_DIRECTIVE_BEGIN}\n## OMR Operator Directives\n\n${clean}\n${OMR_DIRECTIVE_END}`
    : "";

  let updated: string;
  const start = existing.indexOf(OMR_DIRECTIVE_BEGIN);
  const end = existing.indexOf(OMR_DIRECTIVE_END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start).replace(/\s*$/, "");
    const after = existing
      .slice(end + OMR_DIRECTIVE_END.length)
      .replace(/^\s*/, "");
    updated = [before, managedBlock, after].filter(Boolean).join("\n\n");
  } else if (managedBlock) {
    updated = existing.trim()
      ? `${existing.trim()}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;
  } else {
    updated = existing;
  }

  if (updated || existsSync(agentsPath)) {
    await writeFile(
      agentsPath,
      updated.endsWith("\n") || !updated ? updated : `${updated}\n`,
      "utf8",
    );
  }
  return { agentsPath, sessionDirectivePath, backupPath };
};

/** Instruction files are prompt text on every turn, so they are bounded; the cut is reported, never silent. */
export const PROJECT_INSTRUCTIONS_LIMIT = 24_000;

export interface ProjectInstructions {
  readonly path: string;
  /** Instruction text (omr's own managed `/jb` block removed), cut at {@link PROJECT_INSTRUCTIONS_LIMIT}. */
  readonly text: string;
  /** Length of the full text before any cut. */
  readonly chars: number;
  readonly truncated: boolean;
}

const stripManagedDirectiveBlock = (raw: string): string => {
  const start = raw.indexOf(OMR_DIRECTIVE_BEGIN);
  const end = raw.indexOf(OMR_DIRECTIVE_END);
  return start >= 0 && end > start
    ? `${raw.slice(0, start)}${raw.slice(end + OMR_DIRECTIVE_END.length)}`
    : raw;
};

const toProjectInstructions = (
  path: string,
  raw: string,
): ProjectInstructions | null => {
  const text = stripManagedDirectiveBlock(raw).replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const truncated = text.length > PROJECT_INSTRUCTIONS_LIMIT;
  return {
    path,
    text: truncated ? text.slice(0, PROJECT_INSTRUCTIONS_LIMIT) : text,
    chars: text.length,
    truncated,
  };
};

const instructionCache = new Map<
  string,
  { mtimeMs: number; size: number; value: ProjectInstructions | null }
>();

/**
 * The project's `AGENTS.md` (`<cwd>/AGENTS.md`), read live: it is re-parsed only when its mtime or size
 * changes, so an edit takes effect on the next turn without a restart and an unchanged file costs one `stat`.
 * `/jb`'s managed block is excluded here because it is delivered separately as the operator directive.
 */
export const readProjectInstructions = (
  cwd: string,
): ProjectInstructions | null => {
  const path = join(cwd, "AGENTS.md");
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(path);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const cached = instructionCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
    return cached.value;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const value = toProjectInstructions(path, raw);
  instructionCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
};

/** Read an operator-named instruction file (`/agents.md <path>`); `null` when unreadable or empty. */
export const readInstructionFile = (
  path: string,
): ProjectInstructions | null => {
  try {
    if (!statSync(path).isFile()) return null;
    return toProjectInstructions(path, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
