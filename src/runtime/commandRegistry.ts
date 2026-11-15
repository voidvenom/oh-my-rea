import { COMMANDS, findCommand, type Command } from "../commands.js";
import { renderCustomCommandPrompt } from "../customCommands.js";
import type { OmrContext } from "./context.js";
import type { CommandOutcome } from "../outcome.js";

export type CommandHandler = (
  ctx: OmrContext,
  rest: string,
  rawLine: string,
) => Promise<void>;

/**
 * Single command dispatch registry binding `COMMANDS` to modular handlers and enforcing
 * declarative `argument` and `requires` (`rea` / `openTarget`) contracts.
 */
export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    this.handlers.set(name.toLowerCase(), handler);
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(name.toLowerCase());
  }

  registeredNames(): string[] {
    return [...this.handlers.keys()];
  }

  /** Verify every built-in command in `COMMANDS` (except `exit`) has a registered handler. */
  missingBuiltinHandlers(): string[] {
    return COMMANDS.filter(
      (cmd) => cmd.name !== "exit" && !this.handlers.has(cmd.name),
    ).map((cmd) => cmd.name);
  }

  async dispatchSlashLine(
    ctx: OmrContext,
    trimmedLine: string,
  ): Promise<boolean> {
    return (await this.dispatchCommand(ctx, trimmedLine)).keepRunning;
  }

  async dispatchCommand(ctx: OmrContext, trimmedLine: string): Promise<CommandOutcome> {
    const checkpoint = ctx.output.outcomeCheckpoint();
    let keepRunning = true;
    try {
      keepRunning = await this.runSlashLine(ctx, trimmedLine);
    } catch (error) {
      ctx.output.fail(error instanceof Error ? error.message : String(error));
    }
    const outcome = { ...ctx.output.outcomeSince(checkpoint), keepRunning };
    ctx.output.emit("command.outcome", { command: trimmedLine.split(/\s/, 1)[0], status: outcome.status, finish_reason: outcome.finishReason });
    return outcome;
  }

  private async runSlashLine(ctx: OmrContext, trimmedLine: string): Promise<boolean> {
    const raw = trimmedLine.slice(1);
    const space = raw.search(/\s/);
    const typedName = space === -1 ? raw : raw.slice(0, space);
    const rest = space === -1 ? "" : raw.slice(space + 1).trim();
    const command: Command | undefined = findCommand(
      typedName,
      ctx.allCommands(),
    );

    if (!command) {
      ctx.output.fail(
        `unknown command /${typedName}; type / to open the command palette`,
      );
      return true;
    }
    if (command.argument === "required" && !rest) {
      ctx.output.fail(`usage: ${command.usage ?? `/${command.name}`}`);
      return true;
    }
    if (command.name === "exit") return false;

    if (command.requires?.rea || command.requires?.openTarget) {
      try {
        await ctx.ensureConnected();
        if (command.requires?.openTarget) {
          await ctx.ensureTargetOpen();
        }
      } catch {
        return true;
      }
    }

    if (command.source === "custom") {
      const spec = ctx.customCommands.find((c) => c.name === command.name);
      if (!spec) {
        ctx.output.fail(`custom command /${command.name} is no longer present`);
        return true;
      }
      if (spec.effort && !ctx.opts.noModel && ctx.modelController.modelInfo) {
        try {
          ctx.modelController.applyEffortSelection(spec.effort, false);
        } catch {
          // ignore
        }
      }
      const prompt = renderCustomCommandPrompt(spec, {
        args: rest,
        target: ctx.currentTarget,
        sessionDir: ctx.session.dir,
        cwd: ctx.cwd,
      });
      ctx.output.ui?.addUser(trimmedLine);
      await ctx.runTurn(
        prompt,
        `${spec.name}${rest ? `: ${rest}` : ""}`,
        spec.autoSavePrefix
          ? { autoSaveScriptPrefix: spec.autoSavePrefix }
          : undefined,
      );
      return true;
    }

    const handler = this.handlers.get(command.name);
    if (!handler) {
      ctx.output.fail(`no handler registered for /${command.name}`);
      return true;
    }
    await handler(ctx, rest, trimmedLine);
    return true;
  }
}
