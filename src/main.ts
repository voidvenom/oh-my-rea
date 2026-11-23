#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, type LaunchOptions } from "./args.js";
import { beginEarlyInput, releaseEarlyInput } from "./earlyInput.js";
import { VERSION } from "./version.js";

const main = async (): Promise<number> => {
  // `omr setup` / `omr update` are subcommands unless a file with that name exists (then it is a target).
  const sub = process.argv[2];
  if ((sub === "setup" || sub === "update") && process.argv.length === 3 && !existsSync(sub)) {
    const setup = await import("./setup.js");
    return sub === "setup" ? setup.runSetup() : setup.runUpdate();
  }

  let opts: LaunchOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    return 2;
  }

  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (opts.help) {
    const [{ helpText }, { modelConfigPath }, { SCHEMA_VERSION }] =
      await Promise.all([
        import("./commands.js"),
        import("./modelConfig.js"),
        import("./render.js"),
      ]);
    process.stdout.write(
      `omr ${VERSION} — an evidence-first reverse-engineering agent powered by REA\n\n` +
        `Usage:\n` +
        `  omr                          interactive TUI (auto-detects single target in cwd)\n` +
        `  omr <target>                 bind target, launch interactive TUI\n` +
        `  omr <target> "<goal>"        one-shot bounded investigation\n` +
        `  omr /<command> [args]        one-shot slash command\n` +
        `  omr setup                    check the environment and install REA (asks first)\n` +
        `  omr update                   update omr and REA to the latest npm release\n\n` +
        `Flags:\n` +
        `  --json             versioned JSONL events (${SCHEMA_VERSION})\n` +
        `  --plain            plain line REPL / output (no alternate screen)\n` +
        `  --no-model         deterministic REA commands only\n` +
        `  --model <id>       override configured model id\n` +
        `  --profile <name>   activate analyst profile (recon|malware|vuln|crypto|frida|android|firmware|web)\n` +
        `  --resume[=<id>]    restore the last (or given) saved session; continues an interrupted turn automatically\n` +
        `  --dashboard        serve loopback live session dashboard (127.0.0.1)\n\n` +
        `Model config: ${modelConfigPath()}\n\n${helpText()}\n`,
    );
    return 0;
  }

  const wantsTui = !opts.plain && !opts.json && !opts.command && !opts.goal && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const setup = await import("./setup.js");
  const stop = await setup.ensureRea();
  if (stop !== null) return stop;
  if (!wantsTui && !opts.json && process.stdout.isTTY) {
    const notice = setup.updateNotice();
    if (notice) process.stderr.write(`\x1b[2m${notice}\x1b[0m\n`);
  }

  // The interactive TUI will own the keyboard once it starts; capture keystrokes from now on so a command
  // typed while the runtime loads is replayed into it instead of arriving as a cooked `\n`.
  if (wantsTui) beginEarlyInput();
  try {
    const { runOmr } = await import("./runtime.js");
    return await runOmr(opts);
  } catch (error) {
    releaseEarlyInput();
    throw error;
  }
};

const code = await main();
process.exit(code);
