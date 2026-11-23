import { envValue, hostHome, hostPath } from "./platform.js";

/** Desktop helpers; opening URLs/files lives in opener.ts. Clipboard text is UTF-16LE with BOM for clip.exe. */
export const windowsClipboardWrite = (text: string) => ({
  command: "clip.exe",
  args: [],
  input: Buffer.from(`\ufeff${text}`, "utf16le"),
});

const MAC_APPS: Record<string, readonly [string, string]> = {
  chromium: ["Chromium", "Chromium"], firefox: ["Firefox", "firefox"], zen: ["Zen", "zen"],
  chrome: ["Google Chrome", "Google Chrome"], brave: ["Brave Browser", "Brave Browser"],
};
const WIN_APPS: Record<string, readonly string[]> = {
  chromium: ["Chromium", "Application", "chrome.exe"], firefox: ["Mozilla Firefox", "firefox.exe"], zen: ["Zen Browser", "zen.exe"],
  chrome: ["Google", "Chrome", "Application", "chrome.exe"], brave: ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
};

export const desktopBrowserPaths = (engine: string, env = process.env, platform = process.platform,
  home = hostHome(env, platform)): string[] => {
  const { join } = hostPath(platform);
  if (platform === "darwin") {
    const app = MAC_APPS[engine];
    return app ? ["/Applications", join(home, "Applications")].map(root => join(root, `${app[0]}.app`, "Contents", "MacOS", app[1])) : [];
  }
  if (platform === "win32") {
    const app = WIN_APPS[engine];
    const roots = [envValue(env, "ProgramFiles", platform), envValue(env, "ProgramFiles(x86)", platform), envValue(env, "LOCALAPPDATA", platform)].filter((root): root is string => Boolean(root));
    return app ? [...new Set(roots)].map(root => join(root, ...app)) : [];
  }
  return [];
};
