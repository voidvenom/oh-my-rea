import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { envValue, findOnPath, hostPath, type Invocation } from "./platform.js";

export { findOnPath } from "./platform.js";

/** npm's REA .cmd shim points to this package entry. Resolve it without invoking cmd.exe. */
export const reaInvocation = (launcher: string, args: readonly string[], platform = process.platform,
  node = process.execPath, exists = existsSync): Invocation | undefined => {
  const path = hostPath(platform);
  if (/\.(?:mjs|cjs|js)$/i.test(launcher)) return { command: node, args: [launcher, ...args] };
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(launcher)) return { command: launcher, args: [...args] };
  if (!/^rea(?:-agents)?\.cmd$/i.test(path.basename(launcher))) return undefined;
  const entry = path.join(path.dirname(launcher), "node_modules", "rea-agents", "scripts", "rea.mjs");
  return exists(entry) ? { command: node, args: [entry, ...args] } : undefined;
};

const checkoutCandidates = [
  fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
  fileURLToPath(new URL("../../rea/scripts/rea.mjs", import.meta.url)),
];

/** Setup, update checks and MCP use the same launcher order. */
export const resolveReaLauncher = (env: NodeJS.ProcessEnv) => {
  const override = envValue(env, "OMR_REA_COMMAND");
  if (override) return { path: process.platform === "win32" && !hostPath().isAbsolute(override)
    ? findOnPath(override, env) ?? override : override, source: "env" as const };
  const checkout = checkoutCandidates.find(candidate => existsSync(candidate));
  if (checkout) return { path: checkout, source: "checkout" as const };
  const installed = findOnPath("rea", env);
  return installed ? { path: installed, source: "path" as const } : undefined;
};
