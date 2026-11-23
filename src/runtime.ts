import { createInterface } from "node:readline";
import type { LaunchOptions } from "./args.js";
import { inspectTargetMagic } from "./binaryArt.js";
import { releaseEarlyInput } from "./earlyInput.js";
import { resolveReaEnv } from "./env.js";
import { I18n } from "./i18n/index.js";
import type { ChatImageBlock } from "./model.js";
import {
  autonomousWorkflowNote,
  investigatePrompt,
  matchWorkflowsForInput,
} from "./prompts.js";
import { CommandRegistry } from "./runtime/commandRegistry.js";
import { OmrContext, type OmrRuntimeDeps } from "./runtime/context.js";
import { registerSessionHandlers } from "./runtime/handlers/sessionHandlers.js";
import { registerSystemHandlers } from "./runtime/handlers/systemHandlers.js";
import { registerWorkflowHandlers } from "./runtime/handlers/workflowHandlers.js";
import { OutputSink } from "./runtime/output.js";
import { createSession } from "./session.js";
import {
  detectTarget,
  listTargetCandidates,
  resolveTargetPath,
} from "./target.js";
import type { UiSubmitOptions } from "./tui.js";
import { VERSION } from "./version.js";

export type { OmrRuntimeDeps } from "./runtime/context.js";
export { CommandRegistry } from "./runtime/commandRegistry.js";

export const createDefaultCommandRegistry = (): CommandRegistry => {
  const registry = new CommandRegistry();
  registerWorkflowHandlers(registry);
  registerSessionHandlers(registry);
  registerSystemHandlers(registry);
  return registry;
};

export const runOmr = async (
  opts: LaunchOptions,
  deps?: OmrRuntimeDeps,
  i18n = new I18n(),
): Promise<number> => {
  const cwd = deps?.cwd ?? process.cwd();

  const uiEnabled =
    !opts.plain &&
    !opts.json &&
    !opts.command &&
    !opts.goal &&
    !deps &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!uiEnabled) releaseEarlyInput();
  const output = new OutputSink({
    i18n,
    json: opts.json,
    writeStdout: deps?.writeStdout,
    writeStderr: deps?.writeStderr,
  });
  let ctx: OmrContext;
  let initialization: Promise<void> | undefined;
  const initialize = async (): Promise<void> => {
    const { env, sources } = deps?.env
      ? { env: deps.env, sources: [...(deps.envSources ?? [])] }
      : resolveReaEnv();
    const languageReady = i18n.initialize(opts.lang, env, opts.json);
    const candidates = uiEnabled ? await listTargetCandidates(cwd) : [];
    const currentTarget = opts.target
      ? resolveTargetPath(opts.target, cwd)
      : uiEnabled ? (candidates.length === 1 ? candidates[0]! : null) : await detectTarget(cwd);
    const currentMagic = await inspectTargetMagic(currentTarget);
    const session = await createSession(currentTarget, null, { rootDir: deps?.sessionsRootDir });
    await languageReady;
    ctx = new OmrContext({
      opts, cwd, env, sources, sessionsRootDir: deps?.sessionsRootDir,
      output, session, currentTarget, currentMagic, deps,
    });
    await ctx.persistMeta();
    if (uiEnabled) ctx.modelController.beginCapabilityHydration();
    else await ctx.modelController.hydrateActiveCapabilities();

    output.emit("session.start", {
      session_dir: session.dir,
      target: ctx.currentTarget,
      model: ctx.modelId,
      profile: ctx.activeProfile?.id ?? null,
    });
    const ui = output.ui;
    if (ui) {
      ui.setCommands(ctx.allCommands());
      ui.setStatus({
        model: ctx.modelId,
        modelProvider: ctx.modelController.modelInfo?.config.providerId ?? null,
        effort: ctx.modelController.modelInfo?.config.reasoningEffort ?? "auto",
        target: ctx.currentTarget,
        magic: ctx.currentMagic,
        candidates,
        session: session.id,
      });
    } else if (!opts.json) {
      output.write(i18n.t("launch.session", { version: VERSION, target: ctx.currentTarget ?? i18n.t("hud.noTarget"), id: session.id, profile: ctx.activeProfile ? i18n.t("launch.profileTag", { id: ctx.activeProfile.id }) : "" }));
      output.write(i18n.t("launch.model", { id: ctx.modelId, error: ctx.modelController.modelError && !opts.noModel ? ` (${ctx.modelController.modelError})` : "" }));
    }
    ctx.showStartupNotices();
    ui?.setBusy(null);
    if (opts.dashboard && !opts.command && !opts.goal) {
      const dashboard = ctx.startDashboard();
      if (!uiEnabled) await dashboard;
    }
  };
  const registry = createDefaultCommandRegistry();
  const runLine = async (
    line: string,
    images?: readonly ChatImageBlock[],
  ): Promise<boolean> => {
    const trimmed = line.trim();
    const hasImages = Boolean(images && images.length > 0);
    if (!trimmed && !hasImages) return true;
    if (trimmed.startsWith("!")) {
      return ctx.executeBangLine(trimmed);
    }
    if (!trimmed.startsWith("/")) {
      const promptText = trimmed || (opts.json ? "Bu görseli incele ve analiz et." : i18n.t("launch.imagePrompt"));
      const userBadge = hasImages
        ? `${promptText} [📎 ×${images!.length}]`
        : promptText;
      output.ui?.addUser(userBadge);
      const matchedWorkflows = matchWorkflowsForInput(promptText);
      const wfHint = autonomousWorkflowNote(promptText);
      const autoPrefix = matchedWorkflows.find(
        (w) => w.autoSavePrefix,
      )?.autoSavePrefix;
      await ctx.runTurn(
        wfHint ? `${promptText}\n\n${wfHint}` : promptText,
        promptText.slice(0, 80),
        {
          ...(autoPrefix ? { autoSaveScriptPrefix: autoPrefix } : {}),
          ...(images && images.length > 0 ? { images } : {}),
        },
      );
      return true;
    }
    return registry.dispatchSlashLine(ctx, trimmed);
  };

  let lineChain: Promise<void> = Promise.resolve();
  let languageChain = lineChain;
  const submitQueued = (
    line: string,
    after?: () => void,
    submitOpts?: UiSubmitOptions,
  ): void => {
    const trimmed = line.trim();
    if (
      ctx?.isTurnActive() &&
      !trimmed.startsWith("/") &&
      !trimmed.startsWith("!")
    ) {
      if (submitOpts?.immediate) {
        ctx.interruptAndSteer(trimmed, submitOpts.images);
      } else {
        ctx.enqueueLiveSteer(trimmed, submitOpts?.images);
      }
      return;
    }
    // Language changes must stay responsive while a turn or tool is awaiting I/O.
    const liveLanguage = uiEnabled && /^\/(?:lang|language)(?:\s|$)/i.test(trimmed);
    const pendingLanguage = languageChain;
    const queued = (liveLanguage ? pendingLanguage : lineChain)
      .then(async () => {
        await initialization;
        await pendingLanguage;
        const keep = await runLine(line, submitOpts?.images);
        if (!keep) {
          await ctx.shutdown("complete");
          process.exit(0);
        }
        if (!liveLanguage) await ctx.syncLocalStatus();
        after?.();
      })
      .catch((error: unknown) => {
        output.fail(error instanceof Error ? error.message : String(error));
        after?.();
      });
    if (liveLanguage) languageChain = queued;
    else lineChain = queued;
  };
  const onUnhandledRejection = (reason: unknown): void => {
    output.fail(
      i18n.t("launch.unhandled", { detail: reason instanceof Error ? reason.message : String(reason) }),
    );
  };
  const onUncaughtException = (error: Error): void => {
    void (ctx?.shutdown("crashed") ?? Promise.resolve()).finally(() => {
      process.stderr.write(i18n.t("launch.crashed", { detail: error.stack ?? error.message }));
      process.exit(1);
    });
  };
  const onSigterm = (): void => {
    output.ui?.stop();
    void (ctx?.shutdown("cancelled") ?? Promise.resolve()).finally(() => process.exit(143));
  };
  const onSighup = (): void => {
    output.ui?.stop();
    void (ctx?.shutdown("cancelled") ?? Promise.resolve()).finally(() => process.exit(129));
  };

  if (!deps) {
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);
  }
  const detachProcessListeners = (): void => {
    if (deps) return;
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  };
  const resumeLine = opts.resume ? `/resume ${opts.resume}` : null;
  if (!uiEnabled) await initialize();
  const runBatch = async (work: () => Promise<void>): Promise<number> => {
    try {
      if (resumeLine) await runLine(resumeLine);
      if (output.exitCode === 0) await work();
    } catch (error) {
      output.fail(error instanceof Error ? error.message : String(error));
    } finally {
      await ctx.shutdown(output.outcome.status === "completed" ? "complete" : output.outcome.status);
      detachProcessListeners();
    }
    return output.exitCode;
  };
  if (opts.command) return runBatch(async () => { await runLine(opts.command!); });
  if (opts.goal) {
    return runBatch(async () => {
      await ctx.runTurn(
        investigatePrompt(ctx.currentTarget, opts.goal!),
        `investigate: ${opts.goal}`,
      );
    });
  }

  if (!process.stdin.isTTY) {
    return runBatch(async () => {
      let buffer = "";
      for await (const chunk of process.stdin) buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        if (!(await runLine(line))) break;
      }
    });
  }
  if (uiEnabled) {
    const { TerminalUi: TerminalUiImpl } = await import("./tui.js");
    const ui = new TerminalUiImpl({
      i18n,
      cwd,
      commands: [],
      providers: () => ctx?.modelController.providers ?? [],
      onSubmit: (line, submitOpts) =>
        submitQueued(line, undefined, submitOpts),
      onDequeueSteer: () => ctx?.dequeueLiveSteer(),
      onInterrupt: () => {
        if (ctx?.activeAbort) {
          ctx.activeAbort.abort();
          return;
        }
        ui.stop();
        void (ctx?.shutdown("cancelled") ?? Promise.resolve()).then(() => process.exit(130));
      },
      onExit: () => {
        ui.stop();
        void (ctx?.shutdown("complete") ?? Promise.resolve()).then(() => process.exit(0));
      },
      onOpenModelPicker: (focusProviderId) => {
        ctx?.modelController.openInteractiveModelPicker(focusProviderId);
      },
      onOpenEffortPicker: () => {
        ctx?.modelController.openInteractiveEffortPicker();
      },
      onOpenCompactionModelPicker: () => {
        ctx?.modelController.openInteractiveCompactionModelPicker();
      },
      onSelectModel: (providerId, nextModel, effort, saveDefault) => {
        void ctx?.modelController
          .applyModelSelection(providerId, nextModel, saveDefault, effort)
          .then(({ savedPath }) => {
            const effTag = effort !== "auto" ? i18n.t("launch.thinkingTag", { effort }) : "";
            ui.addSystem(
              savedPath
                ? i18n.t("launch.modelSaved", { provider: providerId, model: nextModel, effort: effTag, path: savedPath })
                : i18n.t("launch.activeModel", { provider: providerId, model: nextModel, effort: effTag }),
            );
          })
          .catch((error: unknown) => {
            ui.showOutput(
              "model",
              error instanceof Error ? error.message : String(error),
            );
          });
      },
      onSelectEffort: (effort, saveDefault) => {
        if (!ctx) return;
        try {
          const { savedPath } = ctx.modelController.applyEffortSelection(
            effort,
            saveDefault,
          );
          if (!savedPath) ctx.modelController.rememberEffort(effort);
          ui.addSystem(
            savedPath
              ? i18n.t("launch.effortSaved", { effort, path: savedPath })
              : i18n.t("launch.effort", { effort }),
          );
        } catch (error) {
          ui.showOutput(
            "effort",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      onSelectCompactionModel: (spec, saveDefault) => {
        if (!ctx) return;
        try {
          const { spec: resolvedSpec, savedPath } =
            ctx.modelController.applyCompactionModelSelection(spec, saveDefault);
          const primaryTag = `${ctx.modelController.modelInfo?.config.providerId ? `${ctx.modelController.modelInfo.config.providerId}:` : ""}${ctx.modelId}`;
          const targetDesc = resolvedSpec
            ? i18n.t("launch.compactionUsing", { model: resolvedSpec, primary: primaryTag })
            : i18n.t("launch.compactionActive", { model: primaryTag });
          ui.addSystem(
            i18n.t("launch.compactionModel", { model: targetDesc, saved: savedPath ? i18n.t("launch.savedTag", { path: savedPath }) : "" }),
          );
        } catch (error) {
          ui.showOutput(
            "compaction",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      onRefreshModels: () => {
        void ctx?.modelController.triggerProvidersRefresh(true);
      },
    });
    output.setUi(ui);
    ui.setBusy((t) => t("launch.initializing"));
    // `--resume` replaces this throwaway session's runtime, so connecting REA for it first would boot a
    // second REA process (and make `/resume` wait for the first one). Connect after the resume instead.
    if (resumeLine) {
      submitQueued(resumeLine, () => void ctx?.ensureConnected().catch(() => {}));
    }
    ui.start();
    initialization = new Promise<void>((resolve) => setImmediate(resolve)).then(initialize);
    void initialization.catch((error: unknown) => {
      ui.setBusy(null);
      output.fail(error instanceof Error ? error.message : String(error));
    });
    // Runs after the first paint: the cached update result shows at once, and this launch's
    // background registry check inserts or updates the boxed notice live when it answers.
    void initialization.then(() => import("./setup.js")).then(({ announceRelease }) =>
      announceRelease(ctx.env, (notice) => ui.addSystem(notice, true), (info) => ui.showUpdate(info)),
    ).catch(() => {});
    if (!resumeLine) {
      void initialization.then(() => ctx.ensureConnected()).catch(() => {});
    }
    return new Promise<number>(() => {});
  }
  const repl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: "omr › ",
  });
  if (resumeLine) submitQueued(resumeLine, () => repl.prompt());
  else repl.prompt();
  process.on("SIGINT", () => {
    if (ctx.activeAbort) {
      ctx.activeAbort.abort();
      return;
    }
    repl.close();
    void ctx.shutdown("cancelled").then(() => process.exit(130));
  });
  repl.on("line", (line) => {
    submitQueued(line, () => repl.prompt());
  });
  repl.on("close", () => {
    void ctx.shutdown("complete").then(() => process.exit(0));
  });
  return new Promise<number>(() => {});
};
