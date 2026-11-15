import { existsSync } from "node:fs";
import { findCommand } from "./commands.js";

export interface LaunchOptions {
  target: string | null;
  goal: string | null;
  command: string | null;
  json: boolean;
  plain: boolean;
  noModel: boolean;
  help: boolean;
  version: boolean;
  model: string | null;
  profile: string | null;
  dashboard: boolean;
  /** `--resume` (last session) or `--resume=<id|prefix|target>`; null when not requested. */
  resume: string | null;
}

const VALUE_FLAGS: Record<string, "model" | "profile"> = {
  "--model": "model",
  "--profile": "profile",
  "-p": "profile",
};

const isSlashCommand = (value: string): boolean => {
  if (value.length <= 1 || !value.startsWith("/")) return false;
  const head = value.slice(1).split(/\s+/)[0] ?? "";
  if (findCommand(head)) return true;
  if (value.includes("/", 1) || value.includes(".")) return false;
  return !existsSync(value);
};

export const parseArgs = (argv: string[]): LaunchOptions => {
  const args = argv.slice(2);
  const opts: LaunchOptions = {
    target: null,
    goal: null,
    command: null,
    json: false,
    plain: false,
    noModel: false,
    help: false,
    version: false,
    model: null,
    profile: null,
    dashboard: false,
    resume: null,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--plain") opts.plain = true;
    else if (arg === "--no-model") opts.noModel = true;
    else if (arg === "--dashboard") opts.dashboard = true;
    else if (arg === "--resume") opts.resume = "last";
    else if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      if (!value) throw new Error("--resume requires a value");
      opts.resume = value;
    } else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
    else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (!value) throw new Error("--model requires a value");
      opts.model = value;
    } else if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length).trim();
      if (!value) throw new Error("--profile requires a value");
      opts.profile = value;
    } else if (VALUE_FLAGS[arg]) {
      const field = VALUE_FLAGS[arg]!;
      const value = args[index + 1];
      if (value === undefined || value.trim() === "")
        throw new Error(`${arg} requires a value`);
      opts[field] = value.trim();
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length === 0) return opts;

  const first = positional[0]!;
  if (isSlashCommand(first)) {
    opts.command = positional.join(" ");
    return opts;
  }
  opts.target = first;
  if (positional.length > 1) {
    if (isSlashCommand(positional[1]!))
      opts.command = positional.slice(1).join(" ");
    else opts.goal = positional.slice(1).join(" ");
  }
  return opts;
};
