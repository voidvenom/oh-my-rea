import { createInterface } from "node:readline";
import type { LaunchOptions } from "./args.js";
import { inspectTargetMagic } from "./binaryArt.js";
import { resolveReaEnv } from "./env.js";
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
import { PROJECT_INSTRUCTIONS_LIMIT, createSession } from "./session.js";
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
): Promise<number> => {
  const cwd = deps?.cwd ?? process.cwd();
  const { env, sources } = deps?.env
    ? { env: deps.env, sources: [...(deps.envSources ?? [])] }
    : resolveReaEnv();

  const uiEnabled =
    !opts.plain &&
    !opts.json &&
    !opts.command &&
    !opts.goal &&
    !deps &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const candidates = uiEnabled ? await listTargetCandidates(cwd) : [];
  const currentTarget = opts.target
    ? resolveTargetPath(opts.target, cwd)
    : await detectTarget(cwd);
  const currentMagic = await inspectTargetMagic(currentTarget);
  const session = await createSession(currentTarget, null, {
    rootDir: deps?.sessionsRootDir,
  });

  const output = new OutputSink({
    json: opts.json,
    writeStdout: deps?.writeStdout,
    writeStderr: deps?.writeStderr,
  });
  const ctx = new OmrContext({
    opts,
    cwd,
    env,
    sources,
    sessionsRootDir: deps?.sessionsRootDir,
    output,
    session,
    currentTarget,
    currentMagic,
    deps,
  });
  await ctx.persistMeta();
  await ctx.modelController.hydrateActiveCapabilities();

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
      const promptText = trimmed || "Bu görseli incele ve analiz et.";
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
  const submitQueued = (
    line: string,
    after?: () => void,
    submitOpts?: UiSubmitOptions,
  ): void => {
    const trimmed = line.trim();
    if (
      ctx.isTurnActive() &&
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
    lineChain = lineChain
      .then(async () => {
        const keep = await runLine(line, submitOpts?.images);
        if (!keep) {
          await ctx.shutdown("complete");
          process.exit(0);
        }
        await ctx.syncLocalStatus();
        after?.();
      })
      .catch((error: unknown) => {
        output.fail(error instanceof Error ? error.message : String(error));
        after?.();
      });
  };

  const onUnhandledRejection = (reason: unknown): void => {
    output.fail(
      `unhandled error: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  };
  const onUncaughtException = (error: Error): void => {
    void ctx.shutdown("crashed").finally(() => {
      process.stderr.write(`omr crashed: ${error.stack ?? error.message}\n`);
      process.exit(1);
    });
  };
  const onSigterm = (): void => {
    void ctx.shutdown("cancelled").finally(() => process.exit(143));
  };
  const onSighup = (): void => {
    void ctx.shutdown("cancelled").finally(() => process.exit(129));
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

  output.emit("session.start", {
    session_dir: session.dir,
    target: ctx.currentTarget,
    model: ctx.modelId,
    profile: ctx.activeProfile?.id ?? null,
  });
  const startupInstructions = ctx.activeProjectInstructions();
  if (startupInstructions) {
    output.emit("agents.loaded", {
      path: startupInstructions.path,
      chars: startupInstructions.chars,
      truncated: startupInstructions.truncated,
    });
  }
  if (!uiEnabled && !opts.json) {
    output.write(
      `omr ${VERSION} · ${ctx.currentTarget ?? "no target"} · session ${session.id}${ctx.activeProfile ? ` · profile ${ctx.activeProfile.id}` : ""}`,
    );
    output.write(
      `model ${ctx.modelId}${ctx.modelController.modelError && !opts.noModel ? ` (${ctx.modelController.modelError})` : ""}`,
    );
    if (startupInstructions) {
      output.write(
        `agents.md ${startupInstructions.path} (${startupInstructions.chars} chars)`,
      );
    }
  }

  if (opts.dashboard && !opts.command && !opts.goal) {
    await ctx.startDashboard();
  }

  const resumeLine = opts.resume ? `/resume ${opts.resume}` : null;
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
      cwd,
      commands: ctx.allCommands(),
      providers: () => ctx.modelController.providers,
      onSubmit: (line, submitOpts) =>
        submitQueued(line, undefined, submitOpts),
      onDequeueSteer: () => ctx.dequeueLiveSteer(),
      onInterrupt: () => {
        if (ctx.activeAbort) {
          ctx.activeAbort.abort();
          return;
        }
        void ctx.shutdown("cancelled").then(() => process.exit(130));
      },
      onExit: () => {
        void ctx.shutdown("complete").then(() => process.exit(0));
      },
      onOpenModelPicker: (focusProviderId) => {
        ctx.modelController.openInteractiveModelPicker(focusProviderId);
      },
      onOpenEffortPicker: () => {
        ctx.modelController.openInteractiveEffortPicker();
      },
      onOpenCompactionModelPicker: () => {
        ctx.modelController.openInteractiveCompactionModelPicker();
      },
      onSelectModel: (providerId, nextModel, effort, saveDefault) => {
        void ctx.modelController
          .applyModelSelection(providerId, nextModel, saveDefault, effort)
          .then(({ savedPath }) => {
            const effTag = effort !== "auto" ? ` · thinking **${effort}**` : "";
            ui.addSystem(
              savedPath
                ? `Active model → **${providerId}:${nextModel}**${effTag} *(saved default in \`${savedPath}\`)*`
                : `Active model → **${providerId}:${nextModel}**${effTag}`,
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
        try {
          const { savedPath } = ctx.modelController.applyEffortSelection(
            effort,
            saveDefault,
          );
          ui.addSystem(
            savedPath
              ? `Thinking effort → **${effort}** *(saved default in \`${savedPath}\`)*`
              : `Thinking effort → **${effort}**`,
          );
        } catch (error) {
          ui.showOutput(
            "effort",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      onSelectCompactionModel: (spec, saveDefault) => {
        try {
          const { spec: resolvedSpec, savedPath } =
            ctx.modelController.applyCompactionModelSelection(spec, saveDefault);
          const primaryTag = `${ctx.modelController.modelInfo?.config.providerId ? `${ctx.modelController.modelInfo.config.providerId}:` : ""}${ctx.modelId}`;
          const targetDesc = resolvedSpec
            ? `**${resolvedSpec}** *(active investigation continues on \`${primaryTag}\`)*`
            : `**active** (\`${primaryTag}\`)`;
          ui.addSystem(
            `Compaction AI model → ${targetDesc}${savedPath ? ` *(saved default in \`${savedPath}\`)*` : ""}`,
          );
        } catch (error) {
          ui.showOutput(
            "compaction",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      onRefreshModels: () => {
        void ctx.modelController.triggerProvidersRefresh(true);
      },
    });
    output.setUi(ui);
    ui.setStatus({
      model: ctx.modelId,
      modelProvider: ctx.modelController.modelInfo?.config.providerId ?? null,
      effort: ctx.modelController.modelInfo?.config.reasoningEffort ?? "auto",
      target: ctx.currentTarget,
      magic: ctx.currentMagic,
      candidates,
      session: session.id,
    });
    ui.start();
    if (startupInstructions) {
      ui.addSystem(
        `loaded **AGENTS.md** (${startupInstructions.chars} chars${startupInstructions.truncated ? `, cut to ${PROJECT_INSTRUCTIONS_LIMIT}` : ""}) — re-read automatically when it changes · /agents.md for details`,
      );
    }
    if (ctx.activeProfile) {
      ui.addSystem(
        `active profile **${ctx.activeProfile.id}** (${ctx.activeProfile.summary}) · effort **${ctx.activeProfile.effort}**`,
      );
    }
    void ctx.ensureConnected().catch(() => {});
    if (resumeLine) submitQueued(resumeLine);
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
