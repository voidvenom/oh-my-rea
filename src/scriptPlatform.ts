import { findOnPath, envValue, hostPath } from "./platform.js";

const extensions = [".mjs", ".cjs", ".py", ".sh", ".ps1", ".yar", ".yara"] as const;

export const interpreterFor = (file: string, env = process.env, platform = process.platform,
  node = process.execPath, lookup = findOnPath): { command: string; leadingArgs: string[] } | { ok: false; error: string } => {
  const ext = hostPath(platform).extname(file).toLowerCase();
  const win = platform === "win32";
  if (ext === ".mjs" || ext === ".cjs") return { command: node, leadingArgs: [] };
  if (ext === ".js") return { ok: false, error: "`.js` files in the session are Frida scripts. Save plain Node code as `.mjs`/`.cjs` to run it here." };
  const names: Record<string, string[]> = {
    ".py": win ? ["python3", "py", "python"] : ["python3"],
    ".sh": ["bash"], ".ps1": win ? ["pwsh", "powershell"] : ["pwsh"],
    ".yar": ["yara"], ".yara": ["yara"],
  };
  const candidates = names[ext];
  if (!candidates) return { ok: false, error: `No interpreter mapped for ${ext || file}. Supported: ${extensions.join(", ")}.` };
  for (const name of candidates) {
    const command = lookup(name, env, platform, undefined, true);
    // WindowsApps Python aliases are often Store launchers rather than interpreters.
    if (!command || win && /\\WindowsApps\\/i.test(command) && /^python/i.test(name)) continue;
    const leadingArgs = ext === ".py" ? [...(name === "py" ? ["-3"] : []), "-B", "-u"]
      : ext === ".ps1" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]
      : ext === ".yar" || ext === ".yara" ? ["-w"] : [];
    return { command, leadingArgs };
  }
  return { ok: false, error: `No interpreter for ${ext} on ${platform}; add ${candidates.join(" or ")} to PATH, or use .mjs/.cjs with Node.` };
};

export const scriptInterpreterSummary = (env = process.env, platform = process.platform, lookup = findOnPath): string => {
  const candidates = [".py", ".sh", ".ps1", ".yar"];
  return `${platform} script runtimes: .mjs/.cjs (Node), ${candidates.map(ext => {
    const result = interpreterFor(`script${ext}`, env, platform, process.execPath, lookup);
    return `${ext} (${"error" in result ? "unavailable" : hostPath(platform).basename(result.command)})`;
  }).join(", ")}.`;
};

export const operatorShell = (command: string, env = process.env, platform = process.platform) => {
  if (platform !== "win32") return { command: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
  const cmd = envValue(env, "ComSpec", platform) || "cmd.exe";
  // The entire string is intentionally operator-authored shell source. No other arguments are interpolated into it.
  return { command: cmd, args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
};

export const supportsNetworkNamespace = (platform = process.platform): boolean => platform === "linux";
