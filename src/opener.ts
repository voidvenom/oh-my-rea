/**
 * Opens a validated link in the user's default browser or mail client via the platform opener.
 * The opener is spawned directly with the URL as a single argv entry (never through a shell),
 * detached and with stdio ignored so it can never write into the TUI.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { safeLinkUrl } from "./links.js";

export interface OpenerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The one desktop opener for omr (links and any future "open in default app" action). The target is
 * a single argv entry, never shell text: Linux `xdg-open`, macOS `/usr/bin/open` (absolute, so PATH
 * cannot substitute it), Windows `rundll32 url.dll,FileProtocolHandler` (cmd's `start` would re-parse
 * `&`, `|` and `^`). Targets that look like options or carry control characters are refused.
 */
export const openerCommand = (target: string, platform: NodeJS.Platform = process.platform): OpenerCommand | undefined => {
  if (!target || target.startsWith("-") || /[\x00-\x1f\x7f]/.test(target)) return undefined;
  if (platform === "darwin") return { command: "/usr/bin/open", args: [target] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target] };
  return { command: "xdg-open", args: [target] };
};

export type OpenResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: "invalid" | "failed"; readonly url?: string };

export interface OpenUrlOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/** Validates `raw` against the http/https/mailto allow-list and launches the opener; never throws. */
export const openUrl = (raw: string, options: OpenUrlOptions = {}): Promise<OpenResult> => {
  const url = safeLinkUrl(raw);
  if (!url) return Promise.resolve({ ok: false, reason: "invalid" });
  const invocation = openerCommand(url, options.platform);
  if (!invocation) return Promise.resolve({ ok: false, reason: "invalid" });
  const { command, args } = invocation;
  const launch = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = launch(command, [...args], {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        env: options.env ?? process.env,
      });
    } catch {
      resolve({ ok: false, reason: "failed", url });
      return;
    }
    child.once("error", () => resolve({ ok: false, reason: "failed", url }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true, url });
    });
  });
};
