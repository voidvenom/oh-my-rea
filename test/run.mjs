import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";

const root = await mkdtemp(join(tmpdir(), "omr-unit-"));
try {
  const testDir = new URL("./", import.meta.url);
  const tests = (await readdir(testDir))
    .filter(name => name.endsWith(".test.mjs"))
    .sort()
    .map(name => fileURLToPath(new URL(name, testDir)));
  if (tests.length === 0) throw new Error("No unit tests found");

  const env = {
    ...fixtureEnvironment(),
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    DOCKER_HOST: `unix://${join(root, "docker.sock")}`,
    PATH: (process.platform === "win32"
      ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
      : [dirname(process.execPath), "/usr/bin", "/bin", "/usr/local/bin"]
    ).join(delimiter),
  };
  const guard = fileURLToPath(new URL("fixtures/unit-network.mjs", testDir));
  const child = spawn(process.execPath, ["--import", guard, "--test", ...tests], {
    cwd: fileURLToPath(new URL("../", testDir)), env, stdio: "inherit",
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
