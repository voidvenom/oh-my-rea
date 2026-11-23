import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const retry = (error: unknown, platform: NodeJS.Platform, attempt: number): boolean =>
  platform === "win32" && attempt < 4 && ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Keep the destination intact through transient sharing violations. Never unlink it. */
export const replaceFile = async (from: string, to: string, platform = process.platform, move = rename): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try { return await move(from, to); }
    catch (error) { if (!retry(error, platform, attempt)) throw error; await delay(10 * 2 ** attempt); }
  }
};

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const replaceFileSync = (from: string, to: string, platform = process.platform, move = renameSync, wait = pause): void => {
  for (let attempt = 0; ; attempt++) {
    try { return move(from, to); }
    catch (error) { if (!retry(error, platform, attempt)) throw error; wait(10 * 2 ** attempt); }
  }
};

// Windows does not expose a directory handle suitable for Node's open()/fsync().
export const canSyncDirectory = (platform = process.platform): boolean => platform !== "win32";
