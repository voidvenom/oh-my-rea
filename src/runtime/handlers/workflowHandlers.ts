import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderBrowserStatus, type BrowserEngineId } from "../../browser.js";
import {
  FORGE_COMMAND_PRESETS,
  installForgePreset,
  saveCustomCommandFile,
} from "../../customCommands.js";
import {
  OMR_WORKFLOWS,
  adbPrompt,
  browserPrompt,
  comparePrompt,
  diffCvePrompt,
  findOmrWorkflow,
  forgePrompt,
  investigatePrompt,
  scriptPrompt,
} from "../../prompts.js";
import { compactJson, normalized } from "../../render.js";
import {
  formatSubagentResult,
  renderSubagentGraph,
  renderSubagentInspector,
} from "../../subagent.js";
import { resolveTargetPath } from "../../target.js";
import { asRecord, asString } from "../../values.js";
import type { CommandRegistry } from "../commandRegistry.js";
import type { OmrContext } from "../context.js";
import { errorMessageOf, splitShellTokens } from "../utils.js";

export const registerWorkflowHandlers = (registry: CommandRegistry): void => {
  // Default handler for all standard workflows in OMR_WORKFLOWS
  for (const wf of OMR_WORKFLOWS) {
    registry.register(wf.id, async (ctx, rest, rawLine) => {
      const focus =
        wf.id === "investigate"
          ? rest ||
            ctx.opts.goal ||
            "explain this target's purpose, architecture, and key components"
          : rest;
      ctx.output.ui?.addUser(rawLine);
      await ctx.runTurn(
        wf.buildPrompt({ target: ctx.currentTarget, focus }),
        `${wf.id}${focus ? `: ${focus}` : ""}`,
        wf.autoSavePrefix
          ? { autoSaveScriptPrefix: wf.autoSavePrefix }
          : undefined,
      );
    });
  }

  // Override: /investigate
  registry.register("investigate", async (ctx, rest, rawLine) => {
    const goal =
      rest ||
      ctx.opts.goal ||
      "explain this target's purpose, architecture, and key components";
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(
      investigatePrompt(ctx.currentTarget, goal),
      `investigate: ${goal}`,
    );
  });

  // Override: /compare <left> <right>
  registry.register("compare", async (ctx, rest, rawLine) => {
    const parts = splitShellTokens(rest);
    if (parts.length < 2) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/compare <left_path> <right_path>" }));
      return;
    }
    const leftPath = resolveTargetPath(parts[0]!, ctx.cwd);
    const rightPath = resolveTargetPath(parts[1]!, ctx.cwd);
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(
      comparePrompt(leftPath, rightPath),
      `compare: ${parts[0]} vs ${parts[1]}`,
    );
  });

  // Override: /diff-cve <left> <right> [focus]
  registry.register("diff-cve", async (ctx, rest, rawLine) => {
    const parts = splitShellTokens(rest);
    if (parts.length < 2) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/diff-cve <left_path> <right_path> [focus]" }));
      return;
    }
    const leftPath = resolveTargetPath(parts[0]!, ctx.cwd);
    const rightPath = resolveTargetPath(parts[1]!, ctx.cwd);
    const focus = parts.slice(2).join(" ").trim();
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(
      diffCvePrompt(leftPath, rightPath, focus),
      `diff-cve: ${parts[0]} vs ${parts[1]}${focus ? ` (${focus})` : ""}`,
    );
  });

  // Override: /script <frida|python|gdb|rizin|yara> <goal>
  registry.register("script", async (ctx, rest, rawLine) => {
    const parts = splitShellTokens(rest);
    const knownKinds = new Set([
      "frida",
      "python",
      "py",
      "gdb",
      "rizin",
      "rz",
      "yara",
      "yar",
    ]);
    let scriptKind = "python";
    let goal = rest;
    if (parts.length >= 2 && knownKinds.has(parts[0]!.toLowerCase())) {
      const head = parts[0]!.toLowerCase();
      scriptKind =
        head === "py"
          ? "python"
          : head === "rz"
            ? "rizin"
            : head === "yar"
              ? "yara"
              : head;
      goal = parts.slice(1).join(" ");
    } else if (parts.length === 1 && knownKinds.has(parts[0]!.toLowerCase())) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/script <frida|python|gdb|rizin|yara> <goal>" }));
      return;
    }
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(
      scriptPrompt(ctx.currentTarget, scriptKind, goal),
      `script (${scriptKind}): ${goal}`,
      { autoSaveScriptPrefix: `${scriptKind}-script` },
    );
  });

  // Override: /forge [list|install <preset|all> [--user]|command <name> <goal>|<goal>]
  registry.register("forge", async (ctx, rest, rawLine) => {
    const parts = splitShellTokens(rest);
    const sub = (parts[0] ?? "list").toLowerCase();

    if (["registry", "register", "verify", "activate", "deactivate", "remove", "run"].includes(sub)) {
      if (ctx.activeAbort) { ctx.output.fail(ctx.output.i18n.t("workflow.forgeBusy")); return; }
      const abort = new AbortController(); ctx.activeAbort = abort;
      try {
        await ctx.runtime.forge.initialize();
        let args: Record<string, unknown>;
        if (sub === "register") {
          if (parts.length !== 3) throw new Error(ctx.output.i18n.t("common.usage", { command: "/forge register <spec-json-path> <source-path>" }));
          args = { action: "register", spec: JSON.parse(await readFile(resolve(ctx.cwd, parts[1]!), "utf8")), code: await readFile(resolve(ctx.cwd, parts[2]!), "utf8") };
        } else if (sub === "run") {
          const match = /^run\s+(\S+)\s+([\s\S]+)$/.exec(rest);
          if (!match) throw new Error(ctx.output.i18n.t("common.usage", { command: "/forge run <id> <input-json>" }));
          const name = ctx.runtime.forge.activeName(match[1]!);
          const tool = ctx.runtime.forge.tools().find(candidate => candidate.definition.function.name === name);
          if (!tool) throw new Error(ctx.output.i18n.t("workflow.noForgeVersion", { id: match[1] }));
          const input: unknown = JSON.parse(match[2]!); const parsed = asRecord(input);
          if (!parsed || Array.isArray(parsed)) throw new Error(ctx.output.i18n.t("workflow.forgeInput"));
          const result = await ctx.runtime.events.invoke({ backend: tool.backend, tool: tool.definition.function.name, args: parsed, readOnly: false, binding: ctx.runtime.binding }, () => tool.invoke(parsed, abort.signal), abort.signal);
          if (result.isError) ctx.output.fail(result.text); else ctx.output.commandResult("forge", result.structuredContent, result.text);
          return;
        } else {
          if ((sub === "verify" || sub === "activate") && parts.length !== 3) throw new Error(ctx.output.i18n.t("common.usage", { command: `/forge ${sub} <id> <version>` }));
          if ((sub === "deactivate" || sub === "remove") && !parts[1]) throw new Error(ctx.output.i18n.t("common.usage", { command: `/forge ${sub} <id>${sub === "remove" ? " [version]" : ""}` }));
          args = { action: sub === "registry" ? "list" : sub, ...(parts[1] ? { id: parts[1] } : {}), ...(parts[2] ? { version: parts[2] } : {}) };
        }
        const tool = ctx.runtime.localTools().find(candidate => candidate.definition.function.name === "omr_forge")!;
        const result = await ctx.runtime.events.invoke({ backend: tool.backend, tool: "omr_forge", args, readOnly: tool.readOnly(args), binding: ctx.runtime.binding }, () => tool.invoke(args, abort.signal), abort.signal);
        if (result.isError) ctx.output.fail(result.text); else ctx.output.commandResult("forge", result.structuredContent, result.text);
      } finally { ctx.activeAbort = null; }
      return;
    }

    if (!rest.trim() || sub === "list" || sub === "presets" || sub === "catalog") {
      const installed = ctx.reloadCustomCommands();
      const installedSet = new Set(installed.map((c) => c.name));
      const registered = await ctx.runtime.forge.list();
      const lines = [
        `cyber/RE slash-command blueprints (${FORGE_COMMAND_PRESETS.length} built-in presets):`,
        ...FORGE_COMMAND_PRESETS.map((p) => {
          const state = installedSet.has(p.name) ? "● installed" : "○ available";
          return `  ${p.name.padEnd(25)} [effort=${p.effort.padEnd(6)}] ${state} · ${p.description}`;
        }),
        "",
        "Usage:",
        "  /forge registry [id]                   Inspect versioned tools, schemas, semantic fixtures and proof refs",
        "  /forge register <spec.json> <source>   Register immutable code and manifest (not yet verified/active)",
        "  /forge verify <id> <version>           Run semantic fixtures, record proof; exit 0 alone is insufficient",
        "  /forge activate <id> <version>         Expose a verified version as forge_<id>_v<major>_<minor>_<patch>",
        "  /forge run <id> <input-json>           Execute the active verified version with JSON stdin/stdout",
        "  /forge deactivate <id>                Hide the active tool; preserve its version and proof",
        "  /forge remove <id> [version]          Retire version(s); preserve historical source and runs",
        "  /forge install <preset|all> [--user]   Install preset(s) into .omr/commands/ (or ~/.config/rea/omr/commands/)",
        "  /forge command <name> <goal>           Synthesize a target tool & save reusable /<name> slash command",
        "  /forge <goal>                          Synthesize a complete Python/Frida/YARA/Rizin tool for the bound target",
      ];
      ctx.output.commandResult(
        "forge",
        {
          presets: FORGE_COMMAND_PRESETS.map((p) => ({
            name: p.name,
            aliases: p.aliases,
            effort: p.effort,
            description: p.description,
            installed: installedSet.has(p.name),
          })),
          installed_commands: installed.map((c) => c.name),
          registered_tools: registered,
        },
        lines.join("\n"),
      );
      return;
    }

    if (sub === "install" || sub === "init") {
      let scope: "project" | "user" = "project";
      const targets: string[] = [];
      for (const tok of parts.slice(1)) {
        const low = tok.toLowerCase();
        if (low === "--user" || low === "--global" || low === "-g") {
          scope = "user";
        } else {
          targets.push(low);
        }
      }
      const query = targets[0] ?? "all";
      const selected =
        query === "all" || query === "*"
          ? FORGE_COMMAND_PRESETS
          : FORGE_COMMAND_PRESETS.filter(
              (p) => p.name === query || p.aliases.includes(query),
            );
      if (selected.length === 0) {
        ctx.output.fail(
          ctx.output.i18n.t("workflow.unknownForge", { query, presets: FORGE_COMMAND_PRESETS.map((p) => p.name).join(", ") }),
        );
        return;
      }
      const results: Array<{ name: string; path: string }> = [];
      for (const preset of selected) {
        const created = await installForgePreset(preset, {
          scope,
          cwd: ctx.cwd,
          env: ctx.env,
        });
        results.push({ name: created.spec.name, path: created.path });
      }
      ctx.reloadCustomCommands();
      const lines = [
        `installed ${results.length} cyber/RE slash command(s) (${scope} scope):`,
        ...results.map((r) => `  /${r.name.padEnd(24)} → ${r.path}`),
      ];
      ctx.output.commandResult(
        "forge",
        { installed: results, scope },
        lines.join("\n"),
      );
      return;
    }

    if (sub === "command" || sub === "cmd") {
      const cmdName = parts[1]?.trim() ?? "";
      const goal = parts.slice(2).join(" ").trim();
      if (!cmdName || !goal) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/forge command <name> <goal>" }));
        return;
      }
      let createdPath = "";
      let createdName = cmdName;
      try {
        const created = await saveCustomCommandFile({
          name: cmdName,
          description: `Forged workflow: ${goal.slice(0, 90)}`,
          template: `${forgePrompt("$TARGET", `${goal}\nAdditional focus: $ARGUMENTS`)}`,
          cwd: ctx.cwd,
          env: ctx.env,
        });
        createdPath = created.path;
        createdName = created.spec.name;
        ctx.reloadCustomCommands();
      } catch (error) {
        ctx.output.fail(errorMessageOf(error));
        return;
      }
      if (ctx.opts.noModel || !ctx.modelController.modelInfo) {
        ctx.output.commandResult(
          "forge",
          { command: createdName, path: createdPath, goal },
          ctx.output.i18n.t("workflow.forged", { name: createdName, path: createdPath }),
        );
        return;
      }
      try {
        await ctx.ensureConnected();
      } catch {
        return;
      }
      ctx.output.ui?.addUser(rawLine);
      await ctx.runTurn(
        forgePrompt(ctx.currentTarget, goal),
        `forge (${createdName}): ${goal}`,
        { autoSaveScriptPrefix: `forge-${createdName}` },
      );
      return;
    }

    if (ctx.opts.noModel || !ctx.modelController.modelInfo) {
      ctx.output.fail(
        ctx.opts.noModel
          ? ctx.output.i18n.t("workflow.forgeNeedsModel")
          : ctx.output.i18n.t("workflow.noModel", { detail: ctx.modelController.modelError ?? "unknown error" }),
      );
      return;
    }
    try {
      await ctx.ensureConnected();
    } catch {
      return;
    }
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(
      forgePrompt(ctx.currentTarget, rest),
      `forge: ${rest}`,
      { autoSaveScriptPrefix: "forge-tool" },
    );
  });

  // Override: /adb [devices|packages|pull <pkg>|logcat|<goal>]
  registry.register("adb", async (ctx, rest, rawLine) => {
    const parts = splitShellTokens(rest);
    const sub = (parts[0] ?? "devices").toLowerCase();
    if (!rest || sub === "devices") {
      const res = await ctx.reaCall("list_adb_devices", {});
      if (res.problem) {
        ctx.output.fail(res.problem);
        return;
      }
      ctx.output.commandResult(
        "adb",
        res.payload,
        compactJson(normalized(res.payload), 6_000),
      );
      return;
    }
    if (sub === "packages") {
      const filter = parts.slice(1).join(" ").trim();
      const res = await ctx.reaCall(
        "list_adb_packages",
        filter ? { filter } : {},
      );
      if (res.problem) {
        ctx.output.fail(res.problem);
        return;
      }
      ctx.output.commandResult(
        "adb",
        res.payload,
        compactJson(normalized(res.payload), 10_000),
      );
      return;
    }
    if (sub === "logcat") {
      const filter = parts.slice(1).join(" ").trim();
      const res = await ctx.reaCall(
        "read_adb_logcat",
        filter ? { filter, lines: 120 } : { lines: 120 },
      );
      if (res.problem) {
        ctx.output.fail(res.problem);
        return;
      }
      ctx.output.commandResult(
        "adb",
        res.payload,
        compactJson(normalized(res.payload), 12_000),
      );
      return;
    }
    if (sub === "pull") {
      const pkg = parts[1]?.trim();
      if (!pkg) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/adb pull <package_name>" }));
        return;
      }
      const outDir = join(ctx.session.dir, "pulled");
      const pulled = await ctx.reaCall("pull_adb_package", {
        package_name: pkg,
        output_dir: outDir,
      });
      if (pulled.problem) {
        ctx.output.fail(pulled.problem);
        return;
      }
      const rec = asRecord(normalized(pulled.payload));
      const pulledPath =
        asString(rec?.["output_path"]) ||
        asString(rec?.["path"]) ||
        asString(rec?.["apk_path"]) ||
        "";
      if (pulledPath) {
        const opened = await ctx.reaCall("open_binary", { path: pulledPath });
        if (!opened.problem) {
          await ctx.selectTarget(pulledPath);
          ctx.targetOpened = true;
          ctx.targetOpenFailedPath = null;
          await ctx.syncMagic(ctx.currentTarget);
          await ctx.persistMeta(ctx.currentTarget);
          await ctx.syncBoundSessionSummary();
        }
      }
      ctx.output.commandResult(
        "adb",
        pulled.payload,
        `${compactJson(normalized(pulled.payload), 6_000)}${pulledPath ? `\nbound target → ${pulledPath}` : ""}`,
      );
      return;
    }
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(adbPrompt(ctx.currentTarget, rest), `adb: ${rest}`);
  });

  // Override: /browser [status|camofox|chromium|firefox|zen|tor|proxy|tabs|close|<url|goal>]
  registry.register("browser", async (ctx, rest, rawLine) => {
    const lowerRaw = rawLine.trim().toLowerCase();
    const effectiveRest =
      lowerRaw.startsWith("/tor") && !rest.toLowerCase().startsWith("tor")
        ? `tor ${rest}`.trim()
        : lowerRaw.startsWith("/camofox") &&
            !rest.toLowerCase().startsWith("camofox")
          ? `camofox ${rest}`.trim()
          : rest;
    const parts = splitShellTokens(effectiveRest);
    const sub = (parts[0] ?? "status").toLowerCase();

    if (sub === "context" || sub === "select") {
      const result = await ctx.browserManager.call("omr_browser", { action: sub, ...(parts[1] ? { tabId: parts[1] } : {}) });
      if (result.isError) ctx.output.fail(result.text); else ctx.output.commandResult("browser", result.payload, result.text);
      return;
    }
    if (!effectiveRest || sub === "status") {
      const snap = await ctx.browserManager.status();
      ctx.output.commandResult("browser", snap, renderBrowserStatus(snap));
      return;
    }
    if (sub === "tabs" || sub === "list") {
      const res = await ctx.browserManager.call("camofox_list_tabs", {});
      if (res.isError) {
        ctx.output.fail(res.text);
        return;
      }
      ctx.output.commandResult(
        "browser",
        res.payload,
        compactJson(res.payload, 8_000),
      );
      return;
    }
    if (sub === "close" || sub === "stop") {
      const tabId = parts[1]?.trim();
      if (tabId && tabId.toLowerCase() !== "all") {
        const res = await ctx.browserManager.call("camofox_close_tab", {
          tabId,
        });
        if (res.isError) {
          ctx.output.fail(res.text);
          return;
        }
        ctx.output.commandResult(
          "browser",
          res.payload,
          ctx.output.i18n.t("workflow.tabClosed", { id: tabId }),
        );
        return;
      }
      const closedLocal = await ctx.browserManager.closeLocalBrowser();
      ctx.output.commandResult(
        "browser",
        { closed_local: closedLocal },
        closedLocal
          ? ctx.output.i18n.t("workflow.browserClosed")
          : ctx.output.i18n.t("workflow.noBrowser"),
      );
      return;
    }
    if (sub === "tor") {
      const arg = (parts[1] ?? "on").toLowerCase();
      const enable =
        arg !== "off" &&
        arg !== "0" &&
        arg !== "false" &&
        arg !== "disable";
      const res = await ctx.browserManager.setTorMode(enable);
      const statusNote = res.tor.available
        ? `reachable (${res.tor.source})`
        : `standby (${res.tor.source})`;
      ctx.output.commandResult(
        "browser",
        res,
        enable
          ? `next local browser launch → tor (${res.proxyUrl} · remote DNS / .onion preference · ${statusNote}). Camofox routing is server-managed and unverified.`
          : "next local browser launch → direct (Tor disabled). Camofox routing is server-managed and unverified.",
      );
      return;
    }
    if (sub === "proxy") {
      const proxyArg = parts.slice(1).join(" ").trim();
      if (!proxyArg) {
        ctx.output.fail(
          "usage: /browser proxy <http://host:port|socks5h://host:port|off>",
        );
        return;
      }
      const res = ctx.browserManager.setProxyMode(proxyArg);
      ctx.output.commandResult(
        "browser",
        res,
        res.networkMode === "direct"
          ? "next local browser launch → direct (proxy cleared). Camofox routing is server-managed and unverified."
          : `next local browser launch → ${res.networkMode} (${res.proxyUrl}). Camofox routing is server-managed and unverified.`,
      );
      return;
    }

    const engineNames = new Set<BrowserEngineId>([
      "camofox",
      "chromium",
      "firefox",
      "zen",
      "chrome",
      "brave",
    ]);
    if (engineNames.has(sub as BrowserEngineId)) {
      const engine = sub as BrowserEngineId;
      let headless = true;
      let torOverride: boolean | undefined;
      let proxyOverride: string | undefined;
      let urlArg: string | undefined;
      for (let i = 1; i < parts.length; i += 1) {
        const tok = parts[i]!;
        const low = tok.toLowerCase();
        if (low === "--gui" || low === "--headed" || low === "--headful") {
          headless = false;
        } else if (low === "--headless") {
          headless = true;
        } else if (low === "--tor") {
          torOverride = true;
        } else if (
          (low === "--proxy" || low === "-x") &&
          i + 1 < parts.length
        ) {
          proxyOverride = parts[i + 1]!;
          i += 1;
        } else if (low.startsWith("--proxy=")) {
          proxyOverride = tok.slice("--proxy=".length);
        } else if (!urlArg) {
          urlArg = tok;
        }
      }
      if (torOverride !== undefined)
        await ctx.browserManager.setTorMode(torOverride);
      if (proxyOverride !== undefined)
        ctx.browserManager.setProxyMode(proxyOverride);

      if (engine === "camofox") {
        ctx.browserManager.setPreferredEngine("camofox");
        const health = await ctx.browserManager.ensureCamofoxRunning();
        if (!health.reachable) {
          ctx.output.fail(
            ctx.output.i18n.t("workflow.camofoxOffline", { url: health.baseUrl, detail: health.error ?? "not reachable" }),
          );
          return;
        }
        if (urlArg) {
          const tabRes = await ctx.browserManager.call("camofox_create_tab", {
            url: urlArg,
          });
          if (tabRes.isError) {
            ctx.output.fail(tabRes.text);
            return;
          }
          ctx.output.commandResult(
            "browser",
            { engine: "camofox", health, tab: tabRes.payload },
            `camofox anti-detect tab opened on ${urlArg}:\n${compactJson(tabRes.payload, 4_000)}`,
          );
          return;
        }
        ctx.output.commandResult(
          "browser",
          { engine: "camofox", health },
          `preferred browser → camofox (${health.baseUrl} · engine=${health.engine ?? "camoufox"} · activeTabs=${health.activeTabs})`,
        );
        return;
      }

      try {
        const launched = await ctx.browserManager.launchLocalBrowser({
          engine,
          url: urlArg,
          headless,
        });
        ctx.output.commandResult(
          "browser",
          launched,
          [
            `launched ${launched.engine} (${launched.headless ? "headless" : "gui"} · pid ${launched.pid})`,
            `  binary   ${launched.binary}`,
            `  cdp      ${launched.cdpUrl} (ready for REA inspect_web_page / observe_web_session)`,
            `  routing  ${launched.networkMode}${launched.proxyUrl ? ` (${launched.proxyUrl})` : ""}`,
            `  profile  ${launched.profileDir}`,
            ...(launched.lastUrl ? [`  url      ${launched.lastUrl}`] : []),
          ].join("\n"),
        );
      } catch (error) {
        ctx.output.fail(errorMessageOf(error));
      }
      return;
    }

    const snap = await ctx.browserManager.status();
    ctx.output.ui?.addUser(rawLine);
    await ctx.runTurn(
      browserPrompt(
        ctx.currentTarget,
        effectiveRest,
        renderBrowserStatus(snap),
      ),
      `browser: ${effectiveRest}`,
    );
  });

  // /spawn [--bg] [workflow] <goal> — isolated read-only subagent delegation
  registry.register("spawn", async (ctx, rest) => {
    if (ctx.opts.noModel || !ctx.modelController.modelInfo) {
      ctx.output.fail(
        ctx.opts.noModel
          ? ctx.output.i18n.t("workflow.subagentsDisabled")
          : ctx.output.i18n.t("workflow.noModel", { detail: ctx.modelController.modelError ?? "unknown error" }),
      );
      return;
    }
    const rawParts = splitShellTokens(rest);
    if (rawParts.length === 0) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/spawn [--bg] [workflow] <goal>" }));
      return;
    }
    let background = false;
    const parts: string[] = [];
    for (const token of rawParts) {
      if (token === "--bg" || token === "--background" || token === "-b") {
        background = true;
      } else {
        parts.push(token);
      }
    }
    if (parts.length === 0) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/spawn [--bg] [workflow] <goal>" }));
      return;
    }
    const candidateWf = findOmrWorkflow(parts[0]!);
    let workflow: string | undefined;
    let goal = parts.join(" ").trim();
    if (candidateWf && parts.length >= 2) {
      workflow = candidateWf.id;
      goal = parts.slice(1).join(" ").trim();
    } else if (candidateWf && parts.length === 1) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: `/spawn ${background ? "--bg " : ""}${candidateWf.id} <goal>` }));
      return;
    }

    if (background) {
      const { node } = ctx.subagentRunner.spawnNode({
        goal,
        workflow,
        mode: "background",
      });
      const snap = ctx.subagentRunner.graphSnapshot();
      const text = [
        `spawned background subagent → ${node.id} (${node.role})`,
        `  workflow  ${node.workflow ? `/${node.workflow}` : "custom"}`,
        `  goal      ${node.goal}`,
        `  monitor   /subagents inspect ${node.id}  ·  /subagents graph`,
        `  steer     /steer ${node.id} <correction_prompt>`,
      ].join("\n");
      ctx.output.commandResult(
        "spawn",
        {
          id: node.id,
          role: node.role,
          mode: "background",
          status: node.status,
          workflow: node.workflow,
          goal: node.goal,
          graph: snap,
        },
        text,
      );
      return;
    }

    ctx.output.ui?.setBusy(
      ctx.output.i18n.t("workflow.subagentRunning", { workflow: workflow ? ` (/${workflow})` : "" }),
    );
    try {
      const result = await ctx.subagentRunner.runTask({
        goal,
        workflow,
        mode: "wait",
      });
      for (const id of result.evidenceIds) {
        ctx.evidenceSeen.add(id);
        ctx.lastEvidenceId = id;
      }
      const rendered = `${formatSubagentResult(result)}\n\n${renderSubagentGraph(ctx.subagentRunner.graphSnapshot())}`;
      await ctx.appendReport(
        `spawn${workflow ? ` (${workflow})` : ""}: ${goal}`,
        rendered,
      );
      await ctx.syncLocalStatus();
      ctx.output.commandResult("spawn", result, rendered);
    } catch (error) {
      ctx.output.fail(ctx.output.i18n.t("workflow.subagentFailed", { detail: errorMessageOf(error) }));
    } finally {
      ctx.output.ui?.setBusy(null);
    }
  });

  // /steer <sub-id> <correction_prompt> — course-correct a running or finished subagent
  const runSteerCommand = async (
    ctx: OmrContext,
    rest: string,
    commandName: "steer" | "subagents",
  ): Promise<void> => {
    const tokens = splitShellTokens(rest);
    let background = false;
    const cleanTokens: string[] = [];
    for (const tok of tokens) {
      if (tok === "--bg" || tok === "--background") background = true;
      else cleanTokens.push(tok);
    }
    const agentId = cleanTokens[0]?.trim() ?? "";
    const prompt = cleanTokens.slice(1).join(" ").trim();
    if (!agentId || !prompt) {
      ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/steer [--bg] <sub-id> <correction_prompt>" }));
      return;
    }
    ctx.output.ui?.setBusy(ctx.output.i18n.t("workflow.steering", { id: agentId }));
    try {
      const steered = await ctx.subagentRunner.steer(agentId, prompt, {
        wait: !background,
      });
      if (!steered.ok) {
        ctx.output.fail(steered.message);
        return;
      }
      for (const id of steered.result?.evidenceIds ??
        steered.node?.evidenceIds ??
        []) {
        ctx.evidenceSeen.add(id);
        ctx.lastEvidenceId = id;
      }
      await ctx.syncLocalStatus();
      const body = steered.result
        ? `${steered.message}\n\n${formatSubagentResult(steered.result)}\n\n${renderSubagentGraph(ctx.subagentRunner.graphSnapshot())}`
        : `${steered.message}\n\n${steered.node ? renderSubagentInspector(steered.node) : ""}`;
      ctx.output.commandResult(
        commandName,
        {
          ok: true,
          mode: steered.mode,
          message: steered.message,
          node: steered.node,
          result: steered.result,
        },
        body,
      );
    } finally {
      ctx.output.ui?.setBusy(null);
    }
  };

  registry.register("steer", async (ctx, rest) => {
    await runSteerCommand(ctx, rest, "steer");
  });

  // /subagents [graph|inspect <id>|steer <id> <prompt>|wait [id]|cancel <id>]
  registry.register("subagents", async (ctx, rest) => {
    const tokens = splitShellTokens(rest);
    const sub = (tokens[0] ?? "graph").toLowerCase();

    if (!tokens[0] || sub === "graph" || sub === "status" || sub === "list") {
      const snap = ctx.subagentRunner.graphSnapshot();
      ctx.output.commandResult(
        "subagents",
        snap,
        renderSubagentGraph(snap),
      );
      return;
    }

    if (sub === "inspect" || sub === "watch" || sub === "show") {
      const targetId = tokens[1]?.trim() ?? "";
      if (!targetId) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/subagents inspect <sub-id>" }));
        return;
      }
      const node = ctx.subagentRunner.getNodeSnapshot(targetId);
      if (!node) {
        ctx.output.fail(ctx.output.i18n.t("workflow.subagentMissing", { query: targetId }));
        return;
      }
      ctx.output.commandResult(
        "subagents",
        node,
        renderSubagentInspector(node),
      );
      return;
    }

    if (sub === "steer" || sub === "correct") {
      await runSteerCommand(ctx, tokens.slice(1).join(" "), "subagents");
      return;
    }

    if (sub === "wait") {
      const ids = tokens.slice(1).filter(Boolean);
      ctx.output.ui?.setBusy(ctx.output.i18n.t("workflow.waiting"));
      try {
        const results = await ctx.subagentRunner.waitFor(
          ids.length > 0 ? ids : undefined,
        );
        const snap = ctx.subagentRunner.graphSnapshot();
        ctx.output.commandResult(
          "subagents",
          { results, graph: snap },
          `${renderSubagentGraph(snap)}\n\n${results.map((r) => formatSubagentResult(r)).join("\n\n---\n\n")}`,
        );
      } finally {
        ctx.output.ui?.setBusy(null);
      }
      return;
    }

    if (sub === "cancel" || sub === "kill" || sub === "stop") {
      const targetId = tokens[1]?.trim() ?? "";
      if (!targetId) {
        ctx.output.fail(ctx.output.i18n.t("common.usage", { command: "/subagents cancel <sub-id>" }));
        return;
      }
      const cancelled = ctx.subagentRunner.cancel(targetId);
      if (!cancelled) {
        ctx.output.fail(ctx.output.i18n.t("workflow.subagentMissing", { query: targetId }));
        return;
      }
      ctx.output.commandResult(
        "subagents",
        cancelled,
        ctx.output.i18n.t("workflow.cancelled", { id: cancelled.id, role: cancelled.role }),
      );
      return;
    }

    // Fallback: if operator typed `/subagents sub-1`, treat it as `/subagents inspect sub-1`
    const maybeNode = ctx.subagentRunner.getNodeSnapshot(tokens[0]!);
    if (maybeNode) {
      ctx.output.commandResult(
        "subagents",
        maybeNode,
        renderSubagentInspector(maybeNode),
      );
      return;
    }

    ctx.output.fail(
      "usage: /subagents [graph|inspect <id>|steer <id> <prompt>|wait [id]|cancel <id>]",
    );
  });
};
