import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canSyncDirectory, replaceFile } from "./platformFs.js";

/** Publish a complete private JSON file without truncating the previous version. */
export const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const staging = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(staging, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close(); handle = undefined;
    await replaceFile(staging, path);
    if (canSyncDirectory()) {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(staging).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
};
