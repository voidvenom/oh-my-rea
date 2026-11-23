// Install the actual npm artifact into a scratch prefix; never update the host installation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";
import { npmInvocation } from "../dist/platform.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "omr-pack-"));
const win = process.platform === "win32";
const prefix = join(root, "Masaüstü prefix");
const home = join(root, "home");
const bin = win ? prefix : join(prefix, "bin");
const isolated = {
  ...fixtureEnvironment(), HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "Local"), APPDATA: join(home, "Roaming"),
  XDG_CONFIG_HOME: join(home, "config"), OMR_SESSIONS_DIR: join(home, "sessions"), OMR_NO_UPDATE_CHECK: "1",
  npm_config_userconfig: join(root, "empty-npmrc"), npm_config_update_notifier: "false",
};
const run = (command, args, cwd, env, extra = {}) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, ...extra });
  assert.equal(result.status, 0, `${command}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const npm = (args, cwd) => {
  const invocation = npmInvocation(args, { ...process.env, ...isolated });
  assert.ok(invocation, "npm CLI is unavailable");
  return run(invocation.command, invocation.args, cwd, isolated);
};
let report;
try {
  await mkdir(home);
  await writeFile(join(root, "empty-npmrc"), "");
  const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", root], repo));
  assert.ok(packed.files.some(file => file.path === "dist/sdk.d.ts"));
  assert.ok(!packed.files.some(file => file.path.startsWith(".planning/")));
  npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", join(root, packed.filename)], root);
  const installedRoot = win ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
  const installed = join(installedRoot, "oh-my-rea");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.main, "./dist/main.js");
  assert.equal(manifest.exports["./sdk"].types, "./dist/sdk.d.ts");
  const cliEnv = { ...isolated, PATH: [bin, dirname(process.execPath), ...(win && isolated.SystemRoot ? [join(isolated.SystemRoot, "System32")] : [])].join(delimiter) };
  const cli = (...args) => win
    // Every token here is a literal test argument, not a path or operator input.
    ? run(isolated.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"omr ${args.join(" ")}"`], root, cliEnv, { windowsVerbatimArguments: true })
    : run(join(bin, "omr"), args, root, cliEnv);
  const version = cli("--version").trim();
  assert.equal(version, manifest.version);
  assert.match(cli("--help"), /^Usage:/m);
  const status = cli("/status");
  assert.match(status, /REA.*(?:not installed|not found|missing)/i);

  const consumer = await readFile(new URL("fixtures/sdk-consumer.mts", import.meta.url), "utf8");
  // TypeScript's generated imports resolve relative to the consumer, beside the installed package.
  const consumerPath = join(installedRoot, "consumer.mts");
  await writeFile(consumerPath, consumer);
  const types = join(repo, "node_modules", "@types");
  run(process.execPath, [join(repo,"node_modules","typescript","bin","tsc"), "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2024", "--strict", "--skipLibCheck", "--typeRoots", types, consumerPath], root, cliEnv);
  const sessionRoot = JSON.stringify(join(root, "sdk sessions"));
  const program = `import assert from 'node:assert/strict';import {createRuntime} from 'oh-my-rea/sdk';const before=process.listenerCount('SIGTERM');const runtime=await createRuntime({cwd:process.cwd(),sessionsRootDir:${sessionRoot},noModel:true});try{const result=await runtime.command('/state update 0 {"goal":"packaged SDK"}');assert.equal(result.exitCode,0);assert.equal((await runtime.snapshot()).task.goal,'packaged SDK');assert.ok((await runtime.readEvents()).length>0);console.log(JSON.stringify({status:result.outcome.status,exitCode:result.exitCode,events:true}));}finally{await runtime.close();assert.equal(process.listenerCount('SIGTERM'),before);}`;
  const programPath = join(installedRoot, "consumer.mjs");
  await writeFile(programPath, program);
  const consumerResult = JSON.parse(run(process.execPath, [programPath], root, cliEnv).trim());
  const sdkSha256 = createHash("sha256").update(await readFile(join(installed, "dist", "sdk.js"))).digest("hex");
  assert.equal(sdkSha256, createHash("sha256").update(await readFile(join(repo, "dist", "sdk.js"))).digest("hex"));
  report = { schema:"omr-package-consumer/v1", passed:true, generatedAt:new Date().toISOString(), sdkSha256, package:{ name:manifest.name, version, integrity:packed.integrity, fileCount:packed.files.length, size:packed.size }, consumer:consumerResult, typecheck:"passed", cli:{ version, help:"passed", statusWithoutRea:"passed" }, dependencies:"installed into a temporary npm prefix" };
} catch (error) {
  report = { schema:"omr-package-consumer/v1", passed:false, error:error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
const index = process.argv.indexOf("--report");
if (index >= 0) await writeFile(resolve(process.argv[index + 1]), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
