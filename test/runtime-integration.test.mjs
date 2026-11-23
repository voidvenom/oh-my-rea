import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseArgs } from "../dist/args.js";
import {
  formatStagedBangContext,
  parseBangLine,
  runBangCommand,
  toStagedBangEntry,
} from "../dist/bang.js";
import { ReaBroker } from "../dist/broker.js";
import {
  discoverCustomCommands,
  parseCustomCommandMarkdown,
  renderCustomCommandPrompt,
  saveCustomCommandFile,
} from "../dist/customCommands.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import {
  createDefaultCommandRegistry,
  runOmr,
} from "../dist/runtime.js";
import {
  createSession,
  loadSavedSession,
} from "../dist/session.js";
import {
  SubagentRunner,
  renderSubagentGraph,
  renderSubagentInspector,
} from "../dist/subagent.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { useModelCatalogFixtures } from "./fixtures/model-catalogs.mjs";

useModelCatalogFixtures();

const makeTestEnv = () => ({
  OPENAI_API_KEY: "sk-test-fake-key",
  OMR_MODEL: "gpt-4.1",
});

const launchOpts = (flags) => parseArgs(["node", "omr", ...flags]);

describe("End-to-end runtime integration via FakeRea & FakeModel", () => {
  it("executes /status, /tools, /call, /guide, /prompts, and /adb pull auto-binding through runOmr", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-rt-"));
    try {
      const targetPath = join(tmp, "sample.bin");
      await writeFile(
        targetPath,
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      );
      const pulledApkPath = join(tmp, "com.example.app.apk");
      await writeFile(
        pulledApkPath,
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      );

      let fakeReaInstance = null;
      const connectRea = async (sessionDir) => {
        fakeReaInstance = new FakeRea(sessionDir, {
          handlers: {
            pull_adb_package: async () => ({
              apk_path: pulledApkPath,
              package: "com.example.app",
            }),
          },
        });
        return fakeReaInstance;
      };

      const runJsonCommand = async (cmdLine) => {
        const out = [];
        const err = [];
        const opts = launchOpts(["--json", targetPath, cmdLine]);
        const code = await runOmr(opts, {
          cwd: tmp,
          env: makeTestEnv(),
          sessionsRootDir: join(tmp, "sessions"),
          connectRea,
          createModelClient: () => new FakeModel([{ content: "ok" }]),
          writeStdout: (t) => out.push(t),
          writeStderr: (t) => err.push(t),
        });
        assert.equal(code, 0);
        assert.equal(err.join(""), "");
        return out
          .join("")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      };

      const statusEvents = await runJsonCommand("/status");
      const statusResult = statusEvents.find((e) => e.type === "command.result");
      assert.ok(statusResult);
      assert.equal(statusResult.command, "status");
      assert.ok(
        fakeReaInstance.calls.some((c) => c.name === "open_binary"),
        "Expected /status with requires.openTarget to auto-open the bound target",
      );

      const toolsEvents = await runJsonCommand("/tools strings");
      const toolsResult = toolsEvents.find((e) => e.type === "command.result");
      assert.ok(toolsResult);
      assert.equal(toolsResult.command, "tools");
      assert.ok(toolsResult.payload.matches.includes("search_strings"));

      const callEvents = await runJsonCommand(
        '/call search_strings {"query":"flag"}',
      );
      const callResult = callEvents.find((e) => e.type === "command.result");
      assert.ok(callResult);
      assert.equal(callResult.command, "call");
      assert.equal(callResult.payload.tool, "search_strings");

      const pullEvents = await runJsonCommand("/adb pull com.example.app");
      const pullResult = pullEvents.find(
        (e) => e.type === "command.result" && e.command === "adb",
      );
      assert.ok(pullResult);
      assert.equal(pullResult.payload.apk_path, pulledApkPath);
      assert.ok(
        fakeReaInstance.calls.some(
          (c) => c.name === "open_binary" && c.args.path === pulledApkPath,
        ),
        "Expected /adb pull to auto-bind and call open_binary on the pulled APK",
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports !<cmd> and !!<cmd> bang shell passthrough and attaches staged output to the next agent turn", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-bang-"));
    try {
      assert.deepEqual(parseBangLine("!echo hello"), {
        kind: "exec",
        command: "echo hello",
        attachToContext: false,
      });
      assert.deepEqual(parseBangLine("!!echo staged-secret-42"), {
        kind: "exec",
        command: "echo staged-secret-42",
        attachToContext: true,
      });
      assert.deepEqual(parseBangLine("!!"), { kind: "inspect" });
      assert.deepEqual(parseBangLine("!!clear"), { kind: "clear" });

      const outcome = await runBangCommand("printf 'alpha-beta-777\\n'", {
        cwd: tmp,
      });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.stdout, "alpha-beta-777\n");

      const stagedContext = formatStagedBangContext([
        toStagedBangEntry(outcome),
      ]);
      assert.ok(stagedContext.includes("alpha-beta-777"));

      // Verify OmrContext injects staged !!<cmd> output into the next agent turn and clears it afterwards
      const session = await createSession(null, "gpt-4.1", {
        rootDir: join(tmp, "sessions"),
      });
      const fakeModel = new FakeModel([
        { content: "Observed alpha-beta-777 from staged shell output." },
      ]);
      const output = new OutputSink({
        json: true,
        writeStdout: () => {},
        writeStderr: () => {},
      });
      const ctx = new OmrContext({
        opts: launchOpts(["--json"]),
        cwd: tmp,
        env: makeTestEnv(),
        sources: [],
        sessionsRootDir: join(tmp, "sessions"),
        output,
        session,
        currentTarget: null,
        currentMagic: null,
        deps: {
          connectRea: async (dir) => new FakeRea(dir),
          createModelClient: () => fakeModel,
        },
      });
      ctx.stageBangEntry(toStagedBangEntry(outcome));
      assert.equal(ctx.stagedBangEntries.length, 1);

      await ctx.runTurn("Summarize the local shell output", "bang-test");
      assert.equal(
        ctx.stagedBangEntries.length,
        0,
        "Staged bang output must be consumed after the turn",
      );
      assert.equal(fakeModel.requests.length, 1);
      const sentMessages = fakeModel.requests[0].messages;
      assert.ok(
        sentMessages.some(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes("alpha-beta-777"),
        ),
        "Expected staged !!<cmd> output to be injected into turn messages",
      );
      await ctx.shutdown("complete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports /rewind (/undo) preserving tool_call_id pairing and /fork (/branch) creating an independent session branch", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-rewind-fork-"));
    try {
      const sessionsRoot = join(tmp, "sessions");
      const registry = createDefaultCommandRegistry();
      const session = await createSession("/tmp/demo.elf", "gpt-4.1", {
        rootDir: sessionsRoot,
      });

      const fakeModel = new FakeModel([
        {
          reasoning: "Checking strings first",
          toolCalls: [
            {
              id: "call_1",
              name: "search_strings",
              arguments: { query: "license" },
            },
          ],
        },
        {
          content:
            "Turn 1 finding citing ev_0000000000000000000000000000000000000000000000000000000000000001.",
        },
        {
          content: "Turn 2 speculative note to be rewound.",
        },
      ]);

      const events = [];
      const output = new OutputSink({
        json: true,
        writeStdout: (line) => events.push(JSON.parse(line)),
        writeStderr: () => {},
      });
      const ctx = new OmrContext({
        opts: launchOpts(["--json"]),
        cwd: tmp,
        env: makeTestEnv(),
        sources: [],
        sessionsRootDir: sessionsRoot,
        output,
        session,
        currentTarget: "/tmp/demo.elf",
        currentMagic: null,
        deps: {
          connectRea: async (dir) => new FakeRea(dir),
          createModelClient: () => fakeModel,
        },
      });

      await ctx.runTurn("First question", "turn-1");
      await ctx.runTurn("Second question", "turn-2");
      assert.equal(
        ctx.agent.history.filter((m) => m.role === "user").length,
        2,
      );

      // Fork session before rewinding so the branch preserves both turns
      await registry.dispatchSlashLine(ctx, "/fork before-undo");
      const forkEvent = events.find(
        (e) => e.type === "command.result" && e.command === "fork",
      );
      assert.ok(forkEvent);
      const forkedId = forkEvent.payload.session_id;
      assert.ok(forkedId.includes("before-undo"));

      const loadedFork = await loadSavedSession(
        forkedId,
        undefined,
        sessionsRoot,
      );
      assert.ok(loadedFork);
      assert.ok(
        loadedFork.messages.some(
          (m) =>
            m.role === "assistant" &&
            (m.content ?? "").includes("Turn 2 speculative note"),
        ),
      );

      // Now rewind 1 turn on the active session via /undo alias
      await registry.dispatchSlashLine(ctx, "/undo 1");
      assert.equal(
        ctx.agent.history.filter((m) => m.role === "user").length,
        1,
      );
      assert.equal(
        ctx.agent.history.some(
          (m) =>
            m.role === "assistant" &&
            (m.content ?? "").includes("Turn 2 speculative note"),
        ),
        false,
      );
      // Verify Turn 1's tool_call_id pairing is still intact
      assert.equal(
        ctx.agent.history.some(
          (m) => m.role === "tool" && m.tool_call_id === "call_1",
        ),
        true,
      );

      await ctx.shutdown("complete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("discovers custom .omr/commands/*.md templates, supports /save --as-command, and interpolates $ARGUMENTS and $TARGET", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-custom-cmd-"));
    try {
      const sessionsRoot = join(tmp, "sessions");
      const registry = createDefaultCommandRegistry();
      const session = await createSession("/bins/firmware.bin", "gpt-4.1", {
        rootDir: sessionsRoot,
      });

      const { path: cmdPath } = await saveCustomCommandFile({
        name: "audit-jwt",
        description: "Audit JWT verification routines",
        template:
          "Target: $TARGET\nSession: $SESSION_DIR\nFirst arg: $1\nAll args: $ARGUMENTS",
        cwd: tmp,
      });
      const enrichedMd =
        `---\n` +
        `description: "Audit JWT verification routines"\n` +
        `aliases: [jwt]\n` +
        `effort: high\n` +
        `autoSavePrefix: jwt-poc\n` +
        `---\n\n` +
        `Target: $TARGET\nSession: $SESSION_DIR\nFirst arg: $1\nAll args: $ARGUMENTS\n`;
      await writeFile(cmdPath, enrichedMd, "utf8");
      assert.equal(existsSync(cmdPath), true);

      const parsed = parseCustomCommandMarkdown(
        "audit-jwt",
        enrichedMd,
        cmdPath,
        "project",
      );
      assert.ok(parsed);
      assert.equal(parsed.name, "audit-jwt");
      assert.deepEqual(parsed.aliases, ["jwt"]);
      assert.equal(parsed.effort, "high");

      const rendered = renderCustomCommandPrompt(parsed, {
        args: "HS256 confusion",
        target: "/bins/firmware.bin",
        sessionDir: "/tmp/sess-1",
        cwd: tmp,
      });
      assert.ok(rendered.includes("Target: /bins/firmware.bin"));
      assert.ok(rendered.includes("First arg: HS256"));
      assert.ok(rendered.includes("All args: HS256 confusion"));

      const fakeModel = new FakeModel([
        {
          content:
            "JWT analysis complete.\n```python\nprint('jwt-poc-verified')\n```",
        },
      ]);
      const output = new OutputSink({
        json: true,
        writeStdout: () => {},
        writeStderr: () => {},
      });
      const ctx = new OmrContext({
        opts: launchOpts(["--json"]),
        cwd: tmp,
        env: makeTestEnv(),
        sources: [],
        sessionsRootDir: sessionsRoot,
        output,
        session,
        currentTarget: "/bins/firmware.bin",
        currentMagic: null,
        deps: {
          connectRea: async (dir) => new FakeRea(dir),
          createModelClient: () => fakeModel,
        },
      });

      // Execute custom command via its /jwt alias
      await registry.dispatchSlashLine(ctx, "/jwt RS256-to-HS256");
      assert.equal(fakeModel.requests.length, 1);
      const userPromptSent = fakeModel.requests[0].messages.find(
        (m) => m.role === "user",
      )?.content;
      assert.ok(userPromptSent.includes("Target: /bins/firmware.bin"));
      assert.ok(userPromptSent.includes("All args: RS256-to-HS256"));
      assert.ok(
        ctx.lastSavedScriptPath && existsSync(ctx.lastSavedScriptPath),
        "Expected custom command with autoSavePrefix to auto-save generated code block",
      );

      // Save the last prompt as a reusable command via /save --as-command
      await registry.dispatchSlashLine(ctx, "/save --as-command replay-jwt");
      const discovered = discoverCustomCommands(tmp, makeTestEnv());
      assert.ok(discovered.some((c) => c.name === "replay-jwt"));

      await ctx.shutdown("complete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("runs isolated read-only subagents (/spawn and omr_task), collects ev_ IDs, and blocks target-mutating tools", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-subagent-"));
    try {
      const fakeRea = new FakeRea(tmp);
      const parentBroker = new ReaBroker(fakeRea);

      const childModel = new FakeModel((messages, _tools, step) => {
        if (step === 0) {
          return {
            toolCalls: [
              {
                id: "sub_mut",
                name: "open_binary",
                arguments: { path: "/etc/passwd" },
              },
              {
                id: "sub_ro",
                name: "search_strings",
                arguments: { query: "AES_GCM" },
              },
            ],
          };
        }
        const toolMsgs = messages.filter((m) => m.role === "tool");
        const mutMsg = toolMsgs.find((m) => m.tool_call_id === "sub_mut");
        assert.ok(
          mutMsg &&
            mutMsg.content.includes("Subagent read-only boundary"),
          "Subagent must block open_binary",
        );
        return {
          content: `Subagent verified AES_GCM in ${toolMsgs.map((m) => m.content).join(" ")}`,
        };
      });

      const runner = new SubagentRunner({
        getModel: () => childModel,
        getBroker: async () => parentBroker,
        getTarget: () => "/bins/crypto.elf",
        getTargetFormat: () => "ELF64",
        getSessionDir: () => tmp,
      });

      const result = await runner.runTask({
        goal: "Locate AES_GCM constants",
        workflow: "crypto",
      });
      assert.equal(result.ok, true);
      assert.equal(result.workflow, "crypto");
      assert.equal(result.evidenceIds.length, 1);
      assert.match(result.evidenceIds[0], /^ev_[0-9a-f]{64}$/);
      assert.equal(
        fakeRea.calls.some((c) => c.name === "open_binary"),
        false,
        "Blocked open_binary must never reach ReaPort",
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("activates cyber/RE profiles (--profile / /profile) and surfaces persistence errors once per scope", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-profile-persist-"));
    try {
      const sessionsRoot = join(tmp, "sessions");
      const session = await createSession("/bins/target.elf", "gpt-4.1", {
        rootDir: sessionsRoot,
      });
      const warnings = [];
      const output = new OutputSink({
        json: false,
        writeStdout: () => {},
        writeStderr: (t) => warnings.push(t),
      });

      let persistFailures = 0;
      const ctx = new OmrContext({
        opts: launchOpts(["--profile", "malware"]),
        cwd: tmp,
        env: makeTestEnv(),
        sources: [],
        sessionsRootDir: sessionsRoot,
        output,
        session,
        currentTarget: "/bins/target.elf",
        currentMagic: null,
        deps: {
          connectRea: async (dir) => new FakeRea(dir),
          createModelClient: () => new FakeModel([{ content: "done" }]),
          persistSessionHistory: async () => {
            persistFailures += 1;
            throw new Error("ENOSPC: no space left on device");
          },
        },
      });

      assert.equal(ctx.activeProfile?.id, "malware");
      assert.equal(
        ctx.modelController.modelInfo?.config.reasoningEffort,
        "high",
      );
      const sysPrompt = ctx.buildDynamicSystemPrompt();
      assert.ok(sysPrompt.includes("# Active Analyst Profile (malware)"));

      // Trigger two turns whose history persistence fails with ENOSPC; warning must be emitted once
      await ctx.runTurn("First turn", "t1");
      await ctx.runTurn("Second turn", "t2");
      assert.equal(persistFailures, 2);
      const historyWarnings = warnings.filter((w) =>
        w.includes("session persistence warning (history): ENOSPC"),
      );
      assert.equal(
        historyWarnings.length,
        1,
        "Expected OutputSink.warnPersistenceOnce to surface ENOSPC exactly once per scope",
      );

      await ctx.shutdown("complete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("orchestrates stateful Subagent Mesh & DAG: background spawn, depends_on chaining, step-by-step inspect, mid-flight & post-turn steering, and live graph rendering", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-subagent-mesh-"));
    try {
      const fakeRea = new FakeRea(tmp);
      const parentBroker = new ReaBroker(fakeRea);
      const collectedEv = [];

      // Model responder that inspects the system/user prompt to distinguish sub-1, sub-2, and steered turns
      const meshModel = new FakeModel((messages, _tools, step) => {
        const joined = messages.map((m) => m.content ?? "").join("\n");
        const hasSteerDirective = joined.includes(
          "[SUPERVISOR COURSE-CORRECTION / STEERING DIRECTIVE]",
        );

        // If steered, run procedure_pseudo_code on verify_hmac and report corrected finding
        if (hasSteerDirective) {
          const alreadyCalledPseudo = messages.some(
            (m) =>
              m.role === "assistant" &&
              (m.tool_calls ?? []).some(
                (tc) => tc.function?.name === "procedure_pseudo_code",
              ),
          );
          if (!alreadyCalledPseudo) {
            return {
              reasoning: "Supervisor steered me to inspect verify_hmac instead",
              toolCalls: [
                {
                  id: `steer_call_${step}`,
                  name: "procedure_pseudo_code",
                  arguments: { name: "verify_hmac" },
                },
              ],
            };
          }
          const toolOut = messages
            .filter((m) => m.role === "tool")
            .map((m) => m.content)
            .join(" ");
          return {
            content: `Steered correction complete: verify_hmac uses HMAC-SHA256 (${toolOut}).`,
          };
        }

        // Upstream sub-1: searches strings for AES_GCM
        if (joined.includes("OMR Subagent `sub-1-crypto-scout`")) {
          if (step === 0) {
            return {
              reasoning: "Scanning strings for initial cipher indicators",
              toolCalls: [
                {
                  id: "sub1_s1",
                  name: "search_strings",
                  arguments: { query: "AES_GCM" },
                },
              ],
            };
          }
          const toolOut = messages
            .filter((m) => m.role === "tool")
            .map((m) => m.content)
            .join(" ");
          return {
            content: `sub-1 initial finding: found AES_GCM table (${toolOut}).`,
          };
        }

        // Downstream sub-2 (depends on sub-1): verifies upstream context was injected
        if (joined.includes("OMR Subagent `sub-2-xref-correlator`")) {
          assert.ok(
            joined.includes("# Upstream Subagent DAG Inputs"),
            "Downstream sub-2 must receive upstream sub-1 findings automatically",
          );
          assert.ok(
            joined.includes("sub-1 initial finding"),
            "Downstream sub-2 must see sub-1's summary text",
          );
          if (step === 0) {
            return {
              reasoning: "Cross-referencing upstream AES_GCM finding in binary_overview",
              toolCalls: [
                {
                  id: "sub2_b1",
                  name: "binary_overview",
                  arguments: {},
                },
              ],
            };
          }
          const toolOut = messages
            .filter((m) => m.role === "tool")
            .map((m) => m.content)
            .join(" ");
          return {
            content: `sub-2 downstream synthesis complete (${toolOut}).`,
          };
        }

        return { content: "fallback" };
      });

      const runner = new SubagentRunner({
        getModel: () => meshModel,
        getBroker: async () => parentBroker,
        getTarget: () => "/bins/crypto.elf",
        getTargetFormat: () => "ELF64",
        getSessionDir: () => tmp,
        onEvidenceCollected: (ids) => collectedEv.push(...ids),
      });

      // 1. Spawn sub-1 in background mode AND sub-2 depending on sub-1 in background mode
      const sub1Bg = await runner.dispatchMetaTool({
        action: "spawn",
        mode: "background",
        role: "crypto-scout",
        workflow: "crypto",
        goal: "Locate cipher constants in .rodata",
      });
      assert.equal(sub1Bg.isError, false);
      assert.ok(sub1Bg.text.includes("sub-1-crypto-scout"));

      const sub2Bg = await runner.dispatchMetaTool({
        action: "spawn",
        mode: "background",
        role: "xref-correlator",
        workflow: "trace",
        goal: "Correlate upstream cipher constants with entrypoints",
        depends_on: ["sub-1"],
      });
      assert.equal(sub2Bg.isError, false);
      assert.ok(sub2Bg.text.includes("sub-2-xref-correlator"));

      // 2. Wait for both background subagents to complete their DAG execution
      const waited = await runner.waitFor();
      assert.equal(waited.length, 2);
      const snap1 = runner.getNodeSnapshot("sub-1");
      const snap2 = runner.getNodeSnapshot("sub-2");
      assert.ok(snap1 && snap1.status === "completed");
      assert.ok(snap2 && snap2.status === "completed");
      assert.deepEqual(snap2.dependsOn, ["sub-1-crypto-scout"]);
      assert.ok(snap1.stepsLog.length >= 2);
      assert.ok(snap1.evidenceIds.length >= 1);
      assert.ok(snap2.evidenceIds.length >= 1);

      // 3. Background completion notifications are queued for the primary agent's next turn
      const notes = runner.consumeCompletedNotifications();
      assert.ok(notes && notes.includes("sub-1-crypto-scout") && notes.includes("sub-2-xref-correlator"));
      assert.equal(runner.consumeCompletedNotifications(), null);

      // 4. Supervisor realizes sub-1 missed HMAC verification and steers sub-1 (post-turn stateful resume)
      const steerRes = await runner.steer(
        "sub-1",
        "You only checked AES_GCM; inspect verify_hmac with procedure_pseudo_code and correct your conclusion.",
      );
      assert.equal(steerRes.ok, true);
      assert.equal(steerRes.mode, "resumed-turn");
      assert.ok(
        steerRes.node?.summary.includes(
          "Steered correction complete: verify_hmac uses HMAC-SHA256",
        ),
      );
      assert.equal(steerRes.node?.steers.length, 1);

      // 5. Mid-flight steering: spawn live-worker in background, enqueue a mid-flight steer before it finishes step 1, and wait
      let sub3SteerTriggered = false;
      let runnerRef = null;
      const midFlightModel = new FakeModel((messages, _tools, step) => {
        const joined = messages.map((m) => m.content ?? "").join("\n");
        if (
          step === 0 &&
          !sub3SteerTriggered &&
          joined.includes("OMR Subagent `sub-1-live-worker`")
        ) {
          sub3SteerTriggered = true;
          // While sub-1-live-worker is actively mid-flight at step 0, supervisor enqueues a steer
          void runnerRef.steer(
            "sub-1",
            "Mid-flight pivot: check verify_hmac immediately.",
            { wait: false },
          );
          return {
            reasoning: "Starting initial scan before mid-flight steer lands",
            toolCalls: [
              {
                id: "sub3_s1",
                name: "search_strings",
                arguments: { query: "INIT" },
              },
            ],
          };
        }
        if (
          joined.includes("[SUPERVISOR COURSE-CORRECTION / STEERING DIRECTIVE]")
        ) {
          return {
            content: "Mid-flight steer honored on next step boundary!",
          };
        }
        return { content: "unsteered" };
      });
      runnerRef = new SubagentRunner({
        getModel: () => midFlightModel,
        getBroker: async () => parentBroker,
        getTarget: () => "/bins/crypto.elf",
        getTargetFormat: () => "ELF64",
        getSessionDir: () => tmp,
      });
      const { node: sub3Node, promise: sub3Promise } = runnerRef.spawnNode({
        role: "live-worker",
        mode: "background",
        goal: "Initial scan",
      });
      assert.equal(sub3Node.id, "sub-1-live-worker");
      const sub3Result = await sub3Promise;
      assert.equal(sub3Result.ok, true);
      assert.equal(
        sub3Result.summary,
        "Mid-flight steer honored on next step boundary!",
      );
      const snap3 = runnerRef.getNodeSnapshot("sub-1");
      assert.equal(snap3?.steers[0]?.mode, "mid-flight");

      // 6. Verify graph & step-by-step inspector rendering and subagents.json persistence
      const graphSnap = runner.graphSnapshot();
      const graphText = renderSubagentGraph(graphSnap);
      assert.ok(graphText.includes("OMR SUBAGENT MESH DAG"));
      assert.ok(graphText.includes("[sub-1-crypto-scout] (crypto-scout)"));
      assert.ok(graphText.includes("[sub-2-xref-correlator] (xref-correlator)"));
      assert.ok(graphText.includes("depends_on: sub-1-crypto-scout"));
      assert.ok(graphText.includes("steer #1"));

      const inspectText = renderSubagentInspector(
        runner.getNodeSnapshot("sub-1"),
      );
      assert.ok(inspectText.includes("SUBAGENT INSPECTOR · sub-1-crypto-scout"));
      assert.ok(inspectText.includes("steers (1):"));
      assert.ok(inspectText.includes("step-by-step execution trace"));
      assert.ok(inspectText.includes("procedure_pseudo_code"));
      assert.equal(existsSync(join(tmp, "subagents.json")), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("Crash-resume: an interrupted turn continues without a manual 'continue'", () => {
  const run = async (tmp, flags, model) => {
    const out = [];
    const err = [];
    const code = await runOmr(launchOpts(["--json", ...flags]), {
      cwd: tmp,
      env: makeTestEnv(),
      sessionsRootDir: join(tmp, "sessions"),
      connectRea: async (sessionDir) => new FakeRea(sessionDir),
      createModelClient: () => model,
      writeStdout: (t) => out.push(t),
      writeStderr: (t) => err.push(t),
    });
    const events = out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { code, events, err: err.join("") };
  };

  it("checkpoints each finished step, so a turn that dies mid-way resumes from its last tool result", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-crash-"));
    try {
      const targetPath = join(tmp, "sample.bin");
      await writeFile(
        targetPath,
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      );

      // Run 1: two productive steps, then the process-equivalent dies (non-retryable model failure).
      const dying = new FakeModel(async (_messages, _tools, idx) => {
        if (idx < 2) {
          return {
            toolCalls: [
              { name: "search_strings", arguments: { query: `flag${idx}` } },
            ],
          };
        }
        throw new Error("boom: simulated crash");
      });
      const first = await run(tmp, [targetPath, "find the flag"], dying);
      assert.match(first.err, /boom: simulated crash/);

      const saved = await loadSavedSession("last", undefined, join(tmp, "sessions"));
      assert.ok(saved);
      assert.equal(saved.inFlight, true, "the unfinished turn stays flagged in-flight");
      assert.equal(saved.messages.at(-1).role, "tool", "history ends on the last completed tool result");
      assert.equal(saved.messages.filter((m) => m.role === "tool").length, 2);

      // Run 2: --resume picks the investigation back up on its own.
      const recovered = new FakeModel([{ content: "flag found, finishing the report" }]);
      const second = await run(tmp, ["--resume", "/status"], recovered);
      const resumeResult = second.events.find(
        (e) => e.type === "command.result" && e.command === "resume",
      );
      assert.ok(resumeResult, "resume ran before the one-shot command");
      assert.equal(resumeResult.payload.interrupted_turn, true);

      assert.equal(recovered.requests.length, 1, "exactly one automatic continuation turn");
      const sent = recovered.requests[0].messages;
      assert.equal(sent.filter((m) => m.role === "tool").length, 2, "completed tool results are carried over");
      assert.match(sent.at(-1).content, /\[omr:auto-resume\]/);
      assert.ok(second.events.some((e) => e.type === "assistant"));

      // Once the continuation finishes, the session is no longer in-flight.
      const sessions = join(tmp, "sessions");
      const final = await loadSavedSession("last", undefined, sessions);
      assert.equal(final.inFlight, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("restores a finished session without sending anything to the model", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-resume-done-"));
    try {
      const done = new FakeModel([{ content: "all done" }]);
      await run(tmp, ["--no-model", "/status"], done); // creates an (empty) session only
      const info = await createSession(null, null, {
        rootDir: join(tmp, "sessions"),
        suffix: "finished",
      });
      const { saveSessionHistory } = await import("../dist/session.js");
      await saveSessionHistory(
        info,
        [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        null,
        "m",
      );
      const idle = new FakeModel([{ content: "must not be called" }]);
      const res = await run(tmp, ["--resume", "/status"], idle);
      const resumeResult = res.events.find(
        (e) => e.type === "command.result" && e.command === "resume",
      );
      assert.ok(resumeResult);
      assert.equal(resumeResult.payload.interrupted_turn, false);
      assert.equal(idle.requests.length, 0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("Cyber/RE Tool Forge (/forge), /failover, /budget, /net, and /report dossier export", () => {
  it("installs /forge cyber presets, manages /failover & /budget & /net, and exports Markdown + JSON dossiers via /report", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-forge-report-"));
    try {
      const targetPath = join(tmp, "sample.bin");
      await writeFile(
        targetPath,
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      );

      const env = {
        ...makeTestEnv(),
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        XDG_CONFIG_HOME: join(tmp, "xdg"),
      };
      const fakeModel = new FakeModel([
        {
          content:
            "Capability mapped to T1055 (`[ev_1111111111111111111111111111111111111111111111111111111111111111]`) and residual unknown `[unk_custom_ packer]`.\n```python\nprint('extractor ok')\n```",
        },
      ]);

      const runCmd = async (args) => {
        const out = [];
        const err = [];
        const code = await runOmr(launchOpts(["--json", ...args]), {
          cwd: tmp,
          env,
          sessionsRootDir: join(tmp, "sessions"),
          connectRea: async (sessionDir) => new FakeRea(sessionDir),
          createModelClient: () => fakeModel,
          writeStdout: (t) => out.push(t),
          writeStderr: (t) => err.push(t),
        });
        const events = out
          .join("")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return { code, events, err: err.join("") };
      };

      // 1. /forge list & /forge install all
      const forgeList = await runCmd(["--no-model", "/forge list"]);
      const listEvt = forgeList.events.find(
        (e) => e.type === "command.result" && e.command === "forge",
      );
      assert.ok(listEvt);
      assert.equal(listEvt.payload.presets.length, 6);

      const forgeInstall = await runCmd(["--no-model", "/forge install all"]);
      const installEvt = forgeInstall.events.find(
        (e) => e.type === "command.result" && e.command === "forge",
      );
      assert.ok(installEvt);
      assert.equal(installEvt.payload.installed.length, 6);
      assert.equal(
        existsSync(join(tmp, ".omr", "commands", "config-extractor.md")),
        true,
      );
      assert.equal(
        existsSync(join(tmp, ".omr", "commands", "capa-hunter.md")),
        true,
      );

      // 2. /failover, /budget, and /net
      const failoverRes = await runCmd([
        "/failover anthropic:claude-sonnet-4-6 --save",
      ]);
      const failoverEvt = failoverRes.events.find(
        (e) => e.type === "command.result" && e.command === "failover",
      );
      assert.ok(failoverEvt);
      assert.deepEqual(failoverEvt.payload.fallback_models, [
        "anthropic:claude-sonnet-4-6",
      ]);

      const budgetRes = await runCmd(["/budget 250k --save"]);
      const budgetEvt = budgetRes.events.find(
        (e) => e.type === "command.result" && e.command === "budget",
      );
      assert.ok(budgetEvt);
      assert.equal(budgetEvt.payload.budget_tokens, 250_000);

      const netRes = await runCmd(["/net status"]);
      const netEvt = netRes.events.find(
        (e) => e.type === "command.result" && e.command === "net",
      );
      assert.ok(netEvt);
      assert.equal(netEvt.payload.endpoint, "https://api.openai.com/v1");

      // 3. Run /capa workflow and then export standalone Markdown & JSON forensic dossiers via /report
      const capaRun = await runCmd([targetPath, "/capa process injection"]);
      assert.equal(capaRun.code, 0);

      const mdPath = join(tmp, "out-dossier.md");
      const jsonPath = join(tmp, "out-dossier.json");

      const reportMd = await runCmd(["--resume", `/report export ${mdPath}`]);
      const mdEvt = reportMd.events.find(
        (e) => e.type === "command.result" && e.command === "report",
      );
      assert.ok(mdEvt);
      assert.equal(mdEvt.payload.format, "markdown");
      assert.equal(existsSync(mdPath), true);
      const mdText = await readFile(mdPath, "utf8");
      assert.match(mdText, /# OMR Forensic Session Dossier/);
      assert.match(mdText, /ev_1111111111111111111111111111111111111111111111111111111111111111/);

      const reportJson = await runCmd(["--resume", `/report json ${jsonPath}`]);
      const jsonEvt = reportJson.events.find(
        (e) => e.type === "command.result" && e.command === "report",
      );
      assert.ok(jsonEvt);
      assert.equal(jsonEvt.payload.format, "json");
      const parsedJson = JSON.parse(await readFile(jsonPath, "utf8"));
      assert.equal(parsedJson.protocol, "omr-report/v1");
      assert.ok(
        parsedJson.evidence_ids.includes(
          "ev_1111111111111111111111111111111111111111111111111111111111111111",
        ),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
