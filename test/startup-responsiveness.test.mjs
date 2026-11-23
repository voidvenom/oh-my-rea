import assert from "node:assert/strict";
import { chmod, copyFile, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { writeSessionStore } from "../bench/startup-fixture.mjs";
import { normalizeTypedAhead } from "../dist/earlyInput.js";
import { createLazyValidatorProvider } from "../dist/lazyValidator.js";
import { loadSavedSession } from "../dist/session.js";

const posix = process.platform !== "win32";

test("typed-ahead Enter that went through the cooked tty becomes a submit; anything else is untouched", () => {
  assert.equal(normalizeTypedAhead("/help\n"), "/help\r");
  assert.equal(normalizeTypedAhead("/help\r"), "/help\r");
  assert.equal(normalizeTypedAhead("/help"), "/help");
  assert.equal(normalizeTypedAhead("line one\nline two\n"), "line one\nline two\n", "multi-line paste is never turned into submits");
  assert.equal(normalizeTypedAhead("\x1b[200~pasted\n\x1b[201~"), "\x1b[200~pasted\n\x1b[201~");
  assert.equal(normalizeTypedAhead("\n"), "\n", "a bare newline stays a newline");
});

test("lazy validator compiles a schema only when a result of that tool is first validated", () => {
  const compiled = [];
  const base = {
    getValidator: (schema) => {
      compiled.push(schema.title);
      if (schema.title === "broken") throw new Error("cannot compile ".repeat(40));
      return (input) => (typeof input === "object" && input !== null ? { valid: true, data: input, errorMessage: undefined } : { valid: false, data: undefined, errorMessage: "not an object" });
    },
  };
  const provider = createLazyValidatorProvider(base);
  const [a, b, broken] = ["a", "b", "broken"].map((title) => provider.getValidator({ title }));
  assert.deepEqual(compiled, [], "listing 200+ tools must not compile anything");
  assert.equal(a({}).valid, true);
  assert.equal(a({ again: true }).valid, true);
  assert.equal(a(1).valid, false);
  assert.deepEqual(compiled, ["a"], "compiled once, cached for later results");
  const failure = broken({});
  assert.equal(failure.valid, false);
  assert.match(failure.errorMessage, /^invalid outputSchema: cannot compile/);
  assert.ok(failure.errorMessage.length < 260);
  assert.deepEqual(compiled, ["a", "broken"], "a bad schema affects only its own tool and is not retried");
  broken({});
  assert.equal(compiled.length, 2);
  assert.equal(typeof b, "function");
});

test("REA detection searches PATH instead of running rea, and updateNotice never waits for rea --version", { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "omr-startup-test-"));
  try {
    // Load setup from a fixture checkout so its relative sibling search cannot reach the host's REA.
    const omr = join(dir, "omr");
    const dist = join(omr, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(omr, "package.json"), '{"type":"module"}');
    for (const name of ["ansi.js", "env.js", "setup.js", "reaLauncher.js", "version.js"]) {
      await copyFile(new URL(`../dist/${name}`, import.meta.url), join(dist, name));
    }
    await cp(new URL("../dist/i18n/", import.meta.url), join(dist, "i18n"), { recursive: true });
    const { detectRea, detectReaExact, ensureRea, findOnPath, updateNotice } = await import(pathToFileURL(join(dist, "setup.js")).href);
    const { resolveReaLauncher } = await import(pathToFileURL(join(dist, "reaLauncher.js")).href);

    const bin = join(dir, "bin");
    const config = join(dir, "config");
    await mkdir(bin, { recursive: true });
    await mkdir(join(config, "rea"), { recursive: true });
    const fake = join(bin, "rea");
    const marker = join(dir, "ran");
    await symlink(process.execPath, join(bin, "node"));
    // Use the fixture PATH even inside the child. A delayed version and marker expose accidental sync probes.
    await writeFile(fake, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nsetTimeout(() => console.log("rea 6.9.0"), 600);\n`);
    await chmod(fake, 0o755);
    await writeFile(join(config, "rea", "omr-update.json"), `${JSON.stringify({ checkedAt: Date.now(), latest: { "oh-my-rea": "0.0.1", "rea-agents": "7.0.0" } })}\n`);
    const env = { PATH: bin, XDG_CONFIG_HOME: config, HOME: dir };

    assert.equal(findOnPath("rea", env), fake);
    assert.equal(findOnPath("definitely-not-installed", env), undefined);
    assert.equal(findOnPath("rea", { PATH: join(dir, "empty") }), undefined);
    const envFile = join(dir, "rea-env.sh");
    await writeFile(envFile, `export OMR_REA_COMMAND=${JSON.stringify(fake)}\n`);
    assert.equal(await ensureRea({ ...env, PATH: join(dir, "empty"), REA_ENV_FILE: envFile }), null);

    assert.deepEqual(detectRea(env), { state: "ok", source: "path", version: null });
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "detectRea must not execute rea");

    const started = performance.now();
    const notice = await updateNotice(env);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 400, `updateNotice blocked for ${elapsed.toFixed(0)} ms`);
    assert.equal(notice, null, "version unknown on first sight: no notice yet, resolved in the background");

    // The background refresh records the version, so the *next* start can show the notice without spawning.
    const deadline = Date.now() + 5_000;
    let cached = null;
    while (Date.now() < deadline) {
      cached = JSON.parse(await readFile(join(config, "rea", "omr-update.json"), "utf8")).rea ?? null;
      if (cached) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(cached?.version, "6.9.0");
    assert.equal(cached?.path, fake);
    const second = performance.now();
    assert.match(await updateNotice(env) ?? "", /rea 6\.9\.0 → 7\.0\.0/);
    assert.ok(performance.now() - second < 400);
    assert.equal(detectRea(env).version, "6.9.0");
    assert.deepEqual(detectReaExact(env), { state: "ok", source: "path", version: "6.9.0" });

    const siblingScripts = join(dir, "rea", "scripts");
    const sibling = join(siblingScripts, "rea.mjs");
    await mkdir(siblingScripts, { recursive: true });
    await writeFile(sibling, 'console.log("rea 6.8.0");\n');
    assert.deepEqual(resolveReaLauncher(env), { source: "checkout", path: sibling });
    assert.deepEqual(detectRea(env), { state: "ok", source: "checkout", version: null });
    assert.equal(await updateNotice(env), null, "the cached PATH version does not describe the checkout");
    const overridden = { ...env, OMR_REA_COMMAND: fake };
    assert.deepEqual(resolveReaLauncher(overridden), { source: "env", path: fake });
    assert.equal(await updateNotice(overridden), null, "registry updates do not apply to the explicit override");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--resume only lists as many saved sessions as the query can address", async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-resume-test-"));
  try {
    const { ids } = await writeSessionStore(root, { sessions: 3, messages: 8, largeMessages: 12 });
    const newest = await loadSavedSession("last", undefined, root);
    assert.ok(newest, "last resolves");
    assert.match(newest.summary.id, /large-session$/);
    assert.equal(newest.messages.length >= 12, true);
    const second = await loadSavedSession("#2", undefined, root);
    assert.equal(second?.summary.index, 2);
    assert.equal(second?.summary.id, [...ids].sort().reverse()[1]);
    const byName = await loadSavedSession("large-session", undefined, root);
    assert.match(byName?.summary.id ?? "", /large-session$/);
    assert.equal(await loadSavedSession("#99", undefined, root), null);
    assert.equal(await loadSavedSession("#0", undefined, root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
