import { join } from "node:path";
import { parseLanguage } from "../../i18n/index.js";
import { rankCatalogTools } from "../../broker.js";
import { helpText } from "../../commands.js";
import { formatTokenCountShort } from "../../compaction.js";
import { readGuide } from "../../guide.js";
import {
  probeEndpointConnectivity,
  resolveProxyForEndpoint,
} from "../../model.js";
import {
  REASONING_EFFORT_LEVELS,
  estimateSessionCostUsd,
  modelConfigPath,
  parseFallbackModelsSpec,
  parseReasoningEffort,
  parseTokenBudgetSpec,
  saveModelRuntimeSettings,
  splitProviderModelSpec,
} from "../../modelConfig.js";
import { findProfile, renderProfileList } from "../../profiles.js";
import {
  compactJson,
  normalized,
  renderClassMatches,
  renderProviders,
  renderStringMatches,
} from "../../render.js";
import {
  PROJECT_INSTRUCTIONS_LIMIT,
  readInstructionFile,
  readOperatorDirective,
  readProjectInstructions,
  writeOperatorDirective,
} from "../../session.js";
import { resolveTargetPath } from "../../target.js";
import { buildClipboardImageAttachment } from "../../clipboard.js";
import type { BinaryFlowMode } from "../../tui.js";
import { asRecord, asString } from "../../values.js";
import { VERSION } from "../../version.js";
import {
  captureScreenshot,
  inspectImageForensics,
  isImageFilePath,
  loadImageSource,
  renderAnsiImagePreview,
  type ScreenshotMode,
} from "../../vision.js";
import type { CommandRegistry } from "../commandRegistry.js";
import { errorMessageOf, splitShellTokens } from "../utils.js";

export const registerSystemHandlers = (registry: CommandRegistry): void => {
  registry.register("lang", async (ctx, rest) => {
    const i18n = ctx.output.i18n;
    const args = rest ? rest.split(/\s+/) : [];
    const save = args.includes("--save");
    const codes = args.filter((arg) => arg !== "--save");
    const language = codes.length === 1 ? parseLanguage(codes[0]) : codes.length === 0 ? i18n.language : undefined;
    if (!language || args.length !== codes.length + Number(save)) {
      ctx.output.fail(i18n.t("language.usage"));
      return;
    }
    await i18n.switchTo(language);
    ctx.output.ui?.setCommands(ctx.allCommands());
    let saved: string | null = null;
    if (save) {
      try {
        saved = saveModelRuntimeSettings({ language }, ctx.env).path;
      } catch (error) {
        ctx.output.fail(i18n.t("language.saveFailed", { detail: errorMessageOf(error) }));
        return;
      }
    }
    const name = i18n.t(i18n.language === "en" ? "language.english" : "language.turkish");
    const message = i18n.t("language.current", { language: i18n.language, name });
    ctx.output.commandResult("lang", { language: i18n.language, saved }, saved ? `${message}\n${i18n.t("language.saved", { path: saved })}` : message);
  });
  registry.register("changelog", async (ctx, rest) => {
    const { changelogText, changelogError, noChangelogSection, localizeChangelogHeadings } = await import("../../changelog.js");
    const selection = rest || VERSION;
    try {
      const notes = await changelogText(selection);
      if (!notes) ctx.output.fail(noChangelogSection(ctx.output.i18n, selection));
      else if (ctx.output.ui) ctx.output.ui.showOutput("/changelog", localizeChangelogHeadings(notes, ctx.output.i18n), { expanded: true });
      else ctx.output.commandResult("changelog", { selection, markdown: notes }, notes);
    } catch (error) {
      ctx.output.fail(changelogError(ctx.output.i18n, error));
    }
  });
  registry.register("find", async (ctx, rest) => {
    let path = ctx.currentTarget ?? "";
    let isApk =
      ctx.currentMagic?.label === "Android APK" ||
      path.toLowerCase().endsWith(".apk") ||
      path.toLowerCase().endsWith(".aab");

    if (!path) {
      const snapshot = await ctx.reaCall("binary_session", {
        detail: "summary",
      });
      const record = asRecord(normalized(snapshot.payload)) ?? {};
      path = asString(record["path"]);
      isApk =
        (asString(record["kind"]) === "archive" &&
          asString(record["format"]) === "apk") ||
        path.toLowerCase().endsWith(".apk");
    }
    if (!path) {
      ctx.output.fail(ctx.output.i18n.t("commandResult.targetRequired"));
      return;
    }
    if (isApk) {
      const result = await ctx.reaCall("search_android_classes", {
        path,
        query: rest,
      });
      if (result.problem) {
        ctx.output.fail(result.problem);
        return;
      }
      ctx.output.commandResult(
        "find",
        result.payload,
        renderClassMatches(result.payload, ctx.output.i18n),
      );
      await ctx.syncLocalStatus();
      return;
    }
    const [strings, procedures] = await Promise.all([
      ctx.reaCall("search_strings", {
        pattern: rest,
        mode: "literal",
        case_sensitive: false,
      }),
      ctx.reaCall("search_procedures", {
        pattern: rest,
        mode: "literal",
        case_sensitive: false,
      }),
    ]);
    const lines: string[] = [
      "strings",
      strings.problem
        ? `  ${strings.problem}`
        : renderStringMatches(strings.payload, ctx.output.i18n),
      "procedures",
      procedures.problem
        ? `  ${procedures.problem}`
        : renderStringMatches(procedures.payload, ctx.output.i18n),
    ];
    ctx.output.commandResult(
      "find",
      { strings: strings.payload, procedures: procedures.payload },
      lines.join("\n"),
    );
    await ctx.syncLocalStatus();
  });

  registry.register("tools", async (ctx, rest) => {
    const trimmed = rest.trim();
    if (trimmed === "reload") {
      if (!ctx.rea?.refreshTools) { ctx.output.fail(ctx.output.i18n.t("commandResult.refreshUnsupported")); return; }
      await ctx.rea.refreshTools();
      ctx.output.commandResult("tools", { revision: ctx.rea.catalogRevision, total: ctx.rea.tools().length }, ctx.output.i18n.t("commandResult.toolsRefreshed", { count: ctx.rea.tools().length }));
      return;
    }
    const allTools = ctx.rea?.tools() ?? [];
    if (trimmed.toLowerCase().startsWith("schema:")) {
      const name = trimmed.slice("schema:".length).trim();
      const tool = ctx.rea?.find(name);
      if (!tool) {
        ctx.output.fail(ctx.output.i18n.t("commandResult.toolMissing", { name }));
        return;
      }
      ctx.output.commandResult(
        "tools",
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        compactJson(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          10_000,
        ),
      );
      return;
    }
    const matches = rankCatalogTools(allTools, trimmed, 30);
    const lines = [
      `${matches.length} of ${allTools.length} REA tools${trimmed ? ` matching "${trimmed}"` : ""}:`,
      ...matches.map((t) => `  ${t.name.padEnd(32)} ${t.summaryLine}`),
    ];
    ctx.output.commandResult(
      "tools",
      { total: allTools.length, matches: matches.map((t) => t.name) },
      lines.join("\n"),
    );
  });

  registry.register("call", async (ctx, rest) => {
    const trimmed = rest.trim();
    const space = trimmed.search(/\s/);
    const toolName = space === -1 ? trimmed : trimmed.slice(0, space);
    const rawJson = space === -1 ? "" : trimmed.slice(space + 1).trim();
    let parsedArgs: Record<string, unknown> = {};
    if (rawJson) {
      try {
        const candidate: unknown = JSON.parse(rawJson);
        const rec = asRecord(candidate);
        if (!rec) {
          ctx.output.fail(ctx.output.i18n.t("commandResult.callObject"));
          return;
        }
        parsedArgs = rec;
      } catch (error) {
        ctx.output.fail(ctx.output.i18n.t("commandResult.invalidJson", { detail: errorMessageOf(error) }));
        return;
      }
    }
    const res = await ctx.reaCall(toolName, parsedArgs);
    if (res.problem) {
      ctx.output.fail(res.problem);
      return;
    }
    await ctx.syncLocalStatus();
    ctx.output.commandResult(
      "call",
      res.payload,
      compactJson(normalized(res.payload) ?? res.text, 14_000),
    );
  });

  registry.register("guide", async (ctx, rest) => {
    const result = readGuide(rest.trim());
    if (!result.ok) {
      ctx.output.fail(result.text);
      return;
    }
    ctx.output.commandResult(
      "guide",
      { topic: rest.trim() || null, text: result.text },
      result.text,
    );
  });

  registry.register("prompts", async (ctx, rest) => {
    const prompts = (await ctx.rea?.prompts()) ?? [];
    const parts = splitShellTokens(rest);
    const name = parts[0]?.trim() ?? "";
    if (!name) {
      const lines = prompts.map((p) => {
        const argList = p.arguments
          .map((a) => `${a.name}${a.required ? "*" : ""}`)
          .join(", ");
        return `  ${p.name}(${argList}) — ${p.description}`;
      });
      ctx.output.commandResult(
        "prompts",
        { prompts },
        ctx.output.i18n.t("commandResult.guidedPrompts", { count: prompts.length, lines: lines.join("\n") }),
      );
      return;
    }
    const args: Record<string, string> = {};
    for (const token of parts.slice(1)) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        args[token.slice(0, eq)] = token.slice(eq + 1);
      }
    }
    try {
      const text = (await ctx.rea?.getPrompt(name, args)) ?? "";
      ctx.output.commandResult("prompts", { name, args, text }, text);
    } catch (error) {
      ctx.output.fail(errorMessageOf(error));
    }
  });

  registry.register("profile", async (ctx, rest) => {
    const arg = rest.trim().toLowerCase();
    if (!arg || arg === "list" || arg === "status") {
      const activeId = ctx.activeProfile?.id ?? null;
      const header = activeId
        ? `active analyst profile: ${activeId} (effort=${ctx.activeProfile!.effort})\n\nAvailable profiles:`
        : "no analyst profile active (use `/profile <name>` or `--profile <name>`):\n";
      ctx.output.commandResult(
        "profile",
        { active: activeId },
        `${header}\n${renderProfileList(activeId)}`,
      );
      return;
    }
    if (arg === "off" || arg === "none" || arg === "clear" || arg === "reset") {
      ctx.activateProfile(null);
      ctx.output.commandResult(
        "profile",
        { active: null },
        ctx.output.i18n.t("commandResult.profileCleared"),
      );
      return;
    }
    const found = findProfile(arg);
    if (!found) {
      ctx.output.fail(
        ctx.output.i18n.t("commandResult.unknownProfile", { name: rest.trim(), profiles: renderProfileList(ctx.activeProfile?.id ?? null) }),
      );
      return;
    }
    ctx.activateProfile(found);
    ctx.output.commandResult(
      "profile",
      {
        active: found.id,
        effort: found.effort,
        sticky_tools: found.stickyTools,
      },
      [
        `activated analyst profile → ${found.id} (effort=${found.effort})`,
        `  summary  ${found.summary}`,
        `  tools    ${found.stickyTools.join(", ")}`,
      ].join("\n"),
    );
  });

  registry.register("commands", async (ctx, rest) => {
    const specs = ctx.reloadCustomCommands();
    const sub = rest.trim().toLowerCase();
    if (specs.length === 0) {
      ctx.output.commandResult(
        "commands",
        { commands: [] },
        ctx.output.i18n.t("commandResult.noCustom"),
      );
      return;
    }
    const lines = [
      `${specs.length} custom markdown command(s)${sub === "reload" ? " (reloaded)" : ""}:`,
      ...specs.map(
        (s) =>
          `  /${s.name.padEnd(20)} [${s.scope}] ${s.description} (${s.filePath})`,
      ),
    ];
    ctx.output.commandResult(
      "commands",
      {
        commands: specs.map((s) => ({
          name: s.name,
          aliases: s.aliases,
          scope: s.scope,
          path: s.filePath,
        })),
      },
      lines.join("\n"),
    );
  });

  registry.register("jb", async (ctx, rest) => {
    const trimmedArg = rest.trim();
    const lowerArg = trimmedArg.toLowerCase();
    if (!trimmedArg || lowerArg === "show" || lowerArg === "status") {
      ctx.operatorDirective = readOperatorDirective(ctx.cwd, ctx.session.dir);
      const text = ctx.operatorDirective
        ? `active operator directive (AGENTS.md + session):\n\n${ctx.operatorDirective}`
        : "no custom operator directive set.\nUsage: /jb <directive>  (writes to AGENTS.md with .bak backup and activates immediately)\n       /jb clear        (removes custom directive)";
      ctx.output.commandResult(
        "jb",
        { directive: ctx.operatorDirective },
        text,
      );
      return;
    }
    if (lowerArg === "clear" || lowerArg === "reset" || lowerArg === "off") {
      const cleared = await writeOperatorDirective(
        ctx.cwd,
        ctx.session.dir,
        null,
      );
      ctx.operatorDirective = null;
      ctx.output.commandResult(
        "jb",
        cleared,
        ctx.output.i18n.t("commandResult.directiveCleared", { path: cleared.agentsPath, backup: cleared.backupPath ? ` (backup: ${cleared.backupPath})` : "" }),
      );
      return;
    }
    const written = await writeOperatorDirective(
      ctx.cwd,
      ctx.session.dir,
      trimmedArg,
    );
    ctx.operatorDirective = trimmedArg;
    ctx.output.commandResult(
      "jb",
      { ...written, directive: trimmedArg },
      [
        "activated operator directive in systemPrompt & AGENTS.md:",
        `  agents.md  ${written.agentsPath}${written.backupPath ? ` (backup: ${written.backupPath})` : ""}`,
        `  session    ${written.sessionDirectivePath}`,
        `  directive  ${trimmedArg}`,
      ].join("\n"),
    );
  });

  registry.register("agents.md", async (ctx, rest) => {
    const arg = rest.trim();
    const lower = arg.toLowerCase();
    const projectPath = join(ctx.cwd, "AGENTS.md");
    const sizeNote = (info: { chars: number; truncated: boolean }): string =>
      `${info.chars} chars${info.truncated ? ` (only the first ${PROJECT_INSTRUCTIONS_LIMIT} are sent; shorten the file)` : ""}`;
    const status = (): void => {
      const info = readProjectInstructions(ctx.cwd);
      const text = !ctx.agentsMdEnabled
        ? `AGENTS.md is switched off for this session${info ? ` (${projectPath}, ${sizeNote(info)})` : ""}. Use /agents.md on to enable it again.`
        : info
          ? `AGENTS.md is active: ${info.path} · ${sizeNote(info)}\nIt is re-read automatically whenever the file changes, so edits apply on your next message. /agents.md show prints it; /agents.md <path> adopts a different file as the default /jb.`
          : `no AGENTS.md in ${ctx.cwd}.\nCreate one there and omr reads it automatically, or run /agents.md <path> to adopt an existing instruction file as the default /jb.`;
      ctx.output.commandResult(
        "agents.md",
        {
          enabled: ctx.agentsMdEnabled,
          path: info?.path ?? null,
          chars: info?.chars ?? 0,
          truncated: info?.truncated ?? false,
        },
        text,
      );
    };
    if (lower === "on" || lower === "off") {
      ctx.agentsMdEnabled = lower === "on";
      status();
      return;
    }
    if (lower === "show") {
      const info = readProjectInstructions(ctx.cwd);
      if (!info) {
        status();
        return;
      }
      ctx.output.commandResult(
        "agents.md",
        { path: info.path, chars: info.chars },
        `${info.path} (${sizeNote(info)})\n\n${info.text}`,
      );
      return;
    }
    if (!arg || lower === "reload") {
      status();
      return;
    }
    const resolved = resolveTargetPath(arg, ctx.cwd);
    if (!resolved) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/agents.md [path|show|reload|on|off]" }));
      return;
    }
    if (resolved === projectPath) {
      status();
      return;
    }
    const adopted = readInstructionFile(resolved);
    if (!adopted) {
      ctx.output.fail(
        ctx.output.i18n.t("commandResult.badInstructions", { path: resolved }),
      );
      return;
    }
    const written = await writeOperatorDirective(
      ctx.cwd,
      ctx.session.dir,
      adopted.text,
    );
    ctx.operatorDirective = adopted.text;
    ctx.output.commandResult(
      "agents.md",
      {
        adopted: resolved,
        chars: adopted.chars,
        truncated: adopted.truncated,
        agents_path: written.agentsPath,
      },
      [
        `adopted ${resolved} (${sizeNote(adopted)}) as the default /jb directive:`,
        `  agents.md  ${written.agentsPath}${written.backupPath ? ` (backup: ${written.backupPath})` : ""}`,
        `  session    ${written.sessionDirectivePath}`,
      ].join("\n"),
    );
  });

  registry.register("doctor", async (ctx) => {
    const { t } = ctx.output.i18n;
    const [result, browserSnap] = await Promise.all([
      ctx.reaCall("binary_session", { detail: "complete" }),
      ctx.browserManager.status(),
    ]);
    if (result.problem) {
      ctx.output.fail(result.problem);
      return;
    }
    const installedBrowsers = browserSnap.installed
      .filter((b) => b.binary)
      .map((b) => b.id)
      .join(", ");
    const camoLabel = browserSnap.camofox.reachable
      ? t("doctor.camoOnline", { url: browserSnap.camofox.baseUrl })
      : t("doctor.camoOffline", { state: browserSnap.camofox.containerState });
    const torLabel = browserSnap.tor.available
      ? t("doctor.torOnline", { url: browserSnap.tor.proxyUrl })
      : t("doctor.torStandby");
    const modelInfo = ctx.modelController.modelInfo;
    const modelError = ctx.modelController.modelError;
    const lines = [
      `omr ${VERSION} · ${t("doctor.backend", { tools: ctx.rea?.tools().length ?? 0, browserTools: ctx.browserManager.tools().length })}`,
      renderProviders(result.payload, ctx.output.i18n),
      `${t("doctor.browser")} ${camoLabel} · ${t("doctor.local")} [${installedBrowsers || t("hud.none")}] · ${torLabel}`,
      `${t("status.environment")}  ${ctx.sources.length > 0 ? ctx.sources.join(", ") : t("doctor.shellOnly")}`,
      `${t("hud.model")}  ${ctx.opts.noModel ? t("status.noModel") : ctx.modelId}${modelInfo ? ` · ${modelInfo.config.baseUrl} · ${t("doctor.key")} ${modelInfo.keySource}` : ""}`,
      `${t("doctor.config")}  ${modelInfo?.file ?? modelConfigPath(ctx.env)}${modelError ? ` (${modelError})` : ""}`,
    ];
    ctx.output.commandResult("doctor", result.payload, lines.join("\n"));
  });

  registry.register("model", async (ctx, rest) => {
    const mc = ctx.modelController;
    if (!rest && ctx.output.ui) {
      mc.openInteractiveModelPicker(null);
      return;
    }
    if (rest) {
      if (ctx.opts.noModel) {
        ctx.output.fail(
          ctx.output.i18n.t("commandResult.modelDisabled"),
        );
        return;
      }
      try {
        const tokens = splitShellTokens(rest);
        const firstToken = (tokens[0] ?? "").toLowerCase();
        if (firstToken === "refresh" || firstToken === "fetch") {
          const refreshed = await mc.triggerProvidersRefresh(true);
          const activeProvId = mc.modelInfo?.config.providerId ?? null;
          const activeProv =
            refreshed.find((p) => p.id === activeProvId) ??
            refreshed.find((p) => p.connected);
          if (ctx.output.ui) {
            mc.openInteractiveModelPicker(activeProv?.id ?? null);
            if (activeProv) {
              ctx.output.ui.updateModelPicker({
                notice: ctx.output.i18n.t("commandResult.modelFetched", { count: activeProv.models.length, provider: activeProv.name, url: activeProv.baseUrl }),
              });
            }
            return;
          }
          const lines: string[] = [];
          for (const p of refreshed.filter((prov) => prov.connected)) {
            lines.push(
              `${p.name} (${p.id} · ${p.baseUrl}) — ${p.models.length} models${p.error ? ` [error: ${p.error}]` : ""}:`,
            );
            for (const m of p.models.slice(0, 60)) {
              lines.push(
                `  • ${m.id}${m.note ? `  (${m.note})` : ""}`,
              );
            }
            if (p.models.length > 60) {
              lines.push(`  … +${p.models.length - 60} more models`);
            }
          }
          ctx.output.commandResult(
            "model",
            {
              refreshed: true,
              provider: activeProv?.id ?? null,
              models_count: activeProv?.models.length ?? 0,
              models: activeProv?.models ?? [],
            },
            lines.join("\n") || "no connected providers found to refresh",
          );
          return;
        }

        if (firstToken === "list" || firstToken === "ls") {
          const query = tokens.slice(1).join(" ").trim().toLowerCase();
          const refreshed = await mc.triggerProvidersRefresh(false);
          const connected = refreshed.filter((p) => p.connected);
          const lines: string[] = [];
          const allMatched: Array<{
            provider: string;
            id: string;
            note?: string;
          }> = [];
          for (const p of connected) {
            const matched = query
              ? p.models.filter(
                  (m) =>
                    m.id.toLowerCase().includes(query) ||
                    m.label.toLowerCase().includes(query) ||
                    (m.note ?? "").toLowerCase().includes(query),
                )
              : p.models;
            if (matched.length === 0) continue;
            lines.push(
              `${p.name} (${p.id} · ${p.baseUrl}) — ${matched.length}/${p.models.length} models:`,
            );
            for (const m of matched.slice(0, 100)) {
              const activeMark =
                p.id === mc.modelInfo?.config.providerId &&
                m.id === ctx.modelId
                  ? "▸"
                  : "•";
              lines.push(
                `  ${activeMark} ${p.id}:${m.id}${m.note ? `  [${m.note}]` : ""}`,
              );
              allMatched.push({
                provider: p.id,
                id: m.id,
                ...(m.note ? { note: m.note } : {}),
              });
            }
            if (matched.length > 100) {
              lines.push(
                `  … +${matched.length - 100} more (filter with /model list <search>)`,
              );
            }
          }
          ctx.output.commandResult(
            "model",
            { models: allMatched, count: allMatched.length },
            lines.join("\n") ||
              (query
                ? `no models matching "${query}" across connected providers`
                : "no models found on connected providers"),
          );
          return;
        }

        if (firstToken === "endpoint" || firstToken === "url") {
          const urlArg = tokens[1] ?? "";
          const keyArg = tokens[2] ?? null;
          const modelArg = tokens[3] ?? null;
          if (!urlArg) {
            ctx.output.fail(
              "usage: /model endpoint <base_url> [api_key_or_env] [default_model]",
            );
            return;
          }
          const configured = await mc.configureCustomEndpoint(
            urlArg,
            keyArg,
            modelArg,
          );
          if (ctx.output.ui && !modelArg) {
            mc.openInteractiveModelPicker("custom");
            ctx.output.ui.updateModelPicker({
              notice: `Connected ${configured.provider.baseUrl} · fetched ${configured.provider.models.length} models`,
            });
            return;
          }
          ctx.output.commandResult(
            "model",
            {
              provider: configured.provider.id,
              base_url: configured.provider.baseUrl,
              model: configured.selectedModel,
              models_fetched: configured.provider.models.length,
              saved_path: configured.savedPath,
            },
            ctx.output.i18n.t("commandResult.customEndpoint", { url: configured.provider.baseUrl, count: configured.provider.models.length, model: configured.selectedModel, path: configured.savedPath }),
          );
          return;
        }

        let saveFlag = false;
        const filtered: string[] = [];
        for (const tok of tokens) {
          if (tok === "--save" || tok === "-s") saveFlag = true;
          else filtered.push(tok);
        }
        const spec = filtered.join(" ").trim();
        if (!spec) {
          if (ctx.output.ui) mc.openInteractiveModelPicker(null);
          else ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/model [--save] [provider:]<model>" }));
          return;
        }
        const parsed = splitProviderModelSpec(spec, mc.providers);
        const { savedPath } = await mc.applyModelSelection(
          parsed.providerId,
          parsed.modelId,
          saveFlag,
        );
        const provTag = mc.modelInfo?.config.providerId
          ? `${mc.modelInfo.config.providerId}:`
          : "";
        const savedSuffix = savedPath ? ` (saved default → ${savedPath})` : "";
        ctx.output.commandResult(
          "model",
          {
            provider: mc.modelInfo?.config.providerId ?? null,
            protocol: mc.modelInfo?.config.protocol ?? "openai-chat",
            model: ctx.modelId,
            base_url: mc.modelInfo?.config.baseUrl ?? null,
            saved_path: savedPath,
          },
          ctx.output.i18n.t("commandResult.modelSwitched", { provider: provTag, model: ctx.modelId, saved: savedSuffix }),
        );
      } catch (error) {
        ctx.output.fail(errorMessageOf(error));
      }
      return;
    }
    const connectedCount = mc.providers.filter((p) => p.connected).length;
    const currentEffort = mc.modelInfo?.config.reasoningEffort ?? "auto";
    const lines = [
      `provider ${mc.modelInfo?.config.providerName ?? "(unconfigured)"}${mc.modelInfo?.config.providerId ? ` (${mc.modelInfo.config.providerId} · ${mc.modelInfo.config.protocol ?? "openai-chat"})` : ""}`,
      `model    ${ctx.modelId}`,
      `thinking ${currentEffort} (use /effort or Alt+E)`,
      `speed    ${ctx.lastTps !== null ? `${ctx.lastTps} tok/s${ctx.lastTtftMs !== null ? ` (${ctx.lastTtftMs}ms TTFT)` : ""}` : "-- tok/s (measured on next turn)"}`,
      `base     ${mc.modelInfo?.config.baseUrl ?? "(unconfigured)"}`,
      `key      ${mc.modelInfo?.keySource ?? "missing"}`,
      `config   ${mc.modelInfo?.file ?? modelConfigPath(ctx.env)}`,
      `catalog  ${connectedCount} connected / ${mc.providers.length} supported providers (use /model refresh or /providers)`,
      `steps    ${mc.modelInfo?.config.maxSteps ? mc.modelInfo.config.maxSteps : "unlimited"} · max_tokens ${mc.modelInfo?.config.maxTokens ?? "-"}`,
      `tokens   ${ctx.runtime.usage.snapshot().totalTokens} session total`,
    ];
    if (mc.modelError) lines.push(`problem  ${mc.modelError}`);
    ctx.output.commandResult(
      "model",
      {
        provider: mc.modelInfo?.config.providerId ?? null,
        protocol: mc.modelInfo?.config.protocol ?? null,
        model: ctx.modelId,
        reasoning_effort: currentEffort,
        tps: ctx.lastTps,
        ttft_ms: ctx.lastTtftMs,
        base_url: mc.modelInfo?.config.baseUrl ?? null,
        connected_providers: connectedCount,
        total_providers: mc.providers.length,
      },
      lines.join("\n"),
    );
  });

  registry.register("effort", async (ctx, rest) => {
    const { t } = ctx.output.i18n;
    const mc = ctx.modelController;
    if (!rest && ctx.output.ui) {
      mc.openInteractiveEffortPicker();
      return;
    }
    if (!rest) {
      const current = mc.modelInfo?.config.reasoningEffort ?? "auto";
      const lines: string[] = [
        `${t("hud.thinking")}  ${t("commandResult.effortModel", { effort: current, model: ctx.modelId })}`,
        `${t("commandResult.modelLevels")}  auto · off · minimal · low · medium · high · xhigh`,
      ];
      for (const lvl of REASONING_EFFORT_LEVELS) {
        const marker = lvl.id === current ? "▸" : " ";
        const budget = lvl.anthropicBudget
          ? ` (${lvl.anthropicBudget} tok)`
          : "";
        lines.push(
          `  ${marker} ${lvl.id.padEnd(8)} ${t(`effort.${lvl.id}`)}${budget}`,
        );
      }
      ctx.output.commandResult(
        "effort",
        {
          effort: current,
          model: ctx.modelId,
          levels: REASONING_EFFORT_LEVELS,
        },
        lines.join("\n"),
      );
      return;
    }
    try {
      const tokens = splitShellTokens(rest);
      let saveFlag = false;
      const filtered: string[] = [];
      for (const tok of tokens) {
        if (tok === "--save" || tok === "-s") saveFlag = true;
        else filtered.push(tok);
      }
      const rawLevel = filtered.join(" ").trim();
      if (!rawLevel) {
        if (ctx.output.ui) mc.openInteractiveEffortPicker();
        else {
          ctx.output.fail(
            "usage: /effort [--save] [auto|off|minimal|low|medium|high|xhigh]",
          );
        }
        return;
      }
      const parsedEffort = parseReasoningEffort(rawLevel);
      if (!parsedEffort) {
        ctx.output.fail(
          "usage: /effort [--save] [auto|off|minimal|low|medium|high|xhigh]",
        );
        return;
      }
      const { savedPath } = mc.applyEffortSelection(parsedEffort, saveFlag);
      if (!savedPath) mc.rememberEffort(parsedEffort);
      const savedSuffix = savedPath ? ` (saved default → ${savedPath})` : "";
      ctx.output.commandResult(
        "effort",
        {
          effort: parsedEffort,
          model: ctx.modelId,
          saved_path: savedPath,
        },
        ctx.output.i18n.t("commandResult.effort", { level: parsedEffort, saved: savedSuffix }),
      );
    } catch (error) {
      ctx.output.fail(errorMessageOf(error));
    }
  });

  registry.register("providers", async (ctx, rest) => {
    const mc = ctx.modelController;
    if (ctx.output.ui) {
      mc.openInteractiveModelPicker(rest ? rest.trim().toLowerCase() : null);
      return;
    }
    const refreshed = await mc.triggerProvidersRefresh(false);
    const q = rest.trim().toLowerCase();
    const filtered = q
      ? refreshed.filter(
          (p) => p.id.includes(q) || p.name.toLowerCase().includes(q),
        )
      : refreshed;
    const payload = {
      connected_count: refreshed.filter((p) => p.connected).length,
      total_count: refreshed.length,
      active_provider: mc.modelInfo?.config.providerId ?? null,
      active_model: mc.modelInfo?.config.model ?? null,
      providers: filtered.map((p) => ({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        base_url: p.baseUrl,
        connected: p.connected,
        local: p.local,
        key_source: p.keySource,
        env_hint: p.envHint,
        live_loaded: p.liveLoaded,
        model_count: p.models.length,
        models: p.models.slice(0, 12).map((m) => m.id),
      })),
    };
    const lines: string[] = [
      `providers  ${payload.connected_count} connected · ${refreshed.filter((p) => p.local).length} local · ${refreshed.length} total`,
    ];
    for (const p of filtered) {
      const icon = p.connected ? "●" : p.local ? "◌" : "○";
      const status = p.connected
        ? p.keySource
        : p.local
          ? "local (no key)"
          : `export ${p.envHint}`;
      const preview = p.models
        .slice(0, 3)
        .map((m) => m.id)
        .join(", ");
      lines.push(
        `  ${icon} ${p.id.padEnd(13)} ${p.name.padEnd(22)} ${String(p.models.length).padStart(3)} models · ${status}${preview ? ` · [${preview}]` : ""}`,
      );
    }
    ctx.output.commandResult("providers", payload, lines.join("\n"));
  });

  registry.register("failover", async (ctx, rest) => {
    const mc = ctx.modelController;
    const primaryLabel = mc.modelInfo
      ? `${mc.modelInfo.config.providerId ? `${mc.modelInfo.config.providerId}:` : ""}${mc.modelInfo.config.model}`
      : ctx.modelId;

    if (!rest.trim()) {
      const chain = mc.modelInfo?.config.fallbackModels ?? [];
      const lines = [
        `primary   ${primaryLabel}${mc.modelInfo ? ` (${mc.modelInfo.config.baseUrl})` : ""}`,
        `failover  ${chain.length > 0 ? chain.join(" → ") : "(disabled — set via `/failover provider:model,...` or OMR_FALLBACK_MODELS)"}`,
      ];
      ctx.output.commandResult(
        "failover",
        {
          primary: primaryLabel,
          fallback_models: chain,
        },
        lines.join("\n"),
      );
      return;
    }

    const tokens = splitShellTokens(rest);
    let saveFlag = false;
    const rawSpecs: string[] = [];
    for (const tok of tokens) {
      if (tok === "--save" || tok === "-s") saveFlag = true;
      else rawSpecs.push(tok);
    }
    const joined = rawSpecs.join(" ").trim();
    const specs = parseFallbackModelsSpec(joined);
    try {
      for (const spec of specs) {
        mc.resolveSpecInfo(spec);
      }
      const { savedPath } = await mc.applyFallbackModels(specs, saveFlag);
      const savedNote = savedPath ? ` (saved → ${savedPath})` : "";
      ctx.output.commandResult(
        "failover",
        {
          primary: primaryLabel,
          fallback_models: specs,
          saved_path: savedPath,
        },
        specs.length > 0
          ? ctx.output.i18n.t("commandResult.failover", { primary: primaryLabel, fallbacks: specs.join(" → "), saved: savedNote })
          : ctx.output.i18n.t("commandResult.failoverCleared", { saved: savedNote }),
      );
    } catch (error) {
      ctx.output.fail(errorMessageOf(error));
    }
  });

  registry.register("budget", async (ctx, rest) => {
    await ctx.runtime.usage.initialize();
    if (rest.trim().toLowerCase() === "reset" || rest.trim().toLowerCase().startsWith("reset ")) {
      await ctx.runtime.usage.reset(rest.trim().slice(5).trim() || "Operator explicitly requested /budget reset");
      ctx.output.commandResult("budget", {...ctx.runtime.usage.snapshot()}, ctx.output.i18n.t("commandResult.usageReset"));
      return;
    }
    const mc = ctx.modelController;
    const usage = ctx.runtime.usage.snapshot();
    const totalTokens = usage.totalTokens;
    const costUsd = estimateSessionCostUsd(ctx.modelId, totalTokens);
    const activeBudget = usage.budgetTokens;

    if (!rest.trim()) {
      const pct =
        activeBudget && activeBudget > 0
          ? ` (${Math.min(999, Math.round((totalTokens / activeBudget) * 100))}%)`
          : "";
      const lines = [
        `session tokens  ${totalTokens.toLocaleString()} (${formatTokenCountShort(totalTokens)})${pct}`,
        `budget cap      ${activeBudget ? `${activeBudget.toLocaleString()} (${formatTokenCountShort(activeBudget)})` : "unlimited (use `/budget 500k` or OMR_BUDGET_TOKENS)"}`,
        `reserved        ${usage.reservedTokens.toLocaleString()} · estimated ${usage.estimatedTokens.toLocaleString()}${usage.priorUsageUnknown ? " · prior session usage unavailable (use /budget reset for a new baseline)" : ""}`,
        `est. cost       $${costUsd.toFixed(4)} USD (${ctx.modelId})`,
      ];
      ctx.output.commandResult(
        "budget",
        {
          total_tokens: totalTokens,
          budget_tokens: activeBudget,
          estimated_usd: costUsd,
          reserved_tokens: usage.reservedTokens,
          estimated_tokens: usage.estimatedTokens,
          prior_usage_unknown: usage.priorUsageUnknown,
        },
        lines.join("\n"),
      );
      return;
    }

    const tokens = splitShellTokens(rest);
    let saveFlag = false;
    const restTokens: string[] = [];
    for (const tok of tokens) {
      if (tok === "--save" || tok === "-s") saveFlag = true;
      else restTokens.push(tok);
    }
    const rawSpec = restTokens.join(" ").trim();
    const lower = rawSpec.toLowerCase();
    const isClear =
      lower === "off" ||
      lower === "none" ||
      lower === "clear" ||
      lower === "unlimited" ||
      lower === "0";
    const parsed = isClear ? null : parseTokenBudgetSpec(rawSpec);
    if (!isClear && parsed === null) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/budget [<tokens>|500k|1m|off] [--save]" }));
      return;
    }
    await ctx.runtime.usage.setBudget(parsed);
    if (mc.modelInfo) {
      const { budgetTokens: _prev, ...restCfg } = mc.modelInfo.config;
      mc.modelInfo = {
        ...mc.modelInfo,
        config: {
          ...restCfg,
          ...(parsed !== null ? { budgetTokens: parsed } : {}),
        },
      };
    }
    if (parsed !== null) {
      ctx.env["OMR_BUDGET_TOKENS"] = String(parsed);
    } else {
      delete ctx.env["OMR_BUDGET_TOKENS"];
    }
    let savedPath: string | null = null;
    if (saveFlag) {
      try {
        savedPath = saveModelRuntimeSettings(
          { budgetTokens: parsed },
          ctx.env,
        ).path;
      } catch (error) {
        ctx.output.fail(errorMessageOf(error));
        return;
      }
    }
    const savedNote = savedPath ? ` (saved → ${savedPath})` : "";
    ctx.output.commandResult(
      "budget",
      {
        budget_tokens: parsed,
        total_tokens: totalTokens,
        estimated_usd: costUsd,
        saved_path: savedPath,
      },
      parsed
        ? ctx.output.i18n.t("commandResult.budgetCap", { count: parsed.toLocaleString(), short: formatTokenCountShort(parsed), saved: savedNote })
        : ctx.output.i18n.t("commandResult.budgetUnlimited", { saved: savedNote }),
    );
  });

  registry.register("net", async (ctx, rest) => {
    const mc = ctx.modelController;
    const parts = splitShellTokens(rest);
    const sub = (parts[0] ?? "status").toLowerCase();
    const cfg = mc.modelInfo?.config;
    const baseUrl = cfg?.baseUrl ?? "https://api.openai.com/v1";
    const proxyInfo = resolveProxyForEndpoint(baseUrl, ctx.env);
    const proxyUrl = proxyInfo?.proxyUrl ?? null;

    if (sub === "interval" || sub === "wait") {
      let saveFlag = false;
      let valStr = "";
      for (const tok of parts.slice(1)) {
        if (tok === "--save" || tok === "-s") saveFlag = true;
        else if (!valStr) valStr = tok;
      }
      const ms = Number.parseInt(valStr, 10);
      if (!Number.isFinite(ms) || ms < 250) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: `/net ${sub} <ms> [--save] (minimum 250ms)` }));
        return;
      }
      if (mc.modelInfo) {
        mc.modelInfo = {
          ...mc.modelInfo,
          config: {
            ...mc.modelInfo.config,
            ...(sub === "interval"
              ? { pingIntervalMs: ms }
              : { maxNetworkWaitMs: ms }),
          },
        };
      }
      let savedPath: string | null = null;
      if (saveFlag) {
        savedPath = saveModelRuntimeSettings(
          sub === "interval"
            ? { pingIntervalMs: ms }
            : { maxNetworkWaitMs: ms },
          ctx.env,
        ).path;
      }
      ctx.output.commandResult(
        "net",
        {
          setting: sub,
          value_ms: ms,
          saved_path: savedPath,
        },
        ctx.output.i18n.t("commandResult.netConfig", { setting: sub === "interval" ? "pingIntervalMs" : "maxNetworkWaitMs", ms, saved: savedPath ? ` (saved → ${savedPath})` : "" }),
      );
      return;
    }

    const fallbackList = mc.modelInfo?.config.fallbackModels ?? [];

    if (sub === "probe" || sub === "ping" || sub === "check") {
      const endpoints: Array<{ label: string; url: string }> = [
        {
          label: `primary (${ctx.modelId})`,
          url: baseUrl,
        },
      ];
      for (const fb of fallbackList) {
        try {
          const info = mc.resolveSpecInfo(fb);
          endpoints.push({
            label: `fallback (${fb})`,
            url: info.config.baseUrl,
          });
        } catch {
          // ignore unresolvable fallback during probe
        }
      }
      const results = await Promise.all(
        endpoints.map(async (ep) => {
          const res = await probeEndpointConnectivity(
            ep.url,
            3_500,
            3_500,
            ctx.env,
          );
          return { ...ep, ...res };
        }),
      );
      const lines = [
        "net-guard live endpoint probe:",
        ...results.map((r) => {
          const icon = r.ok ? "✓" : "✗";
          const via = r.viaProxy ? ` via proxy ${r.viaProxy}` : "";
          const status = r.ok
            ? `reachable (${r.latencyMs}ms${via})`
            : `offline (${r.reason ?? "unreachable"} · ${r.latencyMs}ms${via})`;
          return `  ${icon} ${r.label.padEnd(28)} ${r.url} → ${status}`;
        }),
      ];
      ctx.output.commandResult("net", { probes: results }, lines.join("\n"));
      return;
    }

    const lines = [
      `endpoint      ${baseUrl}`,
      `proxy         ${proxyUrl ?? "direct (honors HTTPS_PROXY / HTTP_PROXY / ALL_PROXY & NO_PROXY)"}`,
      `ping interval ${cfg?.pingIntervalMs ?? 1_500}ms (adjust with \`/net interval <ms>\`)`,
      `max wait      ${cfg?.maxNetworkWaitMs ? `${Math.round(cfg.maxNetworkWaitMs / 1000)}s` : "900s (hold turn until connectivity returns)"}`,
      `failover      ${fallbackList.length > 0 ? fallbackList.join(" → ") : "none (configure with `/failover provider:model,...`)"}`,
    ];
    ctx.output.commandResult(
      "net",
      {
        endpoint: baseUrl,
        proxy: proxyUrl,
        ping_interval_ms: cfg?.pingIntervalMs ?? 1_500,
        max_network_wait_ms: cfg?.maxNetworkWaitMs ?? 0,
        fallback_models: fallbackList,
      },
      lines.join("\n"),
    );
  });

  registry.register("binary", async (ctx, rest) => {
    const arg = rest.toLowerCase();
    if (
      arg &&
      arg !== "on" &&
      arg !== "eco" &&
      arg !== "always" &&
      arg !== "busy" &&
      arg !== "off"
    ) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/binary [on|eco|busy|off]" }));
      return;
    }
    const normalizedArg = arg === "always" ? "on" : arg;
    const mode: BinaryFlowMode = ctx.output.ui
      ? normalizedArg
        ? ctx.output.ui.setBinaryMode(normalizedArg as BinaryFlowMode)
        : ctx.output.ui.setBinaryMode()
      : ((normalizedArg || "off") as BinaryFlowMode);
    ctx.output.commandResult(
      "binary",
      { mode },
      ctx.output.i18n.t("commandResult.binaryMode", { mode }),
    );
  });

  registry.register("image", async (ctx, rest) => {
    const trimmed = rest.trim();
    const tokens = splitShellTokens(trimmed);
    const first = (tokens[0] ?? "").toLowerCase();

    if (first === "list" || first === "status" || (!trimmed && ctx.listStagedImages().length > 0)) {
      const staged = ctx.listStagedImages();
      if (staged.length === 0) {
        ctx.output.commandResult(
          "image",
          { staged: [] },
          [
            "no staged images in chat queue.",
            " Ways to attach visual evidence:",
            "  • Ctrl+V                     Paste image (or file path) directly from clipboard",
            "  • /image [path|url|clipboard] [prompt]  Stage image or immediately ask a vision question",
            "  • @<image.png>               Mention any workspace image inline in your prompt",
            "  • /screenshot [binary|desktop|region|window|adb|browser] (or Alt+S)",
          ].join("\n"),
        );
        return;
      }
      const lines = [`${staged.length} staged image attachment(s):`];
      for (let i = 0; i < staged.length; i += 1) {
        const img = staged[i]!;
        const bytes = Buffer.from(img.data, "base64");
        const forensics = inspectImageForensics(
          bytes,
          img.mimeType,
          img.filePath,
        );
        lines.push(
          `  #${i + 1} 📎 ${img.label} · ${img.filePath ?? "(memory)"} · sha256:${forensics.sha256.slice(0, 16)}…`,
        );
        if (!ctx.opts.json) {
          const previewLines = renderAnsiImagePreview(bytes, {
            maxCols: 36,
            maxRows: 6,
            filePath: img.filePath,
            label: img.label,
          });
          lines.push(...previewLines.map((l) => `     ${l}`));
        }
      }
      ctx.output.commandResult(
        "image",
        {
          staged: staged.map((img, idx) => ({
            index: idx + 1,
            label: img.label,
            mime_type: img.mimeType,
            byte_length: img.byteLength,
            width: img.width,
            height: img.height,
            file_path: img.filePath,
          })),
        },
        lines.join("\n"),
      );
      return;
    }

    if (
      first === "clear" ||
      first === "rm" ||
      first === "remove" ||
      first === "reset"
    ) {
      const idxArg = tokens[1] ? Number.parseInt(tokens[1], 10) : undefined;
      const removed = ctx.clearStagedImages(
        idxArg && Number.isFinite(idxArg) ? idxArg : undefined,
      );
      ctx.output.commandResult(
        "image",
        { cleared: removed },
        ctx.output.i18n.t("commandResult.imagesCleared", { count: removed }),
      );
      return;
    }

    const spec = tokens[0] ?? "clipboard";
    const inlinePrompt = tokens.slice(1).join(" ").trim();
    let loaded;
    try {
      loaded = await loadImageSource(spec, {
        cwd: ctx.cwd,
        sessionDir: ctx.session.dir,
      });
    } catch (error) {
      if (!trimmed) {
        ctx.output.commandResult(
          "image",
          { staged: [] },
          [
            "no staged images in chat queue (and no image found in system clipboard).",
            " Ways to attach visual evidence:",
            "  • Ctrl+V                     Paste image (or file path) directly from clipboard",
            "  • /image [path|url|clipboard] [prompt]  Stage image or immediately ask a vision question",
            "  • @<image.png>               Mention any workspace image inline in your prompt",
            "  • /screenshot [binary|desktop|region|window|adb|browser] (or Alt+S)",
          ].join("\n"),
        );
        return;
      }
      ctx.output.fail(errorMessageOf(error));
      return;
    }

    const attachment = await buildClipboardImageAttachment(
      ctx.listStagedImages().length + 1,
      loaded,
      ctx.session.dir,
    );
    ctx.stageImage(attachment);
    const forensics = inspectImageForensics(
      loaded.bytes,
      attachment.mimeType,
      attachment.filePath,
    );

    if (inlinePrompt) {
      ctx.output.ui?.addUser(`/image ${spec} ${inlinePrompt}`);
      await ctx.runTurn(inlinePrompt, `image:${attachment.label}`);
      return;
    }

    const lines = [
      `attached image → 📎 ${attachment.label}`,
      `  path    ${attachment.filePath ?? spec}`,
      `  sha256  ${forensics.sha256}`,
    ];
    if (forensics.textChunks.length > 0) {
      lines.push(
        `  meta    ${forensics.textChunks.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(", ")}`,
      );
    }
    if (!ctx.opts.json) {
      const previewLines = renderAnsiImagePreview(loaded.bytes, {
        maxCols: 44,
        maxRows: 8,
        filePath: attachment.filePath,
        label: attachment.label,
      });
      lines.push("  preview:");
      lines.push(...previewLines.map((l) => `    ${l}`));
    }
    lines.push(
      "  tip     type your question and press Enter to send with this image (or `/image clear` to remove).",
    );
    ctx.output.commandResult(
      "image",
      {
        label: attachment.label,
        mime_type: attachment.mimeType,
        byte_length: attachment.byteLength,
        width: attachment.width,
        height: attachment.height,
        file_path: attachment.filePath,
        sha256: forensics.sha256,
      },
      lines.join("\n"),
    );
  });

  registry.register("screenshot", async (ctx, rest) => {
    const trimmed = rest.trim();
    const tokens = splitShellTokens(trimmed);
    const validModes: readonly ScreenshotMode[] = [
      "desktop",
      "region",
      "window",
      "adb",
      "browser",
      "binary",
    ];
    let mode: ScreenshotMode;
    let cursor = 0;
    const firstLower = (tokens[0] ?? "").toLowerCase();
    if (validModes.includes(firstLower as ScreenshotMode)) {
      mode = firstLower as ScreenshotMode;
      cursor = 1;
    } else if (tokens[0] && /^https?:\/\//i.test(tokens[0])) {
      mode = "browser";
    } else if (
      tokens[0] &&
      resolveTargetPath(tokens[0], ctx.cwd) &&
      !isImageFilePath(tokens[0])
    ) {
      mode = "binary";
    } else {
      mode = ctx.currentTarget ? "binary" : "desktop";
    }

    let targetPath: string | null = ctx.currentTarget;
    let url: string | null = null;
    if (mode === "binary" && tokens[cursor]) {
      const candidate = resolveTargetPath(tokens[cursor]!, ctx.cwd);
      if (candidate) {
        targetPath = candidate;
        cursor += 1;
      }
    } else if (
      mode === "browser" &&
      tokens[cursor] &&
      /^https?:\/\//i.test(tokens[cursor]!)
    ) {
      url = tokens[cursor]!;
      cursor += 1;
    }
    const inlinePrompt = tokens.slice(cursor).join(" ").trim();

    ctx.output.ui?.setBusy(ctx.output.i18n.t("commandResult.screenshot", { mode }));
    let shot;
    try {
      shot = await captureScreenshot({
        mode,
        outputDir: join(ctx.session.dir, "attachments"),
        cwd: ctx.cwd,
        targetPath,
        url,
      });
    } catch (error) {
      ctx.output.fail(errorMessageOf(error));
      return;
    } finally {
      ctx.output.ui?.setBusy(null);
    }

    const attachment = await buildClipboardImageAttachment(
      ctx.listStagedImages().length + 1,
      {
        mimeType: shot.mimeType,
        bytes: shot.bytes,
        sourcePath: shot.path,
      },
      ctx.session.dir,
    );
    ctx.stageImage(attachment);
    if (inlinePrompt) {
      ctx.output.ui?.addUser(`/screenshot ${mode} ${inlinePrompt}`);
      await ctx.runTurn(inlinePrompt, `screenshot:${mode}`);
      return;
    }

    const lines = [
      `captured ${shot.mode} → 📎 ${attachment.label}`,
      `  summary  ${shot.summary}`,
      `  saved    ${shot.path}`,
    ];
    if (!ctx.opts.json) {
      const previewLines = renderAnsiImagePreview(shot.bytes, {
        maxCols: 48,
        maxRows: 8,
        filePath: shot.path,
        label: attachment.label,
      });
      lines.push("  preview:");
      lines.push(...previewLines.map((l) => `    ${l}`));
    }
    lines.push(
      "  tip      staged into chat! Type your prompt and press Enter to analyze with your vision model.",
    );
    ctx.output.commandResult(
      "screenshot",
      {
        mode: shot.mode,
        summary: shot.summary,
        label: attachment.label,
        file_path: shot.path,
        width: shot.width,
        height: shot.height,
        byte_length: shot.bytes.length,
      },
      lines.join("\n"),
    );
  });

  registry.register("help", async (ctx) => {
    ctx.output.commandResult(
      "help",
      { commands: ctx.allCommands() },
      helpText(ctx.customCommands, ctx.output.i18n),
    );
  });
};
