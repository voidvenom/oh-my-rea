#!/usr/bin/env node
import { LanguageArgumentError, MissingArgumentError, parseArgs, type LaunchOptions } from "./args.js";
import { beginEarlyInput, releaseEarlyInput } from "./earlyInput.js";
import { resolveReaEnv } from "./env.js";
import { I18n } from "./i18n/index.js";
import { SUPPORT_URL } from "./support.js";
import { VERSION } from "./version.js";

const main = async (): Promise<number> => {
  const i18n = new I18n();
  const t = i18n.t;
  let opts: LaunchOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (error) {
    await i18n.initialize(undefined, process.env, process.argv.includes("--json"));
    const message = error instanceof LanguageArgumentError ? t("language.argument")
      : error instanceof MissingArgumentError ? t("common.argument", { flag: error.flag })
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`${t("common.error", { message })}\n`);
    return 2;
  }

  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const languageReady = () => i18n.initialize(opts.lang, process.env, opts.json);
  if (opts.help) {
    const [{ helpText }, { modelConfigPath }, { SCHEMA_VERSION }] =
      await Promise.all([import("./commands.js"), import("./modelConfig.js"), import("./render.js"), languageReady()]);
    const footer = opts.json ? "" : `\n${t("support.cta", { url: SUPPORT_URL })}\n`;
    process.stdout.write(`${t("cli.help", { version: VERSION, schema: SCHEMA_VERSION, config: modelConfigPath() })}\n\n${helpText([], i18n)}\n${footer}`);
    return 0;
  }

  if (opts.subcommand) {
    const { name, args } = opts.subcommand;
    await languageReady();
    if (name === "changelog") {
      const { changelogText, changelogError, noChangelogSection } = await import("./changelog.js");
      if (args.length > 1) {
        process.stderr.write(`${t("changelog.usage")}\n`);
        return 2;
      }
      const selection = args[0] ?? VERSION;
      try {
        const notes = await changelogText(selection);
        if (notes) {
          process.stdout.write(`${notes}\n`);
          return 0;
        }
        process.stderr.write(`${noChangelogSection(i18n, selection)}\n`);
      } catch (error) {
        process.stderr.write(`${changelogError(i18n, error)}\n`);
      }
      return 1;
    }
    const setup = await import("./setup.js");
    const { env } = resolveReaEnv();
    return name === "setup" ? setup.runSetup(env, i18n) : setup.runUpdate(env, i18n);
  }

  const wantsTui = !opts.plain && !opts.json && !opts.command && !opts.goal && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const setup = await import("./setup.js");
  const stop = await setup.ensureRea(process.env, async () => { await languageReady(); return i18n; });
  if (stop !== null) return stop;
  if (!wantsTui && !opts.json && process.stdout.isTTY) {
    const notices = languageReady().then(() =>
      setup.announceRelease(resolveReaEnv().env, (notice) => process.stderr.write(`${notice(i18n.t)}\n`)),
    ).catch(() => {});
    if (opts.command || opts.goal) await notices;
  }

  // The interactive TUI will own the keyboard once it starts; capture keystrokes from now on so a command
  // typed while the runtime loads is replayed into it instead of arriving as a cooked `\n`.
  if (wantsTui) beginEarlyInput();
  try {
    const { runOmr } = await import("./runtime.js");
    return await runOmr(opts, undefined, i18n);
  } catch (error) {
    releaseEarlyInput();
    throw error;
  }
};

const code = await main();
process.exit(code);
