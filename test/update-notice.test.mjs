import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { whatsNew } from "../dist/changelog.js";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";

const ptyProbe = fileURLToPath(new URL("../bench/pty-probe.py", import.meta.url));

test("every PTY launch checks a (mock) registry in the background and shows the update box in the same session", {
  skip: process.platform === "win32" && "Python pty.fork requires POSIX; native Windows uses ConPTY",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-notice-"));
  // Mock npm registry: `npm_config_registry` points omr here instead of registry.npmjs.org.
  let latest = "0.6.0";
  let failing = false;
  const calls = [];
  const registry = createServer((request, response) => {
    calls.push(request.url);
    setTimeout(() => {
      if (failing) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: request.url.includes("oh-my-rea") ? latest : "9.0.0" }));
    }, 300);
  });
  await new Promise((ready) => registry.listen(0, "127.0.0.1", ready));
  try {
    const config = join(root, "config");
    const cache = join(config, "rea", "omr-update.json");
    const preload = join(root, "preload.mjs");
    const dist = join(root, "dist");
    await cp(new URL("../dist/", import.meta.url), dist, { recursive: true });
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(dist, "version.js"), 'export const VERSION = "0.5.1";\n');
    // A slow cache read must not hold the first paint or the first command.
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
    `);
    const env = {
      ...fixtureEnvironment(), HOME: root, XDG_CONFIG_HOME: config, OMR_SESSIONS_DIR: join(root, "sessions"),
      OMR_SKIP_SETUP: "1", OMR_REA_COMMAND: join(root, "missing-rea"), NO_COLOR: "1",
      npm_config_registry: `http://127.0.0.1:${registry.address().port}/`,
    };
    const body = (version) => `New version ${version} of omr is available (installed 0.5.1).`;
    const probe = async (options, overrides = {}) => {
      const { stdout } = await promisify(execFile)("python3", [
        ptyProbe, "--after-alt", "--timeout", "4",
        "--mark", "help=GUIDED WORKFLOWS", "--mark", "box=Update Available",
        "--mark", `v060=${body("0.6.0")}`, "--mark", `v061=${body("0.6.1")}`, "--mark", "run=Run: omr update",
        ...options,
        "--", process.execPath, "--import", pathToFileURL(preload).href, join(dist, "main.js"), "--no-model",
      ], { cwd: root, env: { ...env, ...overrides }, timeout: 9000 });
      return JSON.parse(stdout);
    };

    // 1. Empty cache: the first command is not held, and the box appears in this same session.
    const first = await probe(["--type", "/help\r", "--stop-on", "v060"]);
    assert.ok(first.altScreenMs !== null && first.marks.help !== null, JSON.stringify(first));
    assert.ok(first.marks.help - first.altScreenMs < 600, "the slow cache read did not hold the first command");
    assert.ok(first.marks.box !== null && first.marks.v060 !== null && first.marks.run !== null, JSON.stringify(first));
    assert.ok(first.marks.box > first.altScreenMs, "the notice arrives after the first paint");
    assert.deepEqual(calls.splice(0).sort(), ["/oh-my-rea/latest", "/rea-agents/latest"]);
    const primed = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(primed.latest["oh-my-rea"], "0.6.0");

    // 2. A relaunch within the 60 s guard shows the cached box without asking the registry again.
    const second = await probe(["--stop-on", "v060"]);
    assert.ok(second.marks.v060 !== null, JSON.stringify(second));
    assert.deepEqual(calls, [], "the min-interval guard skipped the registry");

    // 3. Past the guard: the cached box shows first, then the live result replaces it in place.
    await writeFile(cache, JSON.stringify({ ...primed, checkedAt: Date.now() - 2 * 60_000 }));
    latest = "0.6.1";
    const third = await probe(["--stop-on", "v061"]);
    assert.ok(third.marks.v060 !== null && third.marks.v061 !== null, JSON.stringify(third));
    assert.ok(third.marks.v060 < third.marks.v061, "cached result first, live result second");
    assert.equal(calls.splice(0).length, 2);

    // 4. Registry failures are silent: no box, no error, commands still run.
    await rm(cache);
    failing = true;
    const offline = await probe(["--timeout", "2", "--type", "/help\r"]);
    assert.ok(offline.marks.help !== null);
    assert.equal(offline.marks.box, null);
    assert.equal(calls.splice(0).length, 2);
    failing = false;

    // 5. Opt-outs never touch the registry.
    for (const overrides of [{ OMR_NO_UPDATE_CHECK: "1" }, { CI: "true" }]) {
      await rm(cache, { force: true });
      const disabled = await probe(["--timeout", "1.5", "--type", "/help\r"], overrides);
      assert.ok(disabled.marks.help !== null);
      assert.equal(disabled.marks.box, null);
      assert.deepEqual(calls, []);
    }
  } finally {
    registry.close();
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

test("the TUI update box is updated in place, leads the splash notices and follows the language", async () => {
  const { TerminalUi } = await import("../dist/tui.js");
  const { I18n } = await import("../dist/i18n/index.js");
  const { createTheme, stripAnsi, visibleWidth } = await import("../dist/ansi.js");
  const i18n = new I18n();
  await i18n.switchTo("en");
  const ui = new TerminalUi({ i18n, theme: createTheme({ TERM: "xterm-256color" }), commands: [], onSubmit() {}, onInterrupt() {}, onExit() {} });
  ui.addSystem("What's new in 0.7.0", true);
  ui.showUpdate({ packages: [{ name: "omr", installed: "0.7.0", latest: "0.7.1" }] });
  ui.showUpdate({ packages: [{ name: "omr", installed: "0.7.0", latest: "0.7.2" }, { name: "rea", installed: "6.9.0", latest: "7.0.0" }] });
  let frame = ui.renderFrame(120, 40).lines;
  let screen = frame.map(stripAnsi).join("\n");
  assert.equal(screen.split("Update Available").length - 1, 1, "one box, replaced in place");
  assert.ok(!screen.includes("0.7.1"));
  assert.match(screen, /New version 0\.7\.2 of omr is available \(installed 0\.7\.0\)\./);
  assert.match(screen, /New version 7\.0\.0 of rea is available \(installed 6\.9\.0\)\./);
  assert.match(screen, /Run: omr update · \/changelog/);
  assert.ok(screen.indexOf("Update Available") < screen.indexOf("What's new"), "the box comes first on the splash");
  assert.ok(screen.includes("██████"), "the splash stays visible");
  assert.ok(frame.every((line) => visibleWidth(line) <= 120));
  await i18n.switchTo("tr");
  screen = ui.renderFrame(120, 40).lines.map(stripAnsi).join("\n");
  assert.match(screen, /Güncelleme Mevcut/);
  assert.match(screen, /omr için yeni sürüm 0\.7\.2 mevcut \(kurulu: 0\.7\.0\)\./);
  assert.match(screen, /Çalıştırın: omr update/);
  ui.addUser("merhaba");
  ui.showUpdate({ packages: [{ name: "omr", installed: "0.7.0", latest: "0.8.0" }] });
  frame = ui.renderFrame(120, 40).lines;
  screen = frame.map(stripAnsi).join("\n");
  assert.equal(screen.split("Güncelleme Mevcut").length - 1, 1);
  assert.match(screen, /0\.8\.0/);
});
