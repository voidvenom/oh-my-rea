import { execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { envValue } from "./platform.js";

export const windowsTreeKill = (pid: number, env = process.env) => ({
  command: win32.join(envValue(env, "SystemRoot", "win32") || "C:\\Windows", "System32", "taskkill.exe"),
  args: ["/pid", String(pid), "/t", "/f"],
});

const terminateWindowsTree = (pid: number, child?: ChildProcess): Promise<void> => {
  if (child && (child.exitCode !== null || child.signalCode !== null)) return Promise.resolve();
  const { command, args } = windowsTreeKill(pid);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(command, args, { timeout: 3_000, windowsHide: true }, (error) => {
    try {
      if (error && (!child || (child.exitCode === null && child.signalCode === null))) signalOwnedProcess(pid, false, "SIGKILL");
      resolve();
    } catch (failure) { reject(failure); }
  });
  return promise;
};

/** Linux setsid executes the SDK-spawned peer in its own process group, without a shell. */
export const sessionLauncher = (): string | null => {
  if (process.platform !== "linux") return null;
  for (const path of ["/usr/bin/setsid", "/bin/setsid"]) try { accessSync(path, constants.X_OK); return path; } catch { /* optional host capability */ }
  return null;
};
export const ownsProcessGroup = (pid: number): boolean => {
  if (process.platform !== "linux") return false;
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return Number(fields[2]) === pid; } catch { return false; }
};
export const signalOwnedProcess = (pid: number | null | undefined, group: boolean, signal: NodeJS.Signals): void => {
  if (!pid) return;
  try { process.kill(group && process.platform !== "win32" ? -pid : pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
};
/** Group identity is captured while the owned child is live; descendants remain owned after parent exit. */
export const terminateOwnedProcess = async (pid: number | null | undefined, group: boolean, child?: ChildProcess, graceMs = 600): Promise<void> => {
  if (!pid) return;
  if (process.platform === "win32") return terminateWindowsTree(pid, child);
  if (graceMs <= 0) { signalOwnedProcess(pid, group, "SIGKILL"); return; }
  signalOwnedProcess(pid, group, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!group && child && (child.exitCode !== null || child.signalCode !== null)) break;
    try { process.kill(group ? -pid : pid, 0); } catch { break; }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  signalOwnedProcess(pid, group, "SIGKILL");
};
