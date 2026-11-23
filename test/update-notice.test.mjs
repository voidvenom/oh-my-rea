import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { whatsNew } from "../dist/changelog.js";

test("PTY startup accepts typed-ahead Enter during a slow update check, and 0.5.1 sees 0.6.0 on the next start", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-notice-"));
  try {
    const config = join(root, "config");
    const cache = join(config, "rea", "omr-update.json");
    const calls = join(root, "registry-calls");
    const preload = join(root, "preload.mjs");
    const dist = join(root, "dist");
    await cp(new URL("../dist/", import.meta.url), dist, { recursive: true });
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(dist, "version.js"), 'export const VERSION = "0.5.1";\n');
    await writeFile(preload, `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { setTimeout } from "node:timers/promises";
      const read = fs.readFile;
      fs.readFile = async (path, ...args) => {
        if (String(path) === ${JSON.stringify(cache)}) await setTimeout(600);
        return read(path, ...args);
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        if (url.origin !== "https://registry.npmjs.org") throw new Error("unexpected request");
        await setTimeout(300);
        await fs.appendFile(${JSON.stringify(calls)}, url.pathname + "\\n");
        return Response.json({ version: url.pathname.includes("oh-my-rea") ? "0.6.0" : "9.0.0" });
      };
    `);
    const env = {
      ...process.env, XDG_CONFIG_HOME: config, OMR_SESSIONS_DIR: join(root, "sessions"),
      OMR_SKIP_SETUP: "1", OMR_REA_COMMAND: join(root, "missing-rea"),
    };
    const notice = "Update available: omr 0.5.1 → 0.6.0";
    const probe = async (options, overrides = {}) => {
      const { stdout } = await promisify(execFile)("python3", [
        resolve("bench/pty-probe.py"), "--after-alt", "--timeout", "3",
        "--mark", "help=GUIDED WORKFLOWS", "--mark", `notice=${notice}`, ...options,
        "--", process.execPath, "--import", preload, join(dist, "main.js"), "--no-model",
      ], { cwd: root, env: { ...env, ...overrides }, timeout: 8000 });
      return JSON.parse(stdout);
    };

    const first = await probe(["--type", "/help\r"]);
    assert.ok(first.altScreenMs !== null && first.marks.help !== null);
    assert.equal(first.marks.notice, null);
    assert.equal(JSON.parse(await readFile(cache, "utf8")).latest["oh-my-rea"], "0.6.0");
    assert.ok(first.marks.help - first.altScreenMs < 600, "the slow cache read did not hold the first command");

    const second = await probe(["--stop-on", "notice"]);
    assert.ok(second.marks.notice !== null);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").sort(), [
      "/oh-my-rea/latest", "/rea-agents/latest",
    ]);
    for (const overrides of [{ OMR_NO_UPDATE_CHECK: "1" }, { CI: "true" }]) {
      const disabled = await probe(["--timeout", "1.3", "--type", "/help\r"], overrides);
      assert.ok(disabled.marks.help !== null);
      assert.equal(disabled.marks.notice, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed summary is claimed once per version, including concurrent starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-notes-"));
  try {
    const file = join(root, "CHANGELOG.md");
    const env = { XDG_CONFIG_HOME: join(root, "config") };
    await mkdir(env.XDG_CONFIG_HOME);
    await writeFile(file, "# Changelog\n\n## [0.6.0]\n\n### Fixed\n\n- First paint.\n");
    const notes = await Promise.all([whatsNew(env, "0.6.0", file), whatsNew(env, "0.6.0", file)]);
    assert.deepEqual(notes.filter(Boolean), ["What's new in 0.6.0\n- First paint.\nSee /changelog or `omr changelog 0.6.0`."]);
    assert.equal(await whatsNew(env, "0.6.0", file), null);
    assert.equal(await whatsNew(env, "0.5.1", file), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
