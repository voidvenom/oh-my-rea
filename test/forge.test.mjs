import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ForgeRegistry, forgeToolName, parseForgeSpec } from "../dist/forge.js";
import { ReaBroker } from "../dist/broker.js";
import { forgeManagementTool } from "../dist/localTools.js";
import { createSession } from "../dist/session.js";
import { parseArgs } from "../dist/args.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";

const spec = (version = "1.0.0") => ({ id: "hex_decoder", version, description: "Decode fixture hex bytes as UTF-8", interpreter: "node", dependencies: [],
  inputSchema: { type: "object", properties: { hex: { type: "string" } }, required: ["hex"], additionalProperties: false },
  outputSchema: { type: "object", properties: { decoded: { type: "string" } }, required: ["decoded"], additionalProperties: false },
  fixtures: [{ id: "hello", input: { hex: "6869" }, expected: { decoded: "hi" } }, { id: "empty", input: { hex: "" }, expected: { decoded: "" } }], timeoutSec: 2, network: false });
const source = 'import {readFileSync} from "node:fs"; const {hex}=JSON.parse(readFileSync(0,"utf8")); console.log(JSON.stringify({decoded:Buffer.from(hex,"hex").toString("utf8")}));';
const temp = () => mkdtemp(join(tmpdir(), "omr-forge-"));

describe("versioned semantic Forge tools", () => {
  it("rejects incomplete contracts and exit-zero implementations with wrong semantic output", async () => {
    const root = await temp();
    try {
      const registry = new ForgeRegistry(root, "source-session");
      assert.throws(() => parseForgeSpec({ ...spec(), fixtures: [] }), /semantic fixtures/);
      assert.throws(() => parseForgeSpec({ ...spec(), dependencies: [{ command: "npm", versionArgs: ["install"] }] }), /not version probes/);
      assert.throws(() => parseForgeSpec({ ...spec(), inputSchema: { ...spec().inputSchema, $ref: "elsewhere" } }), /Unsupported/);
      assert.throws(() => parseForgeSpec({ ...spec(), fixtures: [{ id: "bad", input: {}, expected: { decoded: "bad" } }] }), /required/);
      await registry.register(spec(), 'console.log(JSON.stringify({decoded:"wrong"}));');
      const proof = await registry.verify("hex_decoder", "1.0.0");
      assert.equal(proof.passed, false); assert.equal(proof.fixtures[0].run.exitCode, 0);
      assert.match(proof.fixtures[0].problem, /expected JSON/);
      await assert.rejects(registry.activate("hex_decoder", "1.0.0"), /passing semantic fixture proof/);
      assert.deepEqual(registry.tools(), []);
      await assert.rejects(registry.register(spec(), source), /immutable/);
      assert.equal(await registry.resolveProof(proof.ref), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("verifies, reuses and replaces immutable versions without stale-name dispatch", async () => {
    const root = await temp();
    try {
      const registry = new ForgeRegistry(root, "source-session");
      const broker = new ReaBroker(new FakeRea(root), { localTools: () => [forgeManagementTool(registry), ...registry.tools()] });
      broker.definitions(); await registry.register(spec(), source);
      assert.equal(broker.definitions().some(tool => tool.function.name === forgeToolName(spec())), false);
      const proof = await registry.verify("hex_decoder", "1.0.0"); assert.equal(proof.passed, true);
      await registry.activate("hex_decoder", "1.0.0"); const oldTool = registry.tools()[0];
      assert.ok(broker.definitions().some(tool => tool.function.name === oldTool.definition.function.name));
      const result = await broker.dispatch(oldTool.definition.function.name, { hex: "666f6f" });
      assert.equal(result.isError, false, result.text); assert.deepEqual(result.structuredContent.output, { decoded: "foo" });
      assert.equal((await broker.dispatch(oldTool.definition.function.name, { unknown: true })).isError, true);
      assert.equal(await registry.resolveProof(proof.ref), true);
      const restored = new ForgeRegistry(root, "continuation"); await restored.initialize();
      assert.equal(restored.tools()[0].definition.function.name, oldTool.definition.function.name);
      await registry.register(spec("2.0.0"), source); await registry.verify("hex_decoder", "2.0.0"); await registry.activate("hex_decoder", "2.0.0");
      assert.equal(broker.definitions().some(tool => tool.function.name === oldTool.definition.function.name), false);
      await assert.rejects(oldTool.invoke({ hex: "00" }), /no longer active/);
      await registry.deactivate("hex_decoder"); assert.deepEqual(registry.tools(), []);
      await registry.activate("hex_decoder", "1.0.0"); await registry.remove("hex_decoder", "1.0.0");
      assert.deepEqual(registry.tools(), []); await assert.rejects(registry.activate("hex_decoder", "1.0.0"), /passing/);
      assert.equal(await registry.resolveProof(proof.ref), false);
      assert.equal((await registry.list("hex_decoder")).length, 2, "removal erased historical versions");
      assert.equal(await readFile(join(root, "forge", "hex_decoder", "1.0.0", "tool.mjs"), "utf8"), source);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects source tampering and dependency drift instead of reusing stale proofs", { skip: process.platform === "win32" && "dependency fixture uses a POSIX executable shebang" }, async () => {
    const root = await temp(); const previousPath = process.env.PATH;
    try {
      const bin = join(root, "bin"); await mkdir(bin); const dependency = join(bin, "fixture_dep");
      await writeFile(dependency, "#!/bin/sh\nprintf 'fixture-version-1\\n'\n"); await chmod(dependency, 0o700); process.env.PATH = `${bin}:${previousPath}`;
      const registry = new ForgeRegistry(root, "fixture"); const declared = { ...spec(), dependencies: [{ command: "fixture_dep" }] };
      await registry.register(declared, source); const proof = await registry.verify("hex_decoder", "1.0.0"); await registry.activate("hex_decoder", "1.0.0");
      await writeFile(dependency, "#!/bin/sh\nprintf 'fixture-version-2\\n'\n");
      await assert.rejects(registry.tools()[0].invoke({ hex: "00" }), /environment changed/);
      assert.equal(await registry.resolveProof(proof.ref), false);
      const refreshed = await registry.verify("hex_decoder", "1.0.0"); assert.equal(refreshed.passed, true); assert.notEqual(refreshed.ref, proof.ref);
      assert.deepEqual(registry.tools(), [], "verification activated a tool implicitly");
      await registry.activate("hex_decoder", "1.0.0");
      await writeFile(join(root, "forge", "hex_decoder", "1.0.0", "tool.mjs"), 'console.log("tampered")');
      await assert.rejects(registry.tools()[0].invoke({ hex: "00" }), /hash changed/);
      await assert.rejects(new ForgeRegistry(root, "resume").initialize(), /hash changed/);
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
  });

  it("refuses missing dependencies and invalid JSON output, with no false active version", async () => {
    const root = await temp();
    try {
      const registry = new ForgeRegistry(root, "fixture");
      await registry.register({ ...spec(), dependencies: [{ command: "omr_fixture_missing_executable_7341" }] }, source);
      await assert.rejects(registry.verify("hex_decoder", "1.0.0"), /ENOENT/);
      assert.deepEqual(registry.tools(), []);
      await registry.register(spec("1.0.1"), 'console.log("not JSON");');
      const invalid = await registry.verify("hex_decoder", "1.0.1"); assert.equal(invalid.passed, false); assert.match(invalid.fixtures[0].problem, /JSON|Unexpected/);
      await registry.register(spec("1.0.2"), 'console.log(JSON.stringify({decoded:42}));');
      const wrongShape = await registry.verify("hex_decoder", "1.0.2"); assert.equal(wrongShape.passed, false); assert.match(wrongShape.fixtures[0].problem, /expected string/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish activation when the durable registry write fails", async () => {
    const root = await temp();
    try {
      const registry = new ForgeRegistry(root, "fixture"); await registry.register(spec(), source); await registry.verify("hex_decoder", "1.0.0");
      const index = join(root, "forge", "registry.json"); await rename(index, `${index}.backup`); await mkdir(index);
      await assert.rejects(registry.activate("hex_decoder", "1.0.0"));
      assert.deepEqual(registry.tools(), [], "failed durable publication exposed the tool");
      await rm(index, { recursive: true }); await rename(`${index}.backup`, index);
      await registry.activate("hex_decoder", "1.0.0"); assert.equal(registry.tools().length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("supports agent creation/verification/reuse and carries proofs across real fork/resume", async () => {
    const root = await temp(); let ctx;
    const model = new FakeModel([
      { toolCalls: [{ name: "omr_forge", arguments: { action: "register", spec: spec(), code: source } }] },
      { toolCalls: [{ name: "omr_forge", arguments: { action: "verify", id: "hex_decoder", version: "1.0.0" } }] },
      { toolCalls: [{ name: "omr_forge", arguments: { action: "activate", id: "hex_decoder", version: "1.0.0" } }] },
      { toolCalls: [{ name: forgeToolName(spec()), arguments: { hex: "6869" } }] }, { content: "decoded hi" },
    ]);
    try {
      const session = await createSession(null, "fixture", { rootDir: root });
      ctx = new OmrContext({ opts: parseArgs(["node", "omr", "--json"]), cwd: root, env: { OPENAI_API_KEY: "fixture", OMR_MODEL: "gpt-4.1" }, sources: [], session, sessionsRootDir: root, currentTarget: null, currentMagic: null,
        output: new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} }), deps: { connectRea: async dir => new FakeRea(dir), createModelClient: () => model } });
      await ctx.runTurn("create and verify a reusable decoder", "fixture");
      assert.ok(ctx.agent.history.some(message => message.role === "tool" && message.content.includes('"decoded":"hi"')));
      assert.ok(model.requests[3].tools.some(tool => tool.function.name === forgeToolName(spec())));
      const original = ctx.session; const proof = (await ctx.runtime.forge.list())[0].proof;
      const commands = createDefaultCommandRegistry();
      await commands.dispatchSlashLine(ctx, "/fork verified-decoder");
      await ctx.ensureConnected(); assert.equal(await ctx.runtime.forge.resolveProof(proof.ref), true);
      assert.equal((await commands.dispatchCommand(ctx, '/forge run hex_decoder {"hex":"6f6b"}')).status, "completed");
      await commands.dispatchSlashLine(ctx, "/forge remove hex_decoder"); assert.deepEqual(ctx.runtime.forge.tools(), []);
      await commands.dispatchSlashLine(ctx, `/resume ${original.id}`);
      assert.equal(ctx.runtime.forge.tools().length, 1); assert.equal(await ctx.runtime.forge.resolveProof(proof.ref), true);
      assert.equal((await ctx.runtime.forge.list())[0].originSessionId, original.id);
    } finally { await ctx?.shutdown("complete"); await rm(root, { recursive: true, force: true }); }
  });
});
