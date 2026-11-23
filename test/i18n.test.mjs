import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { padEndAnsi, stripAnsi, truncateAnsi, visibleWidth } from "../dist/ansi.js";
import { COMMANDS } from "../dist/commands.js";
import { en } from "../dist/i18n/en.js";
import { tr } from "../dist/i18n/tr.js";
import { I18n } from "../dist/i18n/index.js";
import { REASONING_EFFORT_LEVELS } from "../dist/modelConfig.js";
import { systemPrompt } from "../dist/prompts/system.js";
import { VERSION } from "../dist/version.js";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";

const cli = fileURLToPath(new URL("../bin/omr.js", import.meta.url));
const source = fileURLToPath(new URL("../src/", import.meta.url));
const ptyProbe = fileURLToPath(new URL("../bench/pty-probe.py", import.meta.url));
const run = promisify(execFile);

test("English and Turkish catalogs have the same referenced keys and formatting fields", async () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(tr).sort());
  const fields = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim() && tr[key].trim(), key);
    assert.deepEqual(fields(en[key]), fields(tr[key]), key);
  }
  const dynamicKeys = [
    ...COMMANDS.map(({ name }) => `command.${name}`),
    ...COMMANDS.flatMap(({ name, paletteArgs }) => (paletteArgs ?? [])
      .filter(({ id }) => name !== "spawn" || id === "--bg")
      .map(({ id }) => `argument.${name}.${id}`)),
    ...REASONING_EFFORT_LEVELS.map(({ id }) => `effort.${id}`),
  ];
  for (const key of dynamicKeys) assert.ok(Object.hasOwn(en, key), `Missing catalog key ${key}`);
  const paths = (await readdir(source, { recursive: true })).filter((path) =>
    path.endsWith(".ts") && !/^i18n[/\\](?:en|tr)\.ts$/.test(path));
  const code = (await Promise.all(paths.map((path) => readFile(join(source, path), "utf8")))).join("\n");
  for (const key of Object.keys(en)) {
    assert.ok(dynamicKeys.includes(key) || code.includes(JSON.stringify(key)), `Unused catalog key ${key}`);
  }
});

test("language precedence, switching, Turkish casing and terminal display width", async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-locale-"));
  try {
    const config = join(root, "rea", "omr-model.json");
    await mkdir(join(root, "rea"));
    await writeFile(config, '{"language":"en"}');
    const language = async (flag, env) => {
      const i18n = new I18n();
      await i18n.initialize(flag, { XDG_CONFIG_HOME: root, ...env });
      return i18n;
    };
    assert.equal((await language("tr", { OMR_LANG: "en", LANG: "en_US.UTF-8" })).language, "tr");
    assert.equal((await language(undefined, { OMR_LANG: "tr", LANG: "en_US.UTF-8" })).language, "tr");
    assert.equal((await language(undefined, { LANG: "tr_TR.UTF-8" })).language, "en");
    await rm(config);
    assert.equal((await language(undefined, { LANG: "tr_TR.UTF-8", LC_MESSAGES: "en_US" })).language, "en");
    assert.equal((await language(undefined, { LANG: "en_US", LC_MESSAGES: "en_US", LC_ALL: "tr_TR" })).language, "tr");
    assert.equal((await language(undefined, { LC_MESSAGES: "tr_TR", LANG: "en_US" })).language, "tr");
    const i18n = await language(undefined, { LANG: "C.UTF-8" });
    assert.equal(i18n.language, "en");
    await i18n.switchTo("tr");
    assert.equal(i18n.upper("iz ışık şğöüç"), "İZ IŞIK ŞĞÖÜÇ");
    assert.equal(i18n.lower("İZ IŞIK"), "iz ışık");
    assert.equal(visibleWidth("şğıİöüç"), 7);
    assert.equal(padEndAnsi("ışık", 6), "ışık  ");
    assert.equal(truncateAnsi("İşaret", 5), "İşar…");
    const prompt = systemPrompt({
      target: "/tmp/ışık", sessionDir: "/tmp/oturum", journalPath: "/tmp/journal",
      directTools: ["binary_session"], answerLanguage: i18n.answerLanguage,
    });
    assert.match(prompt, /Answer in Turkish and keep code, paths, Evidence IDs and commands verbatim/);
    assert.match(prompt, /Epistemic Contract/);
    assert.ok(prompt.includes("/tmp/ışık") && prompt.includes("binary_session"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI loads only its selected catalog, saves language additively and preserves JSONL errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-lang-cli-"));
  try {
    const config = join(root, "config", "rea", "omr-model.json");
    const previous = '{"language":"en","opaque_setting":17}\n';
    const loader = join(root, "catalog-hook.mjs");
    await mkdir(join(root, "config", "rea"), { recursive: true });
    await writeFile(config, previous);
    await writeFile(loader, `
      import { registerHooks } from "node:module";
      registerHooks({
        load(url, context, next) {
          const catalog = ["en", "tr"].find((name) => url.endsWith("/i18n/" + name + ".js"));
          if (catalog) process.stderr.write("catalog: " + catalog + "\\n");
          return next(url, context);
        },
      });
    `);
    const invoke = (args, extra = [], language = "en") => {
      const env = { ...fixtureEnvironment(language), HOME: root, USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, "config"), OMR_SESSIONS_DIR: join(root, "sessions"),
        OMR_SKIP_SETUP: "1", OMR_NO_UPDATE_CHECK: "1" };
      if (language === null) delete env.OMR_LANG; // Exercise the saved setting rather than an override.
      return run(process.execPath, [...extra, cli, ...args], { cwd: root, env });
    };
    const preload = ["--import", pathToFileURL(loader).href];
    const help = await invoke(["--lang", "tr", "--help"], preload);
    assert.equal(help.stderr, "catalog: tr\n");
    assert.match(help.stdout, /Kullanım:/);
    assert.match(help.stdout, /\/lang \[en\|tr\].*Kayıtlı arayüz dilini göster veya değiştir/);
    assert.doesNotMatch(help.stdout, /\/lang \[en\|tr\] \[--save\]/);
    assert.match(help.stdout.trimEnd(), /omr’ı destekle: https:\/\/buymeacoffee\.com\/omrdev$/);
    const englishHelp = await invoke(["--lang", "en", "--help"]);
    assert.match(englishHelp.stdout.trimEnd(), /Support omr: https:\/\/buymeacoffee\.com\/omrdev$/);
    assert.doesNotMatch((await invoke(["--help", "--json"])).stdout, /buymeacoffee/);
    assert.doesNotMatch((await invoke(["--no-model", "/help"])).stdout, /buymeacoffee/);
    assert.equal(await readFile(config, "utf8"), previous);
    const switched = await invoke(["--no-model", "/language", "tr", "--save"]);
    assert.match(switched.stdout, /Dil: tr \(Türkçe\)/);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { language: "tr", opaque_setting: 17 });
    assert.equal(await readFile(`${config}.bak`, "utf8"), previous);
    assert.match((await invoke(["--help"], [], null)).stdout, /Kullanım:/);
    assert.match((await invoke(["--help", "--lang=en"], [], "tr")).stdout, /Usage:/);
    const missing = (lang) => invoke(["--json", "--no-model", "/missing-command"], preload, lang)
      .then(() => assert.fail("unknown command must fail"), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, "catalog: en\n");
        return error.stdout.trim().split("\n").map(JSON.parse).map((event) =>
          event.session_dir ? { ...event, session_dir: "<session>" } : event);
      });
    const expected = [
      { schema: "omr-events/v1", type: "session.start", session_dir: "<session>", target: null, model: "no-model", profile: null },
      { schema: "omr-events/v1", type: "error", message: "unknown command /missing-command; type / to open the command palette" },
      { schema: "omr-events/v1", type: "command.outcome", command: "/missing-command", status: "failed", finish_reason: null },
      { schema: "omr-events/v1", type: "session.end", outcome: "failed", session_dir: "<session>" },
    ];
    assert.deepEqual(await missing("tr"), expected);
    assert.deepEqual(await missing("en"), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Turkish-locale PTY paints its splash immediately and /lang persists across restarts", {
  skip: process.platform === "win32" && "Python pty.fork requires POSIX; native Windows uses ConPTY",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-lang-pty-"));
  try {
    const env = {
      ...fixtureEnvironment(), HOME: root, LANG: "tr_TR.UTF-8", LC_ALL: "", LC_MESSAGES: "",
      XDG_CONFIG_HOME: join(root, "config"), OMR_SESSIONS_DIR: join(root, "sessions"),
      OMR_SKIP_SETUP: "1", OMR_NO_UPDATE_CHECK: "1", OMR_REA_COMMAND: join(root, "missing-rea"),
      TERM: "xterm-256color", NO_COLOR: "1",
    };
    delete env.OMR_LANG;
    const dump = join(root, "pty.log");
    const probe = async (command, expected, args = [], overrides = {}) => {
      const { stdout } = await run("python3", [
        ptyProbe, "--after-alt", "--timeout", "5", "--type", `${command}\r`,
        "--dump", dump,
        "--mark", `result=${expected}`, "--stop-on", "result",
        "--", process.execPath, cli, "--no-model", ...args,
      ], { cwd: root, env: { ...env, ...overrides }, timeout: 10_000 });
      const result = JSON.parse(stdout);
      assert.notEqual(result.altScreenMs, null, stdout);
      assert.notEqual(result.marks.result, null, `${command}: expected ${expected}\n${stdout}`);
    };

    await probe("/lang", "Dil: tr (Türkçe)");
    const firstFrame = (await readFile(dump, "utf8")).split("\x1b[?2026l", 1)[0];
    assert.match(firstFrame, /██████/);
    assert.ok(firstFrame.includes("\x1b]8;;https://buymeacoffee.com/omrdev\x07"));
    assert.match(firstFrame, /\/lang en · \/lang tr/);

    const configPath = join(env.XDG_CONFIG_HOME, "rea", "omr-model.json");
    await probe("/lang en", "Saved to ");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).language, "en");
    await probe("/lang", "Language: en (English)");
    await probe("/lang", "Dil: tr (Türkçe)", ["--lang", "tr"]);
    await probe("/lang", "Dil: tr (Türkçe)", [], { OMR_LANG: "tr" });
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).language, "en");
    await probe("/lang", "Language: en (English)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/lang repaints the running startup activity and startup notices in both directions", {
  skip: process.platform === "win32" && "Python pty.fork requires POSIX; native Windows uses ConPTY",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-lang-live-"));
  try {
    const rea = join(root, "slow-rea.mjs");
    // Keep the MCP handshake pending until the probe closes the app.
    await writeFile(rea, "process.stdin.resume();\n");
    for (const [from, to, before, after] of [["tr", "en", tr, en], ["en", "tr", en, tr]]) {
      const config = join(root, from, "config");
      await mkdir(join(config, "rea"), { recursive: true });
      await writeFile(join(config, "rea", "omr-update.json"), JSON.stringify({
        checkedAt: Date.now(), latest: { "oh-my-rea": "99.0.0" },
      }));
      const env = {
        ...fixtureEnvironment(from), HOME: root, XDG_CONFIG_HOME: config,
        OMR_SESSIONS_DIR: join(root, from, "sessions"), OMR_REA_COMMAND: rea,
        OMR_SKIP_SETUP: "1", TERM: "xterm-256color", NO_COLOR: "1",
      };
      const dump = join(root, `${from}.log`);
      const heading = (catalog) => catalog["changelog.whatsNew"].replace("{version}", VERSION);
      const footer = (catalog) => catalog["changelog.see"].split("`")[0].trimEnd();
      // The TUI shows the boxed update notice; its title and body follow /lang live.
      const update = (catalog) => `${catalog["update.title"]} `;
      const updateBody = (catalog) => catalog["update.body"]
        .replace("{name}", "omr").replace("{latest}", "99.0.0").replace("{installed}", VERSION);
      // In one direction also queue a command that has to wait for the same handshake.
      const commands = (from === "en" ? `/open ${rea}\r` : "") + `/lang ${to}\r`;
      const { stdout } = await run("python3", [
        ptyProbe, "--after-alt", "--timeout", "8", "--dump", dump,
        "--type", commands,
        "--mark", `activity=${before["runtime.startingRea"]}`,
        "--mark", `heading=${heading(before)}`, "--mark", `update=${update(before)}`,
        "--send-on", "activity", "--send-on", "heading", "--send-on", "update",
        "--mark", `switched=(${after["status.cancel"]})`, "--stop-on", "switched",
        "--", process.execPath, cli, "--no-model",
      ], { cwd: root, env, timeout: 14_000 });
      const result = JSON.parse(stdout);
      for (const mark of Object.values(result.marks)) assert.notEqual(mark, null, `${from} → ${to}\n${stdout}`);
      const frames = (await readFile(dump, "utf8")).split("\x1b[?2026h");
      const lastFrame = frames.findLast((frame) => frame.includes(`(${after["status.cancel"]})`));
      const status = stripAnsi(lastFrame.match(/\x1b\[40;1H(.*?)\x1b\[K/)?.[1] ?? "");
      for (const key of ["runtime.startingRea", "status.cancel", "status.noModel", "status.context"]) {
        assert.ok(status.includes(after[key]), status);
        assert.ok(!status.includes(before[key]), status);
      }
      const rendered = stripAnsi(lastFrame);
      const bitstream = (catalog, locale) => `${catalog["hud.bitstream"].toLocaleUpperCase(locale)} (${catalog["hud.binaryOn"]})`;
      for (const text of [heading(after), footer(after), update(after), updateBody(after), after["composer.busy"], after["hero.connecting"], bitstream(after, to)]) {
        assert.ok(rendered.includes(text), `Missing ${text} in ${from} → ${to}\n${rendered}`);
      }
      for (const text of [heading(before), footer(before), update(before), updateBody(before), bitstream(before, from)]) {
        assert.ok(!rendered.includes(text), rendered);
      }
      assert.ok(frames.some((frame) => frame.includes("A language switch hint on the startup screen.")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
