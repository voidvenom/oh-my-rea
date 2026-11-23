import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import { createTheme } from "../dist/ansi.js";
import { discoverInstalledBrowsers } from "../dist/browser.js";
import { writeJsonAtomic } from "../dist/durable.js";
import { beginEarlyInput } from "../dist/earlyInput.js";
import { parseExports } from "../dist/env.js";
import { scrubbedEnv, runSessionScript } from "../dist/exec.js";
import { ExecutionStore, readExecutionEvents } from "../dist/execution.js";
import { JournalTailer } from "../dist/journal.js";
import { windowsTreeKill } from "../dist/ownedProcess.js";
import { completionPath, defaultSessionsPath, findOnPath, hostHome, invalidWindowsFilename, localFilePath, normalizeEnv, npmInvocation, reaCachePath, reaConfigPath, rebaseSessionArtifact } from "../dist/platform.js";
import { desktopOpenInvocation, windowsClipboardWrite } from "../dist/platformDesktop.js";
import { canSyncDirectory, replaceFile, replaceFileSync } from "../dist/platformFs.js";
import { reaInvocation } from "../dist/reaLauncher.js";
import { splitShellTokens } from "../dist/runtime/utils.js";
import { interpreterFor, operatorShell, scriptInterpreterSummary, supportsNetworkNamespace } from "../dist/scriptPlatform.js";

const win = "win32";
const home = String.raw`C:\Users\Çağrı`;
const scripts = win32.join(home, "Masaüstü & files");
const node = String.raw`C:\Program Files\nodejs\node.exe`;
const env = { UserProfile: home, appdata: win32.join(home, "Roaming"), LocalAppData: win32.join(home, "Local"), Path: `"${scripts}";${win32.dirname(node)}`, Pathext: ".CMD;.EXE", ComSpec: String.raw`C:\Windows\System32\cmd.exe` };
const absent = () => false;

test("Windows environment keys, legacy state, overrides and native directory defaults", () => {
  const parsed = {};
  parseExports('export REA_PATH="C:\\Tools\\Ghidra"\r\n', parsed, home, win);
  assert.equal(parsed.REA_PATH, String.raw`C:\Tools\Ghidra`);
  assert.equal(hostHome({ ...env, HOME: "/git/bash" }, win), home);
  assert.deepEqual(normalizeEnv({ Path: "old", PATH: "operator", omr_lang: "tr" }, win), { PATH: "operator", OMR_LANG: "tr" });
  const args = ["omr-model.json"];
  const legacy = win32.join(home, ".config", "rea", ...args);
  assert.equal(reaConfigPath(env, args, win, home, p => p === legacy), legacy);
  assert.equal(reaConfigPath(env, args, win, home, absent), win32.join(env.appdata, "rea", ...args));
  assert.equal(reaConfigPath({ ...env, xdg_config_home: scripts }, args, win, home, absent), win32.join(scripts, "rea", ...args));
  assert.equal(reaConfigPath({}, args, "darwin", "/Users/ç", absent), "/Users/ç/Library/Application Support/rea/omr-model.json");
  assert.equal(reaConfigPath({}, args, "linux", "/home/ç", absent), "/home/ç/.config/rea/omr-model.json");
  assert.equal(defaultSessionsPath(env, win, home, absent), win32.join(env.LocalAppData, "rea", "sessions"));
  assert.equal(defaultSessionsPath({ XDG_STATE_HOME: "/state" }, "linux", "/home/ç", absent), "/state/rea/sessions");
  assert.equal(defaultSessionsPath({}, "linux", "/home/ç", absent), "/home/ç/.rea/sessions");
  assert.equal(reaCachePath(env, "limits", win, home, absent), win32.join(env.LocalAppData, "rea", "cache", "limits"));
  assert.equal(reaCachePath({}, "limits", "darwin", "/Users/ç", absent), "/Users/ç/Library/Caches/rea/limits");
  assert.equal(reaCachePath({ XDG_CACHE_HOME: "/cache" }, "limits", "linux", "/home/ç", absent), "/cache/rea/limits");
});

test("drive, UNC, mixed separators and encoded file URLs", () => {
  assert.equal(localFilePath("file:///C:/Masa%C3%BCst%C3%BC/a%20b.png", win), String.raw`C:\Masaüstü\a b.png`);
  assert.equal(localFilePath("file://server/share/a%20b.png", win), String.raw`\\server\share\a b.png`);
  assert.equal(localFilePath("file:///tmp/a%20b.png", "linux"), "/tmp/a b.png");
  assert.throws(() => localFilePath("file://server/share/b.png", "linux"), { code: "ERR_INVALID_FILE_URL_HOST" });
  const share = String.raw`\\server\share` + "\\";
  assert.deepEqual(completionPath(`${share}di`, home, win, home), { searchDir: share, displayDirPrefix: share, prefix: "di" });
  assert.deepEqual(completionPath(`${scripts}/Fo`, home, win, home), { searchDir: scripts, displayDirPrefix: `${scripts}/`, prefix: "fo" });
  assert.deepEqual(completionPath(String.raw`~\a`, home, win, home), { searchDir: home, displayDirPrefix: "~\\", prefix: "a" });
  assert.deepEqual(splitShellTokens(`"${scripts}\\app.exe"`, win), [`${scripts}\\app.exe`]);
  assert.deepEqual(splitShellTokens(`"${share}"`, win), [share]);
  assert.deepEqual(completionPath("assets/fi", "/work", "darwin"), { searchDir: "/work/assets", displayDirPrefix: "assets/", prefix: "fi" });
  const fork = win32.join(home, "fork");
  assert.equal(rebaseSessionArtifact(`${scripts}/captures/a.png`, scripts, fork, win), win32.join(fork, "captures", "a.png"));
  assert.equal(rebaseSessionArtifact(`${scripts}-other/a.png`, scripts, fork, win), `${scripts}-other/a.png`);
  assert.equal(rebaseSessionArtifact("/d/source/a.png", "/d/source", "/d/fork", "darwin"), "/d/fork/a.png");
  for (const name of ["NUL.txt", "CoM¹.py", "name.", "name:stream"]) assert.equal(invalidWindowsFilename(name), true, name);
  assert.equal(invalidWindowsFilename("nul-check.mjs"), false);
});

test("PATH resolves native binaries and known npm shims without reinterpreting arguments", () => {
  const shim = win32.join(scripts, "rea.CMD");
  const entry = win32.join(scripts, "node_modules", "rea-agents", "scripts", "rea.mjs");
  const argument = "İ %PATH% & | ^ \"literal\"";
  assert.equal(findOnPath("rea", env, win, p => p === shim), shim);
  assert.equal(findOnPath("rea", env, win, p => p === shim, true), undefined);
  assert.deepEqual(reaInvocation(shim, ["mcp", argument], win, node, p => p === entry), { command: node, args: [entry, "mcp", argument] });
  assert.equal(reaInvocation(win32.join(scripts, "anything.cmd"), [argument], win, node, () => true), undefined);
  assert.deepEqual(reaInvocation("/work/rea/scripts/rea.mjs", ["--version"], "darwin", "/bin/node"), { command: "/bin/node", args: ["/work/rea/scripts/rea.mjs", "--version"] });
  const npmEntry = win32.join(win32.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  assert.deepEqual(npmInvocation([argument], env, win, node, p => p === npmEntry, () => undefined), { command: node, args: [npmEntry, argument] });
  assert.deepEqual(npmInvocation(["root", "--global"], {}, "darwin"), { command: "npm", args: ["root", "--global"] });
  assert.equal(npmInvocation([], env, win, node, absent, () => undefined), undefined);
});

test("interpreter plans and Windows process essentials are explicit", () => {
  const py = win32.join(scripts, "py.exe"), pwsh = win32.join(scripts, "pwsh.exe");
  const lookup = name => ({ py, pwsh })[name];
  assert.deepEqual(interpreterFor("parse.py", env, win, node, lookup), { command: py, leadingArgs: ["-3", "-B", "-u"] });
  assert.deepEqual(interpreterFor("parse.ps1", env, win, node, lookup), { command: pwsh, leadingArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"] });
  assert.deepEqual(interpreterFor("parse.mjs", env, win, node, lookup), { command: node, leadingArgs: [] });
  assert.match(scriptInterpreterSummary(env, win, lookup), /\.py \(py.exe\).*\.sh \(unavailable\).*\.ps1 \(pwsh.exe\)/);
  assert.match(interpreterFor("parse.sh", env, win, node, lookup).error, /add bash to PATH/);
  assert.match(interpreterFor("parse.ps1", {}, "darwin", "/bin/node", () => undefined).error, /add pwsh to PATH/);
  assert.equal(supportsNetworkNamespace(win), false);
  assert.equal(supportsNetworkNamespace("darwin"), false);
  assert.equal(supportsNetworkNamespace("linux"), true);
  const scrubbed = scrubbedEnv(scripts, { ...env, systemroot: String.raw`C:\Windows`, SECRET: "no" }, win);
  assert.equal(scrubbed.PATH, env.Path);
  assert.equal(scrubbed.SystemRoot, String.raw`C:\Windows`);
  assert.equal(scrubbed.USERPROFILE, home);
  assert.equal(scrubbed.SECRET, undefined);
  assert.deepEqual(operatorShell("echo hello & echo world", env, win), { command: env.ComSpec, args: ["/d", "/s", "/c", '"echo hello & echo world"'], windowsVerbatimArguments: true });
  assert.deepEqual(windowsTreeKill(42, { SystemRoot: String.raw`D:\Windows` }), { command: String.raw`D:\Windows\System32\taskkill.exe`, args: ["/pid", "42", "/t", "/f"] });
});

test("desktop dispatch preserves Unicode and keeps URL metacharacters out of a shell", () => {
  const url = "https://example.test/?a=1&b=2%20x";
  assert.deepEqual(desktopOpenInvocation(url, win), { command: "explorer.exe", args: [url] });
  assert.deepEqual(desktopOpenInvocation(url, "darwin"), { command: "/usr/bin/open", args: [url] });
  assert.deepEqual(desktopOpenInvocation(url, "linux"), { command: "xdg-open", args: [url] });
  assert.equal(desktopOpenInvocation("--help", "linux"), undefined);
  assert.equal(windowsClipboardWrite("İstanbul 🐈\n").input.toString("utf16le"), "\ufeffİstanbul 🐈\n");
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(discoverInstalledBrowsers({}, "darwin", p => p === mac).find(b => b.id === "chrome").binary, mac);
  const chrome = String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`;
  assert.equal(discoverInstalledBrowsers({ "programfiles(x86)": String.raw`C:\Program Files (x86)` }, win, p => p === chrome).find(b => b.id === "chrome").binary, chrome);
  assert.equal(discoverInstalledBrowsers({}, "linux", p => p === "/usr/bin/chromium")[0].binary, "/usr/bin/chromium");
  assert.equal(createTheme({ WT_SESSION: "present" }).trueColor, true);
  assert.equal(createTheme({ TERM_PROGRAM: "iTerm.app" }).trueColor, true);
  assert.equal(createTheme({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }).trueColor, false);
  assert.equal(createTheme({ TERM: "dumb", WT_SESSION: "present" }).enabled, false);
});

test("Windows replacement retries only transient failures without removing the old path", async () => {
  const busy = Object.assign(new Error("sharing violation"), { code: "EPERM" });
  let attempts = 0;
  const waits = [];
  replaceFileSync("staging", "existing", win, (from, to) => {
    assert.equal(from, "staging"); assert.equal(to, "existing");
    if (++attempts < 3) throw busy;
  }, ms => waits.push(ms));
  assert.deepEqual(waits, [10, 20]);
  await assert.rejects(replaceFile("staging", "existing", "darwin", async () => { throw busy; }), error => error === busy);
  attempts = 0;
  await replaceFile("staging", "existing", win, async () => { if (++attempts === 1) throw busy; });
  assert.equal(attempts, 2);
  assert.equal(canSyncDirectory(win), false);
  assert.equal(canSyncDirectory("darwin"), true);
});

test("Unicode session storage, CRLF journal records and script arguments round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "omr-İ file-"));
  try {
    const state = join(root, "state.json");
    await writeJsonAtomic(state, { n: 1 });
    await writeJsonAtomic(state, { n: 2 });
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")), { n: 2 });
    const trace = new ExecutionStore("portable", root);
    await trace.append("fixture.event", { text: "Türkçe" });
    const events = [];
    for await (const event of readExecutionEvents(trace.path)) events.push(event);
    assert.deepEqual(events.map(event => event.data), [{ text: "Türkçe" }]);
    const journal = join(root, "journal.jsonl");
    await writeFile(journal, '{"type":"session.start","seq":1}\r\n{"type":"session.end","seq":2}\r\n');
    const result = await new JournalTailer(journal).sync();
    assert.equal(result.counts.records, 2);
    assert.equal(result.malformed_records, 0);
    const argument = "çağrı %PATH% & | ^ \"literal\"";
    const run = await runSessionScript({ scriptsDir: root, script: "echo.mjs", code: "console.log(JSON.stringify(process.argv.slice(2)));", args: [argument], network: true });
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.deepEqual(JSON.parse(run.stdout), [argument]);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test("raw input setup declines a TTY that cannot enter raw mode", () => {
  assert.equal(beginEarlyInput({ isTTY: false }), false);
  assert.equal(beginEarlyInput({ isTTY: true, setRawMode() { throw new Error("unsupported console"); } }), false);
});
