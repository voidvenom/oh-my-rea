import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Search PATH without executing the program. */
export const findOnPath = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const extensions = process.platform === "win32" ? ["", ...(env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = resolve(dir, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep walking PATH.
      }
    }
  }
  return undefined;
};

const checkoutCandidates = [
  fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
  fileURLToPath(new URL("../../rea/scripts/rea.mjs", import.meta.url)),
];

/** Setup, update checks and MCP use the same launcher order. */
export const resolveReaLauncher = (env: NodeJS.ProcessEnv) => {
  const override = env["OMR_REA_COMMAND"];
  if (override) return { path: override, source: "env" as const };
  const checkout = checkoutCandidates.find(candidate => existsSync(candidate));
  if (checkout) return { path: checkout, source: "checkout" as const };
  const installed = findOnPath("rea", env);
  return installed ? { path: installed, source: "path" as const } : undefined;
};
