import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { padEndAnsi } from "../../ansi.js";
import { inspectTargetMagic } from "../../binaryArt.js";
import {
  COMPACTION_MODES,
  COMPACTION_STRATEGIES,
  estimateTokens,
  formatTokenCountShort,
  normalizeCompactionModelSpec,
  parseCompactionStrategy,
  persistCompactionSettings,
  resolveCompactionSettings,
  resolveThresholdTokens,
} from "../../compaction.js";
import { saveCustomCommandFile } from "../../customCommands.js";
import { readFileTail } from "../../journal.js";
import type { ModelPort } from "../../model.js";
import { estimateSessionCostUsd } from "../../modelConfig.js";
import { parseSessionSnapshot } from "../../broker.js";
import {
  compactJson,
  ledgerHealthLabel,
  normalized,
  renderEvidence,
  renderJournalTail,
  renderOpen,
  renderSession,
  renderUnknowns,
} from "../../render.js";
import {
  evidenceIdsInMessages,
  extractCodeBlocks,
  forkSession,
  listRecentSessions,
  loadSavedSession,
  previewSavedSession,
  sessionInfoFromSummary,
  saveCodeBlockToDisk,
  saveSessionHistory,
  stripInternalPromptNotes,
} from "../../session.js";
import { resolveTargetPath } from "../../target.js";
import { asNumber, asRecord } from "../../values.js";
import type { CommandRegistry } from "../commandRegistry.js";
import {
  describeCompaction,
  errorMessageOf,
  splitShellTokens,
} from "../utils.js";

/** Sent automatically when a resumed session ended mid-turn, so the operator never has to type "continue". */
const INTERRUPTED_TURN_PROMPT =
  "[omr:auto-resume] The previous omr process ended in the middle of this investigation (crash, kill, or power loss). " +
  "The conversation above is restored up to the last completed step, including every tool result already received. " +
  "Continue the same task exactly where it stopped; do not restart it or repeat tool calls whose results are already above. " +
  "REA's live session was rebuilt, so any ev_ IDs cited above are not loaded in it: re-run a tool before presenting one as fresh Evidence.";

export const registerSessionHandlers = (registry: CommandRegistry): void => {
  registry.register("coverage", async (ctx, rest) => {
    let itemId: string | undefined, offset: number | undefined, limit: number | undefined;
    for (const token of splitShellTokens(rest)) {
      if (token.startsWith("offset=")) offset = Number(token.slice(7));
      else if (token.startsWith("limit=")) limit = Number(token.slice(6));
      else if (itemId === undefined) itemId = token;
      else throw new Error(ctx.output.i18n.t("common.usage", { command: "/coverage [item-id] [offset=N] [limit=N]" }));
    }
    const result = await ctx.runtime.coverage.report({ ...(itemId ? { itemId } : {}), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
    ctx.output.commandResult("coverage", result, JSON.stringify(result, null, 2));
  });

  registry.register("recipe", async (ctx, rest) => {
    if (!rest || rest === "list") {
      const result = { recipes: ctx.runtime.recipes.list(), recentRuns: await ctx.runtime.recipes.recent() };
      ctx.output.commandResult("recipe", result, JSON.stringify(result, null, 2)); return;
    }
    const inspect = /^inspect\s+(\S+)$/.exec(rest);
    if (inspect) { const result = await ctx.runtime.recipes.inspect(inspect[1]!); ctx.output.commandResult("recipe", result, JSON.stringify(result, null, 2)); return; }
    const run = /^run\s+(\S+)\s+([\s\S]+)$/.exec(rest);
    if (!run) { ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/recipe [list|run <recipe> <input-json>|inspect <run-id>]" })); return; }
    if (ctx.activeAbort) { ctx.output.fail(ctx.output.i18n.t("sessionResult.recipeBusy")); return; }
    await ctx.ensureConnected(); const abort = new AbortController(); ctx.activeAbort = abort;
    try {
      const result = await ctx.runtime.recipes.run(run[1]!, JSON.parse(run[2]!), abort.signal);
      ctx.output.recordOutcome({ status: result.status === "running" ? "failed" : result.status, finishReason: result.status === "completed" ? "recipe_exit_conditions_met" : result.problem });
      ctx.output.commandResult("recipe", result, JSON.stringify(result, null, 2));
    } catch (error) {
      if (abort.signal.aborted) ctx.output.recordOutcome({ status: "cancelled", finishReason: "cancelled" }); else throw error;
    } finally { ctx.activeAbort = null; }
  });

  registry.register("state", async (ctx, rest) => {
    let state;
    if (!rest || rest === "get") {
      state = await ctx.runtime.task.read();
    } else {
      const update = /^update\s+(\d+)\s+([\s\S]+)$/.exec(rest);
      if (!update) { ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/state [get|update <revision> <patch-json>]" })); return; }
      state = await ctx.runtime.task.update(JSON.parse(update[2]!), Number(update[1]));
    }
    ctx.output.commandResult("state", state, JSON.stringify(state, null, 2));
  });

  registry.register("open", async (ctx, rest) => {
    const resolved = resolveTargetPath(rest, ctx.cwd);
    if (!resolved) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/open <path>" }));
      return;
    }
    const magic = await inspectTargetMagic(resolved);
    if (magic?.label === "Directory Target") {
      await ctx.selectTarget(resolved);
      ctx.currentMagic = magic;
      ctx.targetOpened = false;
      ctx.targetOpenFailedPath = null;
      ctx.boundProvider = null;
      await ctx.persistMeta(ctx.currentTarget);
      await ctx.syncLocalStatus();
      ctx.output.commandResult(
        "open",
        { path: resolved, kind: "directory" },
        ctx.output.i18n.t("sessionResult.boundDirectory", { path: resolved }),
      );
      return;
    }
    try {
      await ctx.ensureConnected();
    } catch {
      return;
    }
    const result = await ctx.reaCall("open_binary", { path: resolved });
    if (result.problem) {
      ctx.output.fail(result.problem);
      return;
    }
    await ctx.selectTarget(resolved);
    ctx.targetOpened = true;
    ctx.targetOpenFailedPath = null;
    await ctx.syncMagic(ctx.currentTarget);
    await ctx.persistMeta(ctx.currentTarget);
    await ctx.syncBoundSessionSummary();
    ctx.output.commandResult("open", result.payload, renderOpen(result.payload, ctx.output.i18n));
  });

  registry.register("close", async (ctx) => {
    const result = await ctx.reaCall("close_binary", {});
    if (result.problem) {
      ctx.output.fail(result.problem);
      return;
    }
    await ctx.selectTarget(null);
    ctx.currentMagic = null;
    ctx.targetOpened = false;
    ctx.targetOpenFailedPath = null;
    ctx.boundProvider = null;
    await ctx.persistMeta(null);
    await ctx.syncLocalStatus();
    ctx.output.commandResult("close", result.payload, ctx.output.i18n.t("sessionResult.closed"));
  });

  registry.register("status", async (ctx) => {
    const { t } = ctx.output.i18n;
    const [snapshot, investigation] = await Promise.all([
      ctx.reaCall("binary_session", { detail: "summary" }),
      ctx.ensureConnected().then(()=>ctx.runtime.investigation.refresh({force:true})),
    ]);
    const journalState = await ctx.journalTailer.sync();
    const parsedSnap = parseSessionSnapshot(snapshot.payload);
    if (parsedSnap) await ctx.applyParsedSnapshot(parsedSnap);

    const ledger = investigation.ledger;

    const row = (label: string, value: string): string => padEndAnsi(label, 10) + value;
    const lines = [
      row(t("status.session"), ctx.session.id),
      renderSession(snapshot.payload, ctx.output.i18n),
    ];
    if (ctx.currentMagic) lines.push(row(t("hud.format"), ctx.currentMagic.label));
    if (ctx.activeProfile)
      lines.push(
        row(t("status.profile"), `${ctx.activeProfile.id} (${ctx.activeProfile.summary})`),
      );
    lines.push(
      row(t("hud.evidence"), t("status.counts", {
        evidence: ledger.evidence ?? "?", open: ledger.unknownOpen ?? "?", total: ledger.unknownTotal ?? "?",
        resolved: ledger.unknownResolved ?? "?", source: ledgerHealthLabel(ctx.output.i18n, ledger.health),
      })),
      row(t("hud.journal"), t("status.events", { count: journalState.counts.records })),
    );
    lines.push(
      row(t("hud.model"), (ctx.opts.noModel ? t("status.noModel") : ctx.modelId) +
        (ctx.agent && ctx.agent.totalTokens > 0 ? t("status.modelTokens", { count: ctx.agent.totalTokens }) : "")),
    );
    if (ctx.sources.length > 0)
      lines.push(row(t("status.environment"), ctx.sources.join(", ")));
    await ctx.syncLocalStatus();
    ctx.output.commandResult(
      "status",
      {
        session: ctx.session.id,
        profile: ctx.activeProfile?.id ?? null,
        snapshot: snapshot.payload,
        evidence: {total_retained_records:ledger.evidence,source:ledger.health},
        unknowns: {total:ledger.unknownTotal,non_resolved:ledger.unknownOpen,resolved:ledger.unknownResolved},
        investigation,
        journal: {events:journalState.counts.records,source:"native journal"},
        tokens: ctx.runtime.usage.snapshot().totalTokens,
      },
      lines.join("\n"),
    );
  });

  registry.register("evidence", async (ctx, rest) => {
    if (!rest) {
      const summary = await ctx.reaCall("get_evidence_bundle", {
        detail: "summary",
      });
      if (summary.problem) {
        ctx.output.fail(summary.problem);
        return;
      }
      ctx.output.commandResult(
        "evidence",
        summary.payload,
        renderEvidence(summary.payload, ctx.output.i18n),
      );
      return;
    }
    const resolved = await ctx.resolveEvidenceLookupId(rest);
    if (!resolved.id) {
      ctx.output.fail(resolved.error ?? ctx.output.i18n.t("sessionResult.badEvidence", { id: rest }));
      return;
    }
    const result = await ctx.reaCall("get_evidence_bundle", {
      detail: "records",
      filters: { evidence_id: resolved.id },
      limit: 1,
    });
    if (result.problem) {
      ctx.output.fail(result.problem);
      return;
    }
    ctx.output.commandResult(
      "evidence",
      result.payload,
      compactJson(normalized(result.payload), 14_000),
    );
  });

  registry.register("unknowns", async (ctx) => {
    const result = await ctx.reaCall("list_unknowns", { limit: 25 });
    if (result.problem) {
      ctx.output.fail(result.problem);
      return;
    }
    ctx.output.commandResult(
      "unknowns",
      result.payload,
      renderUnknowns(result.payload, ctx.output.i18n),
    );
  });

  registry.register("export", async (ctx, rest) => {
    const path = rest
      ? resolveTargetPath(rest, ctx.cwd)
      : ctx.session.evidencePath;
    const result = await ctx.reaCall("export_evidence_bundle", {
      path,
      overwrite: true,
    });
    if (result.problem) {
      ctx.output.fail(result.problem);
      return;
    }
    ctx.output.commandResult(
      "export",
      result.payload,
      ctx.output.i18n.t("sessionResult.wrote", { data: compactJson(normalized(result.payload), 2_000), path }),
    );
  });

  registry.register("report", async (ctx, rest) => {
    const parts = splitShellTokens(rest);
    const sub = (parts[0] ?? "view").toLowerCase();
    const report = sub === "view"
      ? await readFileTail(ctx.session.reportPath, 262_144)
      : await readFile(ctx.session.reportPath, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        });
    const messages = ctx.agent?.history ?? [];
    const citedEv = new Set<string>([
      ...ctx.evidenceSeen,
      ...evidenceIdsInMessages(messages),
    ]);
    for (const m of report.match(/ev_[A-Za-z0-9_-]{3,}/g) ?? []) {
      citedEv.add(m);
    }
    const citedUnk = new Set<string>();
    const fullText = `${report}\n${messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")}`;
    for (const m of fullText.match(/unk_[A-Za-z0-9_-]{3,}/g) ?? []) {
      citedUnk.add(m);
    }
    let scriptsList: string[] = [];
    try {
      const files = await readdir(join(ctx.session.dir, "scripts"));
      scriptsList = files.sort();
    } catch {
      scriptsList = [];
    }
    const totalTokens = ctx.agent?.totalTokens ?? 0;
    const costUsd = estimateSessionCostUsd(ctx.modelId, totalTokens);

    const buildDossierMarkdown = (): string => {
      const evArr = [...citedEv];
      const unkArr = [...citedUnk];
      return [
        `# OMR Forensic Session Dossier — ${ctx.session.id}`,
        "",
        "| Field | Value |",
        "| :--- | :--- |",
        `| **Session ID** | \`${ctx.session.id}\` |`,
        `| **Target** | \`${ctx.currentTarget ?? "(none)"}\`${ctx.currentMagic ? ` (${ctx.currentMagic.label})` : ""} |`,
        `| **Model** | \`${ctx.modelId}\` |`,
        `| **Profile** | \`${ctx.activeProfile?.id ?? "default"}\` |`,
        `| **Tokens & Est. Cost** | ${totalTokens.toLocaleString()} tokens (~$${costUsd.toFixed(4)} USD) |`,
        `| **Evidence Ledger** | ${evArr.length} cited record(s)${evArr.length > 0 ? `: ${evArr.slice(0, 20).map((e) => `\`${e}\``).join(", ")}` : ""} |`,
        `| **Residual Unknowns** | ${unkArr.length} cited unknown(s)${unkArr.length > 0 ? `: ${unkArr.slice(0, 20).map((u) => `\`${u}\``).join(", ")}` : ""} |`,
        `| **Synthesized Scripts** | ${scriptsList.length > 0 ? scriptsList.map((s) => `\`${s}\``).join(", ") : "(none)"} |`,
        "",
        "---",
        "",
        report.trim() || "*(no investigation report entries recorded yet)*",
        "",
      ].join("\n");
    };

    if (
      sub === "json" ||
      (sub !== "view" && sub !== "export" && sub.endsWith(".json"))
    ) {
      const rawOut =
        sub === "json"
          ? parts[1]
          : parts[0];
      const outPath = rawOut
        ? resolveTargetPath(rawOut, ctx.cwd)
        : join(ctx.session.dir, "forensic-report.json");
      const dossier = {
        protocol: "omr-report/v1",
        generated_at: new Date().toISOString(),
        session_id: ctx.session.id,
        session_dir: ctx.session.dir,
        target: ctx.currentTarget,
        target_format: ctx.currentMagic?.label ?? null,
        model: ctx.modelId,
        profile: ctx.activeProfile?.id ?? null,
        tokens: totalTokens,
        estimated_cost_usd: costUsd,
        evidence_ids: [...citedEv],
        unknown_ids: [...citedUnk],
        scripts: scriptsList,
        messages_count: Math.max(0, messages.length - 1),
        report_markdown: report.trim(),
      };
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(dossier, null, 2)}\n`, "utf8");
      ctx.output.commandResult(
        "report",
        {
          format: "json",
          output_path: outPath,
          evidence_count: citedEv.size,
          unknown_count: citedUnk.size,
          scripts_count: scriptsList.length,
        },
        ctx.output.i18n.t("sessionResult.jsonExport", { evidence: citedEv.size, unknowns: citedUnk.size, scripts: scriptsList.length, path: outPath }),
      );
      return;
    }

    if (
      sub === "export" ||
      sub === "md" ||
      sub === "markdown" ||
      (sub !== "view" && rest.trim().length > 0)
    ) {
      const rawOut =
        sub === "export" || sub === "md" || sub === "markdown"
          ? parts[1]
          : parts[0];
      const outPath = rawOut
        ? resolveTargetPath(rawOut, ctx.cwd)
        : join(ctx.session.dir, "forensic-report.md");
      const md = buildDossierMarkdown();
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, md, "utf8");
      ctx.output.commandResult(
        "report",
        {
          format: "markdown",
          output_path: outPath,
          evidence_count: citedEv.size,
          unknown_count: citedUnk.size,
          scripts_count: scriptsList.length,
        },
        ctx.output.i18n.t("sessionResult.markdownExport", { evidence: citedEv.size, unknowns: citedUnk.size, scripts: scriptsList.length, path: outPath }),
      );
      return;
    }

    ctx.output.commandResult(
      "report",
      {
        report_path: ctx.session.reportPath,
        evidence_ids: [...citedEv],
        unknown_ids: [...citedUnk],
        scripts: scriptsList,
        report,
      },
      report.trim() || "(no report yet)",
    );
  });

  registry.register("journal", async (ctx) => {
    const journal = await readFileTail(ctx.session.journalPath, 32_768);
    const lines = journal.trim().split("\n").filter(Boolean).slice(-30);
    ctx.output.commandResult(
      "journal",
      { journal_path: ctx.session.journalPath, lines },
      renderJournalTail(journal, ctx.output.i18n),
    );
  });

  registry.register("save", async (ctx, rest) => {
    const tokens = splitShellTokens(rest);
    if (
      tokens.length > 0 &&
      (tokens[0] === "--as-command" || tokens[0] === "--command")
    ) {
      const cmdName = tokens[1]?.trim() ?? "";
      if (!cmdName) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/save --as-command <name> [template_or_description]" }));
        return;
      }
      const extraText = tokens.slice(2).join(" ").trim();
      const lastUserFromHistory = ctx.agent
        ? ([...ctx.agent.history]
            .reverse()
            .find((m) => m.role === "user" && typeof m.content === "string")
            ?.content ?? "")
        : "";
      const template =
        extraText ||
        ctx.lastUserPrompt ||
        lastUserFromHistory ||
        `Analyze $TARGET with focus on $ARGUMENTS.`;
      try {
        const created = await saveCustomCommandFile({
          name: cmdName,
          description: extraText
            ? `Custom workflow: ${extraText.slice(0, 80)}`
            : `Saved OMR command /${cmdName}`,
          template,
          cwd: ctx.cwd,
          env: ctx.env,
        });
        ctx.reloadCustomCommands();
        ctx.output.commandResult(
          "save",
          {
            command: created.spec.name,
            path: created.path,
            usage: created.spec.usage,
          },
          `saved reusable slash command /${created.spec.name} → ${created.path}\nRun it anytime with: /${created.spec.name} [focus]`,
        );
      } catch (error) {
        ctx.output.fail(errorMessageOf(error));
      }
      return;
    }

    const sourceText =
      ctx.lastAssistantText ||
      (ctx.agent
        ? ([...ctx.agent.history]
            .reverse()
            .find(
              (m) =>
                m.role === "assistant" &&
                typeof m.content === "string" &&
                m.content.includes("```"),
            )?.content ?? "")
        : "");
    const blocks = extractCodeBlocks(sourceText);
    if (blocks.length === 0) {
      if (ctx.lastSavedScriptPath) {
        ctx.output.commandResult(
          "save",
          { path: ctx.lastSavedScriptPath },
          ctx.output.i18n.t("sessionResult.alreadySaved", { path: ctx.lastSavedScriptPath }),
        );
        return;
      }
      ctx.output.fail(
        ctx.output.i18n.t("sessionResult.noFencedCode"),
      );
      return;
    }
    const saved = await saveCodeBlockToDisk(
      { ...ctx.session, target: ctx.currentTarget },
      sourceText,
      {
        explicitPath: rest || undefined,
        cwd: ctx.cwd,
        defaultPrefix: "omr-artifact",
      },
    );
    if (!saved) {
      ctx.output.fail(ctx.output.i18n.t("sessionResult.saveFailed"));
      return;
    }
    ctx.lastSavedScriptPath = saved.path;
    ctx.output.commandResult(
      "save",
      saved,
      ctx.output.i18n.t("sessionResult.saved", { kind: saved.language || "script", bytes: saved.bytes, evidence: saved.evidenceIds.length, path: saved.path }),
    );
  });

  registry.register("rename", async (ctx, rest) => {
    const nextTitle = rest.trim();
    if (!nextTitle) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/rename <new_chat_title>" }));
      return;
    }
    const messages = ctx.agent?.history ?? [];
    await saveSessionHistory(
      { ...ctx.session, target: ctx.currentTarget },
      messages,
      ctx.currentTarget,
      ctx.modelId,
      { customTitle: nextTitle },
    );
    ctx.output.commandResult(
      "rename",
      {
        session: ctx.session.id,
        title: nextTitle,
      },
      ctx.output.i18n.t("sessionResult.renamed", { title: nextTitle }),
    );
  });

  registry.register("resume", async (ctx, rest) => {
    const arg = rest.trim();
    const lowerArg = arg.toLowerCase();
    if (lowerArg === "reconcile" || lowerArg.startsWith("reconcile ")) {
      const parts = splitShellTokens(arg);
      const id = parts[1];
      const resolution = parts[2];
      if (id && resolution) {
        if (resolution !== "completed" && resolution !== "retry") {ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/resume reconcile <invocation-id> completed|retry <observation or decision>" })); return;}
        await ctx.runtime.events.resolve(id, resolution, parts.slice(3).join(" "));
        ctx.output.commandResult("resume", {invocation_id: id, resolution}, ctx.output.i18n.t("sessionResult.reconciled", { id, resolution }));
      } else {
        const originDir = ctx.runtime.evidenceOrigin?.sourceDir ?? ctx.session.dir;
        const pending = await ctx.runtime.events.reconcileNativeJournal(join(originDir, "journal.jsonl"));
        ctx.output.commandResult("resume", {unresolved: pending}, pending.length ? `${compactJson(pending, 14_000)}\nUse /resume reconcile <id> completed|retry <observation or decision>. Journal candidates are not proof of invocation ownership.` : "no unresolved invocations");
      }
      return;
    }
    if (lowerArg.startsWith("rename ") || lowerArg.startsWith("title ")) {
      const nextTitle = arg.replace(/^(?:rename|title)\s+/i, "").trim();
      if (!nextTitle) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/resume rename <new_chat_title>" }));
        return;
      }
      await saveSessionHistory(
        { ...ctx.session, target: ctx.currentTarget },
        ctx.agent?.history ?? [],
        ctx.currentTarget,
        ctx.modelId,
        { customTitle: nextTitle },
      );
      ctx.output.commandResult(
        "resume",
        { session: ctx.session.id, title: nextTitle },
        ctx.output.i18n.t("sessionResult.renamed", { title: nextTitle }),
      );
      return;
    }
    if (!arg || lowerArg === "list" || lowerArg === "pick") {
      const recent = await listRecentSessions(
        25,
        ctx.session.id,
        ctx.sessionsRootDir,
      );
      if (recent.length === 0) {
        ctx.output.commandResult(
          "resume",
          { sessions: [] },
          ctx.output.i18n.t("sessionResult.noSaved"),
        );
        return;
      }
      // In interactive TUI, both `/resume` and `/resume list` open the interactive Session Picker modal
      if (ctx.output.ui) {
        ctx.output.ui.openSessionPicker(recent);
        return;
      }
      const lines = [
        "saved sessions (use `/resume <#|shortId|id>` or `/resume last` to restore):",
      ];
      for (const item of recent) {
        const tgt = item.target
          ? item.target.split(/[\\/]/).at(-1)
          : "no-target";
        const idxLabel = `#${item.index}`.padEnd(3);
        const titlePart = item.title ? `"${item.title}"` : item.id;
        lines.push(
          `  ${idxLabel} [${item.shortId}]  ${titlePart} · ${String(item.messageCount).padStart(3)} msgs · ${tgt} · ${item.updatedAt} (${item.id})`,
        );
      }
      ctx.output.commandResult("resume", { sessions: recent }, lines.join("\n"));
      return;
    }
    if (ctx.activeAbort) { ctx.output.fail(ctx.output.i18n.t("sessionResult.resumeBusy")); return; }
    const ui = ctx.output.ui;
    const previousHistory = ctx.agent?.history ?? [];
    const preview = ui ? await previewSavedSession(arg, ctx.session.id, ctx.sessionsRootDir) : null;
    if (preview) {
      ui?.hydrateFromHistory(preview.messages);
      ui?.setBusy((t) => t("sessionResult.restoring"));
    }
    const loaded = await loadSavedSession(
      arg,
      ctx.session.id,
      ctx.sessionsRootDir,
    );
    if (!loaded) {
      if (preview) ui?.hydrateFromHistory(previousHistory);
      ui?.setBusy(null);
      ctx.output.fail(ctx.output.i18n.t("sessionResult.notFound", { query: arg }));
      return;
    }
    if (!preview || preview.id !== loaded.summary.id) ui?.hydrateFromHistory(loaded.messages);
    ui?.setBusy((t) => t("sessionResult.restoring"));
    try {
      const source = sessionInfoFromSummary(loaded.summary);
      const continuation = await forkSession(source, loaded.messages, loaded.summary.target, ctx.modelId, {label: "resume", rootDir: ctx.sessionsRootDir});
      await ctx.switchSession(continuation, {source, kind: "resume"});
      await ctx.ensureConnected();
      const originalGoal = loaded.messages.find(message => message.role === "user")?.content;
      if (typeof originalGoal === "string") await ctx.runtime.task.initializeGoal(stripInternalPromptNotes(originalGoal));
    } catch (error) {
      ui?.setBusy(null);
      ui?.hydrateFromHistory(loaded.messages);
      ctx.output.fail(ctx.output.i18n.t("sessionResult.resumeFailed", { detail: errorMessageOf(error) }));
      return;
    }
    ctx.ensureAgentInitialized();
    const resumedTarget = loaded.summary.target;
    const resumedId = loaded.summary.id;
    const resumedTitle = loaded.summary.title || resumedId;
    const resumedShort = loaded.summary.shortId || resumedId;
    let droppedMessages = loaded.droppedMessages;
    let agentDropped = 0;
    if (ctx.agent) {
      agentDropped = ctx.agent.restoreHistory(loaded.messages).droppedMessages;
      droppedMessages += agentDropped;
      ctx.broker?.restoreSticky(ctx.agent.history);
      ctx.lastAssistantText =
        [...ctx.agent.history]
          .reverse()
          .find(
            (m) =>
              m.role === "assistant" &&
              typeof m.content === "string" &&
              m.content.includes("```"),
          )?.content ?? "";
      await ctx.persistHistory(
        ctx.agent.history,
        resumedTarget ?? ctx.currentTarget,
      );
    }
    const carriedIds = evidenceIdsInMessages(ctx.agent?.history ?? []);
    for (const id of carriedIds) {
      if (!ctx.runtime.importedEvidenceIds.has(id)) continue;
      ctx.evidenceSeen.add(id);
      ctx.lastEvidenceId = id;
    }
    const carriedEvidence = carriedIds.length;
    const unverifiedEvidence = carriedIds.filter((id) => !ctx.runtime.importedEvidenceIds.has(id)).length;
    if (resumedTarget && resumedTarget !== ctx.currentTarget) {
      await ctx.selectTarget(resumedTarget);
      ctx.targetOpened = false;
      ctx.targetOpenFailedPath = null;
      await ctx.syncMagic(ctx.currentTarget);
      await ctx.ensureTargetOpen();
    }
    await ctx.syncLocalStatus();
    const restoredMessages = ctx.agent ? ctx.agent.history : loaded.messages;
    const restoredCount = ctx.agent
      ? Math.max(0, ctx.agent.history.length - 1)
      : loaded.messages.length;
    const { t } = ctx.output.i18n;
    const carriedNote =
      unverifiedEvidence > 0
        ? `\n${t("sessionResult.unverified", { count: unverifiedEvidence, session: resumedId })}`
        : "";
    const repairNote = droppedMessages > 0 ? `\n${t("sessionResult.discarded", { count: droppedMessages })}` : "";
    const archiveNote = loaded.archivedMessages > 0 ? `\n${t("sessionResult.archived", { count: loaded.archivedMessages })}` : "";
    const target = resumedTarget ? t("sessionResult.targetTag", { target: `\`${resumedTarget}\`` }) : "";
    const banner = t("sessionResult.resumeBanner", { index: loaded.summary.index, short: resumedShort, title: resumedTitle, id: resumedId, count: restoredCount, target });
    const bannerText = banner + carriedNote + repairNote + archiveNote;
    if (ctx.output.ui) {
      // The transcript is already on screen; re-render it only if the agent's repaired history differs.
      if (!preview && agentDropped === 0 && restoredCount === loaded.messages.length) ctx.output.ui.addSystem(bannerText);
      else ctx.output.ui.hydrateFromHistory(restoredMessages, { bannerText });
      if (ctx.opts.json) {
        ctx.output.emit("command.result", {
          command: "resume",
          payload: {
            resumed_session: resumedId,
            short_id: resumedShort,
            title: resumedTitle,
            messages: restoredCount,
            dropped_messages: droppedMessages,
            carried_evidence_ids: carriedEvidence,
            unverified_evidence_ids: unverifiedEvidence,
            session_dir: ctx.session.dir,
            evidence_origin: ctx.runtime.evidenceOrigin,
            interrupted_turn: loaded.inFlight,
            target: ctx.currentTarget,
          },
        });
      }
    } else {
      ctx.output.commandResult(
        "resume",
        {
          resumed_session: resumedId,
          short_id: resumedShort,
          title: resumedTitle,
          messages: restoredCount,
          dropped_messages: droppedMessages,
          carried_evidence_ids: carriedEvidence,
          unverified_evidence_ids: unverifiedEvidence,
          session_dir: ctx.session.dir,
          evidence_origin: ctx.runtime.evidenceOrigin,
          interrupted_turn: loaded.inFlight,
          target: ctx.currentTarget,
        },
        t("sessionResult.resumed", { id: resumedId, short: resumedShort, title: resumedTitle, count: restoredCount,
          target: ctx.currentTarget ? t("sessionResult.targetTag", { target: ctx.currentTarget }) : "" }) + carriedNote + repairNote,
      );
    }
    // The previous process died mid-turn: pick the investigation back up without a manual "continue".
    if (loaded.inFlight && ctx.agent && !ctx.opts.noModel) {
      const pending = await ctx.runtime.events.unresolved();
      if (pending.some((intent) => !intent.readOnly)) {
        ctx.output.fail(ctx.output.i18n.t("sessionResult.reconcileFirst"));
        return;
      }
      ctx.output.ui?.addSystem(
        ctx.output.i18n.t("sessionResult.interrupted"),
      );
      await ctx.runTurn(INTERRUPTED_TURN_PROMPT, "resume: interrupted turn");
    }
  });

  registry.register("rewind", async (ctx, rest) => {
    const rawCount = rest.trim();
    const count = rawCount ? Number.parseInt(rawCount, 10) : 1;
    if (!Number.isFinite(count) || count < 1) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/rewind [turns] (positive integer, default 1)" }));
      return;
    }
    if (!ctx.agent || ctx.agent.history.length <= 1) {
      ctx.output.commandResult(
        "rewind",
        {
          removed_turns: 0,
          removed_messages: 0,
          remaining_turns: 0,
          remaining_messages: 0,
        },
        ctx.output.i18n.t("sessionResult.noRewind"),
      );
      return;
    }
    const res = ctx.agent.rewind(count);
    ctx.lastAssistantText =
      [...ctx.agent.history]
        .reverse()
        .find((m) => m.role === "assistant" && typeof m.content === "string")
        ?.content ?? "";
    await ctx.persistHistory(ctx.agent.history, ctx.currentTarget);
    await ctx.syncLocalStatus();
    const text = `rewound ${res.removedTurns} turn(s) (${res.removedMessages} message(s) removed · ${res.remainingTurns} turn(s) / ${res.remainingMessages} message(s) remaining)`;
    if (ctx.output.ui) {
      ctx.output.ui.hydrateFromHistory(ctx.agent.history, {
        bannerText: text,
      });
    }
    ctx.output.commandResult(
      "rewind",
      {
        removed_turns: res.removedTurns,
        removed_messages: res.removedMessages,
        remaining_turns: res.remainingTurns,
        remaining_messages: res.remainingMessages,
      },
      text,
    );
  });

  registry.register("fork", async (ctx, rest) => {
    if (ctx.activeAbort) {ctx.output.fail(ctx.output.i18n.t("sessionResult.forkBusy"));return;}
    const label = rest.trim() || undefined;
    const sourceId = ctx.session.id;
    const messages = ctx.agent?.history ?? [];
    try {
      await ctx.subagentRunner.cancelAll();
      await ctx.runtime.captureEvidence().catch((error: unknown) => ctx.output.warnPersistenceOnce("evidence-export", error));
      await ctx.runtime.events.flush();
      const forked = await forkSession(
        ctx.session,
        messages,
        ctx.currentTarget,
        ctx.modelController.modelInfo?.config.model ?? null,
        { label, rootDir: ctx.sessionsRootDir },
      );
      await ctx.switchSession(forked);
      await ctx.syncLocalStatus();
      const nonSystemCount = Math.max(0, messages.length - 1);
      const text = [
        `forked session ${sourceId} → ${forked.id}`,
        `  branch dir  ${forked.dir}`,
        `  messages    ${nonSystemCount} preserved (original session remains intact for \`/resume ${sourceId}\`)`,
      ].join("\n");
      ctx.output.commandResult(
        "fork",
        {
          forked_from: sourceId,
          session_id: forked.id,
          session_dir: forked.dir,
          messages: nonSystemCount,
        },
        text,
      );
    } catch (error) {
      ctx.output.fail(ctx.output.i18n.t("sessionResult.forkFailed", { detail: errorMessageOf(error) }));
    }
  });

  registry.register("compact", async (ctx, rest) => {
    if (rest.trim().toLowerCase() === "model") {
      if (ctx.output.ui) {
        ctx.modelController.openInteractiveCompactionModelPicker();
        return;
      }
      ctx.output.fail(
        "usage: /compaction model=<provider:model|active> [--save]",
      );
      return;
    }
    if (!ctx.agent) {
      ctx.output.commandResult(
        "compact",
        {},
        ctx.output.i18n.t("sessionResult.noCompact"),
      );
      return;
    }
    if (ctx.activeAbort) {
      ctx.output.fail(
        ctx.output.i18n.t("sessionResult.compactionBusy"),
      );
      return;
    }
    const words = splitShellTokens(rest);
    let modelSpecOverride: string | null | undefined;
    const remaining: string[] = [];
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i]!;
      const lower = w.toLowerCase();
      if ((lower === "--model" || lower === "-m") && i + 1 < words.length) {
        modelSpecOverride = words[i + 1]!;
        i += 1;
      } else if (lower.startsWith("model=")) {
        modelSpecOverride = w.slice("model=".length);
      } else {
        remaining.push(w);
      }
    }
    const named =
      remaining.length > 0 ? parseCompactionStrategy(remaining[0]) : null;
    const focus = (named ? remaining.slice(1) : remaining).join(" ");
    const strategy =
      named && named !== "off"
        ? named
        : ctx.compactionSettings.strategy === "off"
          ? "shake"
          : ctx.compactionSettings.strategy;
    let overrideClient: ModelPort | null = null;
    if (modelSpecOverride !== undefined) {
      try {
        overrideClient =
          ctx.modelController.resolveCompactionModelClient(modelSpecOverride);
      } catch (error) {
        ctx.output.fail(errorMessageOf(error));
        return;
      }
    }
    ctx.activeAbort = new AbortController();
    ctx.output.ui?.setBusy((t) => t("sessionResult.compacting", { strategy }));
    try {
      const report = await ctx.agent.compactWith(
        strategy,
        focus,
        ctx.activeAbort.signal,
        false,
        null,
        overrideClient,
      );
      await ctx.persistHistory(ctx.agent.history, ctx.currentTarget);
      ctx.output.commandResult("compact", report, describeCompaction(report));
    } catch (error) {
      ctx.output.fail(
        `compaction ${ctx.activeAbort.signal.aborted ? "cancelled" : "failed"}: ${errorMessageOf(error)}`,
      );
    } finally {
      ctx.activeAbort = null;
      ctx.output.ui?.setBusy(null);
      ctx.output.ui?.setStatus({ context: ctx.contextStatus() });
    }
  });

  registry.register("compaction", async (ctx, rest) => {
    const words = splitShellTokens(rest);
    if (
      words.length === 1 &&
      words[0]!.toLowerCase() === "model" &&
      ctx.output.ui
    ) {
      ctx.modelController.openInteractiveCompactionModelPicker();
      return;
    }
    let next = ctx.compactionSettings;
    let save = false;
    const problems: string[] = [];
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      const lower = word.toLowerCase();
      const strategy = parseCompactionStrategy(lower);
      const window = /^window=(.+)$/.exec(lower)?.[1];
      const modelArg = /^model=(.*)$/i.exec(word)?.[1];
      const endpointArg = /^endpoint=(.*)$/i.exec(word)?.[1];
      if (lower === "--save" || lower === "-s") {
        save = true;
      } else if (
        (lower === "--model" || lower === "-m") &&
        i + 1 < words.length
      ) {
        const rawSpec = words[i + 1]!;
        i += 1;
        const norm = normalizeCompactionModelSpec(rawSpec);
        try {
          if (norm) ctx.modelController.resolveCompactionModelClient(norm);
          next = { ...next, compactionModel: norm };
        } catch (error) {
          problems.push(errorMessageOf(error));
        }
      } else if (modelArg !== undefined) {
        const norm = normalizeCompactionModelSpec(modelArg);
        try {
          if (norm) ctx.modelController.resolveCompactionModelClient(norm);
          next = { ...next, compactionModel: norm };
        } catch (error) {
          problems.push(errorMessageOf(error));
        }
      } else if (endpointArg !== undefined) {
        const cleanEp = endpointArg.trim();
        next = {
          ...next,
          remoteEndpoint:
            !cleanEp ||
            cleanEp.toLowerCase() === "default" ||
            cleanEp.toLowerCase() === "auto"
              ? null
              : cleanEp,
        };
      } else if (strategy) {
        next = { ...next, strategy };
      } else if (lower === "auto") {
        next = { ...next, thresholdPercent: null };
      } else if (/^\d{1,2}(\.\d+)?%?$/.test(lower)) {
        const percent = Number(lower.replace("%", ""));
        if (percent >= 1 && percent <= 99)
          next = { ...next, thresholdPercent: percent };
        else problems.push(`threshold must be 1–99%: ${word}`);
      } else if (window) {
        if (window === "auto") { next = {...next, windowSource: "model"}; continue; }
        const resolved = resolveCompactionSettings(
          { OMR_CONTEXT_WINDOW: window },
          null,
        ).contextWindow;
        if (/^[\d.,_]+[km]?$/i.test(window)) {
          next = {
            ...next,
            contextWindow: resolved,
            windowSource: "operator",
            keepRecentTokens: Math.min(
              next.keepRecentTokens,
              Math.floor(resolved / 2),
            ),
          };
        } else {
          problems.push(`invalid window: ${word}`);
        }
      } else {
        problems.push(`unknown argument: ${word}`);
      }
    }
    if (problems.length > 0) {
      ctx.output.fail(
        `${problems.join("; ")}\nusage: /compaction [${COMPACTION_STRATEGIES.join("|")}] [model=<provider:model|active>] [75%|auto] [window=1m] [--save]`,
      );
      return;
    }
    ctx.compactionSettings = next;
    let savedNote = "";
    if (save) {
      try {
        savedNote = ` (saved → ${persistCompactionSettings(next, ctx.env).path})`;
      } catch (error) {
        savedNote = ` (save failed: ${errorMessageOf(error)})`;
      }
    }
    ctx.output.ui?.setStatus({ context: ctx.contextStatus() });
    const threshold = resolveThresholdTokens(next);
    const activePrimaryLabel = `${ctx.modelController.modelInfo?.config.providerId ? `${ctx.modelController.modelInfo.config.providerId}:` : ""}${ctx.modelId}`;
    const compactorLabel = next.compactionModel
      ? `${next.compactionModel} (dedicated compaction AI; active turns stay on ${activePrimaryLabel})`
      : `active (${activePrimaryLabel})`;
    const lines = [
      `mode       ${next.strategy}${next.strategy === "off" ? " (never auto-compacts)" : ""}`,
      `ai model   ${compactorLabel} (Alt+C or /compaction model)`,
      `window     ${formatTokenCountShort(next.contextWindow)} tokens`,
      `trigger    ${formatTokenCountShort(threshold)} tokens (${Math.round((threshold / next.contextWindow) * 100)}%${next.thresholdPercent === null ? ", auto: window − max(15%, 16k)" : ""})`,
      `keep tail  ${formatTokenCountShort(next.keepRecentTokens)} tokens`,
      ...(next.remoteEndpoint ? [`endpoint   ${next.remoteEndpoint}`] : []),
      "modes:",
      ...COMPACTION_MODES.map(
        (m) =>
          `  ${next.strategy === m.id || (next.strategy === "context-full" && m.id === "soft") ? "▸" : " "} ${m.id.padEnd(12)} ${m.description}`,
      ),
    ];
    ctx.output.commandResult(
      "compaction",
      {
        strategy: next.strategy,
        compaction_model: next.compactionModel ?? null,
        remote_endpoint: next.remoteEndpoint ?? null,
        window: next.contextWindow,
        threshold_tokens: threshold,
        threshold_percent: next.thresholdPercent,
      },
      `${lines.join("\n")}${savedNote}`,
    );
  });

  registry.register("context", async (ctx) => {
    const usage = ctx.contextSnapshot();
    const activePrimaryLabel = `${ctx.modelController.modelInfo?.config.providerId ? `${ctx.modelController.modelInfo.config.providerId}:` : ""}${ctx.modelId}`;
    const compactorLabel = ctx.compactionSettings.compactionModel
      ? `${ctx.compactionSettings.compactionModel} (turns continue on ${activePrimaryLabel})`
      : `active (${activePrimaryLabel})`;
    // "conservative-default" is a placeholder, not a fact: never present it as the model's window.
    const windowUnknown = usage.windowSource === "conservative-default";
    const lines = [
      windowUnknown
        ? `context    ${formatTokenCountShort(usage.tokens)} tokens used · window unknown`
        : `context    ${formatTokenCountShort(usage.tokens)} / ${formatTokenCountShort(usage.window)} tokens (${usage.percent}%)`,
      `source     ${usage.source === "provider" ? "provider-reported usage" : "local estimate (no model step yet)"}`,
      `window     ${windowUnknown ? "unknown — set OMR_CONTEXT_WINDOW or context_window; the limit is learned from provider errors" : (usage.windowSource ?? "model")}`,
      windowUnknown
        ? `trigger    off until the window is known`
        : `trigger    ${formatTokenCountShort(usage.thresholdTokens)} tokens → ${ctx.compactionSettings.strategy}`,
      `compactor  ${compactorLabel}`,
      `messages   ${ctx.agent ? ctx.agent.history.length - 1 : 0} · history ≈ ${formatTokenCountShort(estimateTokens(ctx.agent?.historyChars() ?? 0))} tokens`,
      `session    ${formatTokenCountShort(ctx.agent?.totalTokens ?? 0)} tokens billed`,
    ];
    ctx.output.commandResult(
      "context",
      {
        tokens: usage.tokens,
        window: usage.window,
        percent: usage.percent,
        threshold_tokens: usage.thresholdTokens,
        strategy: ctx.compactionSettings.strategy,
        compaction_model: ctx.compactionSettings.compactionModel ?? null,
      },
      lines.join("\n"),
    );
  });

  registry.register("clear", async (ctx) => {
    ctx.agent?.clear();
    ctx.stagedBangEntries.length = 0;
    await ctx.persistHistory(ctx.agent?.history ?? [], ctx.currentTarget);
    ctx.output.ui?.clearChat();
    if (ctx.opts.json) {
      ctx.output.emit("command.result", { command: "clear", payload: {} });
    } else if (!ctx.output.ui) {
      ctx.output.write(ctx.output.i18n.t("sessionResult.cleared"));
    }
  });

  registry.register("dashboard", async (ctx) => {
    await ctx.startDashboard();
  });
};
