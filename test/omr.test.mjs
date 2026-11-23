import { englishI18n } from "../dist/i18n/index.js";

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createTheme,
  renderMarkdown,
  sanitizeText,
  stripAnsi,
  visibleWidth,
} from "../dist/ansi.js";
import { parseArgs } from "../dist/args.js";
import {
  inspectTargetMagic,
  renderBinaryLane,
  renderHeroLines,
} from "../dist/binaryArt.js";
import { Agent, compactToolOutput } from "../dist/agent.js";
import {
  ReaBroker,
  compactJsonSchema,
  isReadOnlyToolCall,
  rankCatalogTools,
  selectRouteToolNames,
  truncateToolResult,
} from "../dist/broker.js";
import {
  BROWSER_TOOLS,
  BrowserManager,
  buildChromiumLaunchArgs,
  buildFirefoxProfilePrefs,
  discoverInstalledBrowsers,
  renderBrowserStatus,
} from "../dist/browser.js";
import { COMMANDS, findCommand } from "../dist/commands.js";
import { networkIsolationAvailable } from "../dist/exec.js";
import { LOOP_LIMIT, LoopGuard } from "../dist/loopGuard.js";
import { parseExports } from "../dist/env.js";
import { JournalTailer, readFileTail } from "../dist/journal.js";
import {
  FailoverModelClient,
  ModelClient,
  anthropicThinkingStyle,
  buildAnthropicPayload,
  formatPingTarget,
  isNetworkOutageError,
  probeEndpointConnectivity,
  resolveProxyForEndpoint,
  toOpenAiMessages,
} from "../dist/model.js";
import {
  OPERATOR_PRECEDENCE_NOTE,
  listGuideTopics,
  readGuide,
} from "../dist/guide.js";
import {
  COMPACTION_MODES,
  SUMMARY_MARKER,
  findCutPoint,
  normalizeCompactionModelSpec,
  parseCompactionStrategy,
  resolveCompactionSettings,
  resolveThresholdTokens,
  shouldCompact,
} from "../dist/compaction.js";
import { buildSnapcompactArchive } from "../dist/snapcompact.js";
import {
  REASONING_EFFORT_LEVELS,
  estimateSessionCostUsd,
  parseFallbackModelsSpec,
  parseReasoningEffort,
  parseTokenBudgetSpec,
  readStoredModelConfig,
  resolveModelConfig,
  saveReasoningEffortDefault,
  saveDefaultModelConfig,
  saveModelRuntimeSettings,
  splitProviderModelSpec,
  withReasoningEffort,
} from "../dist/modelConfig.js";
import {
  OMR_WORKFLOWS,
  adbPrompt,
  auditPrompt,
  autonomousWorkflowNote,
  browserPrompt,
  capaPrompt,
  comparePrompt,
  crashPrompt,
  cryptoPrompt,
  deobfuscatePrompt,
  diffCvePrompt,
  explainPrompt,
  findOmrWorkflow,
  firmwarePrompt,
  forgePrompt,
  fridaPrompt,
  investigatePrompt,
  iocPrompt,
  masvsPrompt,
  matchWorkflowsForInput,
  protocolPrompt,
  sandboxPrompt,
  sbomPrompt,
  scriptPrompt,
  surfacePrompt,
  systemPrompt,
  tracePrompt,
  triagePrompt,
  unpackPrompt,
} from "../dist/prompts.js";
import {
  BUILTIN_PROVIDERS,
  discoverProvidersSync,
  fetchProviderModels,
} from "../dist/providers.js";
import {
  createSession,
  deriveSessionTitle,
  evidenceIdsInMessages,
  formatShortSessionId,
  PROJECT_INSTRUCTIONS_LIMIT,
  extractCodeBlocks,
  listRecentSessions,
  loadSavedSession,
  readInstructionFile,
  readOperatorDirective,
  readProjectInstructions,
  saveCodeBlockToDisk,
  saveSessionHistory,
  writeOperatorDirective,
} from "../dist/session.js";
import { TerminalUi } from "../dist/tui.js";
import {
  isKlipperImagePlaceholder,
  readImageFromClipboard,
  readKdeKlipperClipboardImage,
  readKdeKlipperClipboardText,
  readTextFromClipboard,
} from "../dist/clipboard.js";
import {
  captureScreenshot,
  completeAtMention,
  decodePngRgba,
  describeAttachedImagesFallback,
  encodeRgbPng,
  extractPromptMentions,
  inspectImageForensics,
  isImageFilePath,
  loadImageSource,
  osc8FileLink,
  renderAnsiImagePreview,
  renderBinaryVisualForensicsPng,
  transcodeBmpToPng,
} from "../dist/vision.js";

const englishUi = await englishI18n();

describe("ansi sanitization, width, and markdown", () => {
  it("strips dangerous terminal escape sequences and expands tabs", () => {
    const malicious =
      "safe\x1b]52;c;SGVsbG8=\x07\x1b[2J\x1b[31m\tindented\r\nnext\x07";
    const clean = sanitizeText(malicious, 2);
    assert.equal(clean, "safe  indented\nnext");
    assert.equal(clean.includes("\x1b"), false);
  });

  it("renders forensic markdown sections, code blocks, and evidence badges within width", () => {
    const theme = createTheme({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    const evId = `ev_${"9f2a4c1d".repeat(8)}`;
    const md = [
      "## Observed",
      `- License check at \`0x4012a0\` cites ${evId} in Turkish: şğüöçıİ.`,
      "```c",
      "int check_key(const char *buf) {\n\treturn buf[0] == 0x7f; // magic\n}",
      "```",
      "## Inferred",
      "- Gate controls playback.",
      "## Unresolved",
      "- Key rotation schedule — unk_abc12345",
    ].join("\n");

    const width = 56;
    const lines = renderMarkdown(md, width, theme, true);
    assert.ok(lines.length > 6);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `expected line width <= ${width}, got ${visibleWidth(line)}: ${stripAnsi(line)}`,
      );
    }
    const plainJoined = lines.map(stripAnsi).join("\n");
    assert.match(plainJoined, /OBSERVED/);
    assert.match(plainJoined, /INFERRED/);
    assert.match(plainJoined, /UNRESOLVED/);
    assert.match(plainJoined, /⟦ev_9f2a4c1d9f…4c1d⟧/);
  });
});

describe("binary magic & flowing binary art", () => {
  it("classifies ELF64 and APK magic headers from first 64 bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-magic-"));
    try {
      const elfPath = join(dir, "sample.elf");
      const apkPath = join(dir, "sample.apk");
      await writeFile(
        elfPath,
        Buffer.from([
          0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 1, 2, 3, 4,
        ]),
      );
      await writeFile(
        apkPath,
        Buffer.from([
          0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 5, 6, 7, 8,
        ]),
      );

      const elfMagic = await inspectTargetMagic(elfPath);
      const apkMagic = await inspectTargetMagic(apkPath);
      assert.equal(elfMagic?.label, "ELF 64-bit LSB");
      assert.equal(apkMagic?.label, "Android APK");

      const theme = createTheme({
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      });
      const lane = renderBinaryLane(26, 7, 1, elfMagic.bytes, theme, 1);
      assert.equal(visibleWidth(lane), 26);

      const hero = renderHeroLines({
        i18n: englishUi,
        width: 92,
        height: 28,
        tick: 4,
        binaryEnabled: true,
        model: "riverai/deepseek-ai/DeepSeek-V4.1",
        reaConnected: true,
        reaTools: 246,
        target: apkPath,
        magic: apkMagic,
        candidates: [apkPath],
        sessionId: "2026-session",
        theme,
      });
      assert.ok(hero.some((l) => stripAnsi(l).includes("OH-MY-REA")));
      for (const l of hero) {
        assert.ok(visibleWidth(l) <= 92);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI args, shell env, and model config resolution", () => {
  it("distinguishes slash commands from real filesystem paths", () => {
    assert.equal(parseArgs(["node", "omr", "/status"]).command, "/status");
    assert.equal(
      parseArgs(["node", "omr", "/triage", "auth"]).command,
      "/triage auth",
    );
    assert.equal(
      parseArgs(["node", "omr", "/usr/bin/env"]).target,
      "/usr/bin/env",
    );
    const withEq = parseArgs([
      "node",
      "omr",
      "--model=custom-m",
      "app.apk",
      "check gate",
    ]);
    assert.equal(withEq.model, "custom-m");
    assert.equal(withEq.target, "app.apk");
    assert.equal(withEq.goal, "check gate");
  });

  it("expands $HOME and strips unquoted comments in rea-env.sh", () => {
    const out = {};
    parseExports(
      [
        'export REA_GHIDRA_INSTALL_DIR="$HOME/tools/ghidra"',
        "export REA_UNBLOB_BIN=~/bin/unblob # inline comment",
        "export KEEP_HASH='val#not-comment'",
      ].join("\n"),
      out,
      "/home/tester",
    );
    assert.equal(out["REA_GHIDRA_INSTALL_DIR"], "/home/tester/tools/ghidra");
    assert.equal(out["REA_UNBLOB_BIN"], "/home/tester/bin/unblob");
    assert.equal(out["KEEP_HASH"], "val#not-comment");
  });

  it("allows --model override even when config file has no default model field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-cfg-"));
    try {
      const reaCfg = join(dir, "rea");
      await rm(reaCfg, { recursive: true, force: true });
      const { mkdir } = await import("node:fs/promises");
      await mkdir(reaCfg, { recursive: true });
      await writeFile(
        join(reaCfg, "omr-model.json"),
        JSON.stringify({
          base_url: "https://example.test/v1/",
          api_key_env: "TEST_KEY",
        }),
      );
      const resolved = resolveModelConfig(
        { XDG_CONFIG_HOME: dir, TEST_KEY: "secret-val" },
        "override-model-v1",
      );
      assert.equal(resolved.config.model, "override-model-v1");
      assert.equal(resolved.config.baseUrl, "https://example.test/v1");
      assert.equal(resolved.keySource, "env TEST_KEY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ModelClient streaming & Agent history invariants", () => {
  it("streams reasoning_content and separates multiple index-less tool calls", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { reasoning_content: "Analyzing header... " } }] },
        { choices: [{ delta: { content: "Checking session." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_a",
                    function: { name: "binary_session", arguments: "{}" },
                  },
                  {
                    id: "call_b",
                    function: {
                      name: "list_unknowns",
                      arguments: '{"limit":5}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        },
      ];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const client = new ModelClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "test-model",
        apiKey: "k",
        apiKeyEnv: "K",
        maxTokens: 512,
        temperature: null,
        maxSteps: 5,
        timeoutMs: 5000,
      });
      let text = "";
      let reasoning = "";
      const result = await client.stream(
        [{ role: "user", content: "hi" }],
        [],
        undefined,
        (d) => {
          text += d;
        },
        (r) => {
          reasoning += r;
        },
      );
      assert.equal(reasoning, "Analyzing header... ");
      assert.equal(text, "Checking session.");
      assert.equal(result.toolCalls.length, 2);
      assert.equal(result.toolCalls[0].function.name, "binary_session");
      assert.equal(result.toolCalls[1].function.name, "list_unknowns");
      assert.equal(result.usage?.total_tokens, 30);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refreshes dynamic systemPrompt per turn and closes remaining tool_calls on abort", async () => {
    let activeTarget = null;
    const abortController = new AbortController();
    let stepCalls = 0;

    const fakeModel = {
      model: "fake-model",
      async stream(messages) {
        stepCalls += 1;
        if (stepCalls === 1) {
          assert.match(messages[0].content, /none bound yet/);
          return {
            content: "Running two tools",
            reasoning: "",
            toolCalls: [
              {
                id: "tc_1",
                type: "function",
                function: { name: "tool_one", arguments: "{}" },
              },
              {
                id: "tc_2",
                type: "function",
                function: { name: "tool_two", arguments: "{}" },
              },
            ],
            finishReason: "tool_calls",
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          };
        }
        assert.match(messages[0].content, /\/tmp\/updated\.apk/);
        return {
          content: "Second turn succeeded cleanly",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        };
      },
    };

    const fakeBroker = {
      definitions: () => [],
      async dispatch(name) {
        if (name === "tool_one") {
          // Simulate user pressing Esc/Ctrl+C right as tool_one finishes before tool_two starts!
          abortController.abort();
        }
        return {
          tool: name,
          text: '{"ok":true}',
          isError: false,
          durationMs: 5,
          evidenceIds: [],
        };
      },
    };

    const agent = new Agent(fakeModel, fakeBroker, {
      systemPrompt: () =>
        systemPrompt({
          target: activeTarget,
          targetOpened: Boolean(activeTarget),
          sessionDir: "/tmp/s",
          journalPath: "/tmp/s/journal.jsonl",
          directTools: ["binary_session"],
        }),
      maxSteps: 4,
    });

    const abortedTurn = await agent.run(
      "first question",
      {},
      abortController.signal,
    );
    assert.equal(abortedTurn.aborted, true);

    // Every assistant tool_call MUST have a matching role="tool" entry in agent.history!
    const toolReplies = agent.history.filter((m) => m.role === "tool");
    assert.equal(toolReplies.length, 2);
    assert.equal(toolReplies[0].tool_call_id, "tc_1");
    assert.equal(toolReplies[1].tool_call_id, "tc_2");

    // Subsequent turn with updated target refreshes systemPrompt and succeeds!
    activeTarget = "/tmp/updated.apk";
    const secondTurn = await agent.run("second question");
    assert.equal(secondTurn.aborted, false);
    assert.equal(secondTurn.text, "Second turn succeeded cleanly");
    assert.equal(agent.totalTokens, 35);
  });
});

describe("TerminalUi layout & frame invariants", () => {
  it("renders exact dimensions without overflow across narrow, standard, and ultrawide screens", () => {
    const theme = createTheme({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });

    ui.setStatus({
      model: "riverai/deepseek-ai/DeepSeek-V4.1-Flash-1017",
      target: "/tmp/demo.apk",
      reaConnected: true,
      reaTools: 246,
      evidence: 5,
      unknowns: 1,
      journal: 19,
      tokens: 4280,
      session: "2026-11-08-demo",
    });

    // 1. Hero view across viewport sizes
    for (const [cols, rows] of [
      [54, 15],
      [80, 24],
      [136, 38],
    ]) {
      const frame = ui.renderFrame(cols, rows);
      assert.equal(frame.lines.length, rows);
      for (const line of frame.lines) {
        assert.ok(
          visibleWidth(line) <= cols,
          `Hero overflow (${visibleWidth(line)} > ${cols})`,
        );
      }
      assert.ok(frame.cursor.row >= 1 && frame.cursor.row <= rows);
      assert.ok(frame.cursor.col >= 1 && frame.cursor.col <= cols);
    }

    // 2. Timeline with user prompt, reasoning, inline tool tree, and assistant markdown
    ui.addUser("/investigate check entitlement gate");
    ui.appendReasoning(
      "Inspecting AndroidManifest and searching license classes...",
    );
    ui.toolStart("c1", "inspect_android_package", { path: "/tmp/demo.apk" });
    ui.toolEnd("c1", "inspect_android_package", true, 312, [
      `ev_${"a1b2c3d4".repeat(8)}`,
    ]);
    ui.beginAssistant();
    ui.appendAssistant(
      "## Observed\n- Gate in `com.demo.Auth` cites ev_" + "a1b2c3d4".repeat(8),
    );
    ui.endAssistant("", "1.2s · 2 steps · 1 tool · +1 evidence");

    for (const [cols, rows] of [
      [60, 16],
      [80, 24],
      [140, 36],
    ]) {
      const frame = ui.renderFrame(cols, rows);
      assert.equal(frame.lines.length, rows);
      for (const line of frame.lines) {
        assert.ok(
          visibleWidth(line) <= cols,
          `Timeline overflow (${visibleWidth(line)} > ${cols})`,
        );
      }
      const joined = frame.lines.map(stripAnsi).join("\n");
      assert.match(joined, /inspect_android_package/);
    }

    // 3. Output modal opens top-aligned at line 1 (not scrolled to bottom)
    const manyLines = Array.from(
      { length: 60 },
      (_, i) => `row-${i + 1}: output content`,
    ).join("\n");
    ui.showOutput("/status", manyLines);
    const drawerFrame = ui.renderFrame(80, 24);
    assert.match(
      drawerFrame.lines.map(stripAnsi).join("\n"),
      /row-1: output content/,
    );

    // 4. Binary modes support continuous on / eco / busy / off ("always" normalizes to "on")
    assert.equal(ui.setBinaryMode("always"), "on");
    assert.equal(ui.setBinaryMode(), "eco");
    assert.equal(ui.setBinaryMode(), "busy");
    assert.equal(ui.setBinaryMode(), "off");
    assert.equal(ui.setBinaryMode(), "on");
    for (const width of [120, 68, 136]) {
      const resized = ui.renderFrame(width, 28);
      for (const line of resized.lines) {
        assert.ok(visibleWidth(line) <= width);
      }
    }

    // 5. Interactive Model & Provider Picker + Step-2 Thinking Effort bar render cleanly across all viewport sizes
    const providers = discoverProvidersSync({
      OPENAI_API_KEY: "sk-openai-secret-do-not-print",
      ANTHROPIC_API_KEY: "sk-ant-secret-do-not-print",
      OPENROUTER_API_KEY: "sk-or-secret-do-not-print",
    });
    let picked = null;
    let pickedEffort = null;
    const pickerUi = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      providers: () => providers,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSelectModel: (providerId, modelId, effort, saveDefault) => {
        picked = { providerId, modelId, effort, saveDefault };
      },
      onSelectEffort: (effort, saveDefault) => {
        pickedEffort = { effort, saveDefault };
      },
    });
    pickerUi.openModelPicker(
      providers,
      "openai",
      "gpt-4.1",
      null,
      false,
      "medium",
    );
    assert.equal(pickerUi.isModelPickerOpen, true);

    for (const [cols, rows] of [
      [54, 15],
      [80, 24],
      [136, 38],
    ]) {
      const mFrame = pickerUi.renderFrame(cols, rows);
      assert.equal(mFrame.lines.length, rows);
      for (const line of mFrame.lines) {
        assert.ok(
          visibleWidth(line) <= cols,
          `Model picker overflow (${visibleWidth(line)} > ${cols}): ${stripAnsi(line)}`,
        );
        // Secret API keys must NEVER appear in rendered frames
        assert.equal(stripAnsi(line).includes("sk-openai-secret"), false);
        assert.equal(stripAnsi(line).includes("sk-ant-secret"), false);
      }
    }

    // Also test standalone /effort (Alt+E) Thinking Effort modal bar across narrow & wide viewports
    pickerUi.openEffortPicker(
      providers,
      "anthropic",
      "claude-sonnet-4-5",
      "high",
    );
    for (const [cols, rows] of [
      [54, 15],
      [80, 24],
      [136, 38],
    ]) {
      const eFrame = pickerUi.renderFrame(cols, rows);
      assert.equal(eFrame.lines.length, rows);
      assert.equal(eFrame.cursor.visible, false);
      for (const line of eFrame.lines) {
        assert.ok(
          visibleWidth(line) <= cols,
          `Effort picker overflow (${visibleWidth(line)} > ${cols}): ${stripAnsi(line)}`,
        );
      }
      const joinedEffort = eFrame.lines.map(stripAnsi).join("\n");
      assert.match(joinedEffort, /THINKING EFFORT/);
      assert.match(joinedEffort, /high/);
    }
    pickerUi.closeModelPicker();
    assert.equal(pickerUi.isModelPickerOpen, false);
    assert.equal(picked, null);
    assert.equal(pickedEffort, null);
  });
});

describe("Multi-provider catalog, Anthropic native protocol, and additive config backup", () => {
  it("discovers 33+ providers, parses provider:model safely, and backs up config without leaking env secrets", async () => {
    assert.ok(
      BUILTIN_PROVIDERS.length >= 33,
      `expected >= 33 providers, got ${BUILTIN_PROVIDERS.length}`,
    );
    const dir = await mkdtemp(join(tmpdir(), "omr-prov-"));
    try {
      const env = {
        XDG_CONFIG_HOME: dir,
        ANTHROPIC_API_KEY: "super-secret-anthropic-key",
        GEMINI_API_KEY: "super-secret-gemini-key",
      };
      const providers = discoverProvidersSync(env);
      const anthropic = providers.find((p) => p.id === "anthropic");
      const gemini = providers.find((p) => p.id === "gemini");
      const groq = providers.find((p) => p.id === "groq");
      assert.equal(anthropic?.connected, true);
      assert.equal(anthropic?.protocol, "anthropic-messages");
      assert.equal(gemini?.connected, true);
      assert.equal(groq?.connected, false);

      // Preserves `/` in router models and `:tag` in Ollama models while splitting known `provider:model`
      assert.deepEqual(
        splitProviderModelSpec("deepseek-ai/DeepSeek-V4.1", providers),
        {
          providerId: null,
          modelId: "deepseek-ai/DeepSeek-V4.1",
        },
      );
      assert.deepEqual(splitProviderModelSpec("qwen3:32b", providers), {
        providerId: null,
        modelId: "qwen3:32b",
      });
      assert.deepEqual(splitProviderModelSpec("ollama:qwen3:32b", providers), {
        providerId: "ollama",
        modelId: "qwen3:32b",
      });
      assert.deepEqual(
        splitProviderModelSpec("anthropic:claude-sonnet-4-5", providers),
        {
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
        },
      );

      // Zero-config auto-detection picks first connected provider (anthropic here)
      const autoResolved = resolveModelConfig(env);
      assert.equal(autoResolved.config.providerId, "anthropic");
      assert.equal(autoResolved.config.protocol, "anthropic-messages");

      // First save creates omr-model.json without backup; second save creates .bak backup
      const firstSave = saveDefaultModelConfig(autoResolved, env);
      assert.equal(firstSave.backupPath, null);
      const geminiResolved = resolveModelConfig(env, "gemini:gemini-2.5-pro");
      const secondSave = saveDefaultModelConfig(geminiResolved, env);
      assert.equal(secondSave.backupPath, `${secondSave.path}.bak`);

      const stored = readStoredModelConfig(env);
      assert.equal(stored?.provider, "gemini");
      assert.equal(stored?.model, "gemini-2.5-pro");
      assert.equal(stored?.api_key_env, "GEMINI_API_KEY");
      assert.equal(
        "api_key" in (stored ?? {}),
        false,
        "must never write raw env secret to disk",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams native Anthropic /v1/messages thinking, text, and tool_use / tool_result blocks", async () => {
    let capturedHeaders = null;
    let capturedBody = null;

    const server = createServer(async (req, res) => {
      capturedHeaders = req.headers;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      capturedBody = JSON.parse(raw);

      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = [
        [
          "message_start",
          { type: "message_start", message: { usage: { input_tokens: 42 } } },
        ],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "thinking_delta",
              thinking: "Inspecting ELF dynamic table.",
            },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Calling binary_overview." },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "toolu_01",
              name: "binary_overview",
              input: {},
            },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '{"detail":' },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '"summary"}' },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 2 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 18 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      for (const [ev, data] of sse) {
        res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const client = new ModelClient({
        providerId: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "claude-sonnet-4-5",
        apiKey: "ant-test-key",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        maxTokens: 1024,
        temperature: null,
        maxSteps: 5,
        timeoutMs: 5000,
      });

      let text = "";
      let thinking = "";
      const out = await client.stream(
        [
          { role: "system", content: "Forensic system prompt" },
          { role: "user", content: "Check ELF" },
          {
            role: "assistant",
            content: "Opening",
            tool_calls: [
              {
                id: "toolu_prev",
                type: "function",
                function: {
                  name: "open_binary",
                  arguments: '{"path":"/tmp/a"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "toolu_prev",
            name: "open_binary",
            content: '{"ok":true}',
          },
        ],
        [
          {
            type: "function",
            function: {
              name: "binary_overview",
              description: "Overview",
              parameters: {
                type: "object",
                properties: { detail: { type: "string" } },
              },
            },
          },
        ],
        undefined,
        (d) => {
          text += d;
        },
        (r) => {
          thinking += r;
        },
      );

      assert.equal(capturedHeaders["x-api-key"], "ant-test-key");
      assert.equal(capturedHeaders["anthropic-version"], "2023-06-01");
      assert.equal(capturedBody.system[0].text, "Forensic system prompt");
      assert.equal(capturedBody.system[0].cache_control.type, "ephemeral");
      assert.equal(capturedBody.messages.at(-1).role, "user");
      assert.equal(capturedBody.messages.at(-1).content[0].type, "tool_result");
      assert.equal(thinking, "Inspecting ELF dynamic table.");
      assert.equal(text, "Calling binary_overview.");
      assert.equal(out.finishReason, "tool_calls");
      assert.equal(out.toolCalls.length, 1);
      assert.equal(out.toolCalls[0].function.name, "binary_overview");
      assert.equal(out.toolCalls[0].function.arguments, '{"detail":"summary"}');
      assert.equal(out.usage?.total_tokens, 60);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("maps omp-style thinking effort levels across Anthropic budgets, OpenAI fallback, and English OMR identity", async () => {
    assert.equal(REASONING_EFFORT_LEVELS.length, 7);
    assert.equal(parseReasoningEffort("none"), "off");
    assert.equal(parseReasoningEffort("max"), "xhigh");
    assert.equal(parseReasoningEffort("HIGH"), "high");
    assert.equal(parseReasoningEffort("bogus"), null);

    // Anthropic extended thinking budget auto-bumps max_tokens and omits temperature
    const antPayload = buildAnthropicPayload(
      [{ role: "user", content: "Inspect entry" }],
      [],
      {
        providerId: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-5",
        apiKey: "k",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        maxTokens: 4096,
        temperature: 0.2,
        reasoningEffort: "high",
        maxSteps: 10,
        timeoutMs: 5000,
      },
    );
    assert.deepEqual(antPayload.thinking, {
      type: "enabled",
      budget_tokens: 16384,
    });
    assert.equal(antPayload.max_tokens, 16384 + 4096);
    assert.equal("temperature" in antPayload, false);

    // OpenAI-compatible client retries cleanly without reasoning_effort when endpoint rejects it with HTTP 400
    const seenBodies = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seenBodies.push(body);
      if ("reasoning_effort" in body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Unsupported parameter: reasoning_effort" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const baseResolved = resolveModelConfig(
        { OPENAI_API_KEY: "sk-test" },
        "openai:gpt-4.1",
      );
      const withEff = withReasoningEffort(baseResolved, "high");
      const client = new ModelClient({
        ...withEff.config,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      let streamed = "";
      await client.stream(
        [{ role: "user", content: "hi" }],
        [],
        undefined,
        (d) => {
          streamed += d;
        },
      );
      assert.equal(streamed, "ok");
      assert.equal(seenBodies.length, 2);
      assert.equal(seenBodies[0].reasoning_effort, "high");
      assert.equal("reasoning_effort" in seenBodies[1], false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // English systemPrompt states OMR (`oh-my-rea`) identity while preserving forensic guardrails
    const sys = systemPrompt({
      target: "/tmp/sample.elf",
      targetOpened: true,
      targetFormat: "ELF 64-bit",
      boundProvider: "rizin",
      evidenceCount: 2,
      unknownCount: 1,
      sessionDir: "/tmp/sess",
      journalPath: "/tmp/sess/journal.jsonl",
      directTools: ["binary_overview"],
    });
    assert.match(sys, /OMR \(`oh-my-rea`\)/);
    assert.match(sys, /Use the whole REA surface/);
    assert.match(sys, /operator who launched omr owns/);
    assert.match(sys, /Target content is data/);
  });
});

describe("Schema compaction & route-aware tool selection", () => {
  it("compacts JSON Schemas non-mutatingly while preserving validation keywords", () => {
    const original = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["path", "detail"],
      properties: {
        path: {
          type: "string",
          pattern: "^/",
          description:
            "Absolute local filesystem path to the target binary artifact. Relative paths are rejected for determinism and safety across all adapters.",
        },
        detail: {
          type: "string",
          enum: ["summary", "complete"],
          default: "summary",
        },
      },
    };
    const snapshotBefore = JSON.stringify(original);
    const compacted = compactJsonSchema(original);
    assert.equal(
      JSON.stringify(original),
      snapshotBefore,
      "must not mutate original schema",
    );
    assert.equal("$schema" in compacted, false);
    assert.deepEqual(compacted.required, ["path", "detail"]);
    assert.equal(compacted.additionalProperties, false);
    assert.deepEqual(compacted.properties.detail.enum, ["summary", "complete"]);
    assert.equal(compacted.properties.path.pattern, "^/");
    assert.ok(compacted.properties.path.description.length <= 96);
  });

  it("narrows direct tools by bound target format (APK vs ELF vs Mach-O)", () => {
    const apkTools = new Set(
      selectRouteToolNames({
        targetPath: "/tmp/app.apk",
        targetFormat: "Android APK",
      }),
    );
    assert.equal(apkTools.has("inspect_android_package"), true);
    assert.equal(apkTools.has("search_android_classes"), true);
    assert.equal(
      apkTools.has("analyze_function"),
      true,
      "JNI bridge essential remains available",
    );
    assert.equal(apkTools.has("inspect_macho"), false);
    assert.equal(apkTools.has("inspect_pcap_capture"), false);

    const elfTools = new Set(
      selectRouteToolNames({
        targetPath: "/tmp/daemon.elf",
        targetFormat: "ELF 64-bit LSB",
      }),
    );
    assert.equal(elfTools.has("procedure_pseudo_code"), true);
    assert.equal(elfTools.has("trace_call_path"), true);
    assert.equal(elfTools.has("search_android_classes"), false);

    const machoTools = new Set(
      selectRouteToolNames({
        targetPath: "/tmp/libfoo.dylib",
        targetFormat: "Mach-O 64-bit",
      }),
    );
    assert.equal(machoTools.has("inspect_macho"), true);
    assert.equal(machoTools.has("trace_dylib_resolution"), true);
  });
});

describe("Evidence-preserving context compaction & incremental JournalTailer", () => {
  it("compacts oversized multi-turn tool outputs while keeping ev_/unk_ IDs and tool_call_id pairing", async () => {
    const ev1 = `ev_${"11".repeat(32)}`;
    const ev2 = `ev_${"22".repeat(32)}`;
    const unk1 = "unk_key_schedule_01";
    const bigBody = "A".repeat(32_000);

    const stub = compactToolOutput(
      `{"evidence_id":"${ev1}","unknown":"${unk1}","body":"${bigBody}"}`,
    );
    assert.match(stub, new RegExp(ev1));
    assert.match(stub, new RegExp(unk1));
    assert.ok(stub.length < 1_600);

    let callIdx = 0;
    const fakeModel = {
      model: "compact-test",
      async stream(messages) {
        callIdx += 1;
        // Verify OpenAI tool_call_id invariant on every single model call
        for (let i = 0; i < messages.length; i += 1) {
          const m = messages[i];
          if (m.role === "assistant" && m.tool_calls?.length) {
            for (let k = 0; k < m.tool_calls.length; k += 1) {
              assert.equal(messages[i + 1 + k]?.role, "tool");
              assert.equal(
                messages[i + 1 + k]?.tool_call_id,
                m.tool_calls[k].id,
              );
            }
          }
        }
        if (callIdx % 3 !== 0) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [
              {
                id: `tc_${callIdx}`,
                type: "function",
                function: { name: "decompile", arguments: "{}" },
              },
            ],
            finishReason: "tool_calls",
            usage: null,
          };
        }
        return {
          content: "Done.",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    };

    let dispatchSeq = 0;
    const fakeBroker = {
      definitions: () => [],
      async dispatch(name) {
        dispatchSeq += 1;
        const ev = dispatchSeq === 1 ? ev1 : ev2;
        return {
          tool: name,
          text: JSON.stringify({ evidence_id: ev, unk: unk1, pseudo: bigBody }),
          isError: false,
          durationMs: 3,
          evidenceIds: [ev],
        };
      },
    };

    const agent = new Agent(fakeModel, fakeBroker, {
      systemPrompt: "sys",
      maxSteps: 8,
    });
    await agent.run("turn 1");
    await agent.run("turn 2");
    await agent.run("turn 3");

    const stats = agent.compact({ force: true, protectRecentTools: 1 });
    assert.ok(
      stats.afterChars < 45_000,
      `expected compacted chars < 45k, got ${stats.afterChars}`,
    );
    const joinedHistory = agent.history.map((m) => m.content ?? "").join("\n");
    assert.match(joinedHistory, new RegExp(ev1));
    assert.match(joinedHistory, new RegExp(ev2));
    assert.match(joinedHistory, new RegExp(unk1));
  });

  it("reads S1 journal incrementally and holds partial concurrent writes until newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-journal-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      const tailer = new JournalTailer(journalPath);

      const evA = `ev_${"aa".repeat(32)}`;
      await writeFile(
        journalPath,
        [
          JSON.stringify({
            seq: 1,
            at: "2026-11-08T19:00:00Z",
            type: "session.start",
          }),
          JSON.stringify({
            seq: 2,
            at: "2026-11-08T19:00:01Z",
            type: "tool.call",
            call_id: "c1",
            tool: "open_binary",
          }),
          JSON.stringify({
            seq: 3,
            at: "2026-11-08T19:00:02Z",
            type: "tool.result",
            call_id: "c1",
            tool: "open_binary",
            ok: true,
            duration_ms: 12,
            evidence_ids: [evA],
          }),
          JSON.stringify({
            seq: 4,
            at: "2026-11-08T19:00:03Z",
            type: "unknown.changed",
            unknown_id: "unk_1",
            status: "open",
            severity: "high",
            domain: "auth",
          }),
        ].join("\n") + "\n",
      );

      const s1 = await tailer.sync();
      assert.equal(s1.phase, "running");
      assert.equal(s1.counts.records, 4);
      assert.equal(s1.counts.evidence, 1);
      assert.equal(s1.counts.open_unknowns, 1);

      // Simulate concurrent writer flushing first half of a JSON line without trailing \n
      const half1 =
        '{"seq":5,"at":"2026-11-08T19:00:04Z","type":"unknown.changed",';
      const half2 =
        '"unknown_id":"unk_1","status":"resolved","severity":"high","domain":"auth"}\n';
      await appendFile(journalPath, half1);

      const sMid = await tailer.sync();
      assert.equal(
        sMid.counts.records,
        4,
        "must not ingest incomplete trailing JSONL line",
      );
      assert.equal(sMid.counts.open_unknowns, 1);

      // Writer finishes the line
      await appendFile(journalPath, half2);
      const s2 = await tailer.sync();
      assert.equal(s2.counts.records, 5);
      assert.equal(
        s2.counts.open_unknowns,
        0,
        "resolved unknown decrements open_unknowns",
      );

      // Verify readFileTail skips partial leading line when seeking into middle
      const tail = await readFileTail(journalPath, 200);
      assert.ok(tail.includes('"seq":5'));
      assert.equal(tail.startsWith("{"), true);
      // And never returns empty string even if maxBytes < trailing line length
      const tinyTail = await readFileTail(journalPath, 60);
      assert.ok(tinyTail.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Backend resilience, caching, and catalog ranking", () => {
  const baseConfig = (port, extra = {}) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "m",
    apiKey: "k",
    apiKeyEnv: "K",
    maxTokens: 256,
    temperature: null,
    maxSteps: 3,
    timeoutMs: 5000,
    ...extra,
  });
  const listen = async (handler) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      server,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    };
  };
  const sse = (res, chunks) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };

  it("retries 429 with Retry-After, never retries quota errors, and drops rejected stream_options", async () => {
    let hits = 0;
    const bodies = [];
    const s = await listen(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      bodies.push(JSON.parse(raw));
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, {
          "retry-after-ms": "10",
          "content-type": "application/json",
        });
        res.end('{"error":"slow down"}');
        return;
      }
      if ("stream_options" in bodies.at(-1)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"Unknown field stream_options"}}');
        return;
      }
      sse(res, [
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    });
    try {
      const client = new ModelClient(baseConfig(s.port));
      const notices = [];
      let text = "";
      const out = await client.stream(
        [{ role: "user", content: "hi" }],
        [],
        undefined,
        (d) => (text += d),
        undefined,
        (n) => notices.push(n),
      );
      assert.equal(text, "ok");
      assert.equal(out.finishReason, "stop");
      assert.equal(notices.length, 1);
      assert.equal(notices[0].reason, "HTTP 429");
      assert.equal("stream_options" in bodies.at(-1), false);
    } finally {
      await s.close();
    }

    let quotaHits = 0;
    const q = await listen((req, res) => {
      quotaHits += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      );
    });
    try {
      const client = new ModelClient(baseConfig(q.port));
      await assert.rejects(
        client.stream(
          [{ role: "user", content: "hi" }],
          [],
          undefined,
          () => {},
        ),
        /HTTP 429/,
      );
      assert.equal(quotaHits, 1);
    } finally {
      await q.close();
    }
  });

  it("aborts only on inactivity (stall) and surfaces a clear ModelStallError", async () => {
    const s = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`,
      );
      // never ends, never sends again
    });
    try {
      // This test checks the error from one stalled attempt. Retry/recovery has its own SSE fixtures.
      const client = new ModelClient(baseConfig(s.port, { timeoutMs: 1000, maxRetries: 0 }));
      let streamed = "";
      await assert.rejects(
        client.stream(
          [{ role: "user", content: "hi" }],
          [],
          undefined,
          (text) => { streamed += text; },
        ),
        /stalled/,
      );
      assert.equal(streamed, "a");
    } finally {
      s.server.closeAllConnections();
      await s.close();
    }
  });

  it("echoes reasoning_content only inside the active tool loop and caches Anthropic prefixes", () => {
    const calls = [
      { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
    ];
    const history = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: null,
        tool_calls: calls,
        reasoning_content: "old-thought",
      },
      { role: "tool", tool_call_id: "c1", content: "r" },
      { role: "user", content: "new" },
      {
        role: "assistant",
        content: null,
        tool_calls: calls,
        reasoning_content: "live-thought",
      },
      { role: "tool", tool_call_id: "c1", content: "r2" },
    ];
    const wire = toOpenAiMessages(history, true);
    assert.equal("reasoning_content" in wire[1], false);
    assert.equal(wire[4].reasoning_content, "live-thought");
    assert.equal(
      "reasoning_content" in toOpenAiMessages(history, false)[4],
      false,
    );

    const payload = buildAnthropicPayload(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          tool_calls: calls,
          thinking_blocks: [
            { type: "thinking", thinking: "t", signature: "sig" },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "" },
      ],
      [
        {
          type: "function",
          function: {
            name: "t",
            description: "d",
            parameters: { type: "object" },
          },
        },
      ],
      {
        ...baseConfig(1),
        protocol: "anthropic-messages",
        reasoningEffort: "medium",
      },
    );
    assert.equal(payload.system[0].cache_control.type, "ephemeral");
    assert.equal(payload.tools.at(-1).cache_control.type, "ephemeral");
    const assistantBlocks = payload.messages[1].content;
    assert.equal(assistantBlocks[0].type, "thinking");
    assert.equal(assistantBlocks[0].signature, "sig");
    assert.equal(assistantBlocks.at(-1).type, "tool_use");
    const last = payload.messages.at(-1).content.at(-1);
    assert.equal(last.cache_control.type, "ephemeral");
    assert.equal(last.content, "(empty tool result)");
  });

  it("keeps head, tail, and omitted Evidence IDs when truncating oversized tool results", () => {
    const hidden = `ev_${"ab".repeat(32)}`;
    const text = `HEAD${"x".repeat(1000)}${hidden}${"y".repeat(5000)}TAIL`;
    const out = truncateToolResult(text, 2000);
    assert.ok(out.startsWith("HEAD"));
    assert.ok(out.endsWith("TAIL"));
    assert.ok(out.includes(hidden));
    assert.ok(out.length < text.length);
    assert.equal(truncateToolResult("short", 2000), "short");
  });

  it("ranks multi-word catalog queries by name tokens and summaries", () => {
    const tool = (name, summary) => ({
      name,
      description: summary,
      summaryLine: summary,
      searchKey: `${name}\n${summary}`.toLowerCase(),
      nameTokens: name.split("_"),
      inputSchema: {},
    });
    const catalog = [
      tool("inspect_pe_imports", "List PE import tables"),
      tool(
        "inspect_android_package",
        "Inspect APK manifest, permissions and components",
      ),
      tool("decode_android_resources", "Decode binary XML resources"),
    ];
    const hits = rankCatalogTools(
      catalog,
      "android manifest permissions",
      5,
    ).map((t) => t.name);
    assert.equal(hits[0], "inspect_android_package");
    assert.equal(hits.includes("inspect_pe_imports"), false);
  });

  it("picks the Anthropic reasoning dialect per model and sends adaptive effort on current models", () => {
    assert.equal(anthropicThinkingStyle("claude-sonnet-4-5"), "budget");
    assert.equal(anthropicThinkingStyle("claude-opus-4-6"), "budget");
    assert.equal(anthropicThinkingStyle("claude-opus-4-7"), "adaptive");
    assert.equal(anthropicThinkingStyle("claude-opus-5-5"), "adaptive");
    assert.equal(anthropicThinkingStyle("claude-sonnet-5.5"), "adaptive");
    const cfg = (model, effort) => ({
      ...baseConfig(1),
      model,
      protocol: "anthropic-messages",
      reasoningEffort: effort,
      maxTokens: 4096,
      temperature: 0.3,
    });
    const msgs = [{ role: "user", content: "q" }];

    const adaptive = buildAnthropicPayload(
      msgs,
      [],
      cfg("claude-opus-5-5", "xhigh"),
    );
    assert.deepEqual(adaptive.thinking, { type: "adaptive" });
    assert.deepEqual(adaptive.output_config, { effort: "xhigh" });
    assert.equal("budget_tokens" in adaptive.thinking, false);
    assert.equal(adaptive.max_tokens, 49152);
    assert.equal("temperature" in adaptive, false);

    assert.equal(
      buildAnthropicPayload(msgs, [], cfg("claude-opus-5-5", "minimal"))
        .output_config.effort,
      "low",
    );
    assert.deepEqual(
      buildAnthropicPayload(msgs, [], cfg("claude-opus-5-5", "off")).thinking,
      { type: "disabled" },
    );
    const auto = buildAnthropicPayload(
      msgs,
      [],
      cfg("claude-opus-5-5", "auto"),
    );
    assert.equal("thinking" in auto, false);
    assert.equal("output_config" in auto, false);
    assert.equal(auto.temperature, 0.3);

    // Opus 4 caps output at 32k; the thinking budget must stay below max_tokens.
    const legacy = buildAnthropicPayload(
      msgs,
      [],
      cfg("claude-opus-4-1", "xhigh"),
    );
    assert.equal(legacy.max_tokens, 32000);
    assert.ok(legacy.thinking.budget_tokens < legacy.max_tokens);
  });

  it("flips the Anthropic dialect once on a 400, and steps down the OpenAI effort ladder before dropping reasoning", async () => {
    const seen = [];
    const ant = await listen(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seen.push(body);
      if (body.thinking?.type === "enabled") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          '{"error":{"message":"thinking.type.enabled is not supported; use adaptive thinking with output_config.effort"}}',
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
      );
      res.end();
    });
    try {
      // "claude-fable" is unparsable, so the guess is `budget`; the 400 must flip it to `adaptive`.
      const client = new ModelClient({
        ...baseConfig(ant.port),
        protocol: "anthropic-messages",
        model: "claude-fable",
        reasoningEffort: "high",
      });
      let text = "";
      await client.stream(
        [{ role: "user", content: "q" }],
        [],
        undefined,
        (d) => (text += d),
      );
      assert.equal(text, "hi");
      assert.equal(seen[0].thinking.type, "enabled");
      assert.equal(seen[1].thinking.type, "adaptive");
      assert.equal(seen[1].output_config.effort, "high");
    } finally {
      await ant.close();
    }

    const efforts = [];
    const oai = await listen(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      efforts.push(body.reasoning_effort ?? null);
      if (body.reasoning_effort === "xhigh") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          '{"error":{"message":"Invalid value for reasoning_effort: xhigh"}}',
        );
        return;
      }
      sse(res, [
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    });
    try {
      const client = new ModelClient(
        baseConfig(oai.port, { reasoningEffort: "xhigh" }),
      );
      await client.stream(
        [{ role: "user", content: "q" }],
        [],
        undefined,
        () => {},
      );
      assert.deepEqual(efforts, ["xhigh", "high"]);
      await client.stream(
        [{ role: "user", content: "q" }],
        [],
        undefined,
        () => {},
      );
      assert.equal(
        efforts.at(-1),
        "high",
        "accepted ladder step is remembered",
      );
    } finally {
      await oai.close();
    }
  });

  it("serves REA skill guides on demand with an index and clipped bodies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-skill-"));
    try {
      await mkdir(join(dir, "references"), { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "## Overview\nIntro\n## Routing\nRoutes\n## Evidence\nIds\n## Native\nELF\n## Android\nAPK\n",
      );
      await writeFile(
        join(dir, "references", "runtime-observation.md"),
        "# Runtime observation\n\n" + "Observe dynamic calls and runtime traces safely. ".repeat(1_000),
      );
      const env = { OMR_REA_SKILL_DIR: dir };
      const topics = listGuideTopics(env);
      assert.ok(
        topics.length > 5,
        "expected skill sections and reference guides",
      );
      assert.ok(topics.some((t) => t.id.startsWith("ref:")));
      const index = readGuide("", env);
      assert.equal(index.ok, true);
      assert.match(index.text, /ref:/);
      const ref = readGuide("ref:runtime-observation", env);
      assert.equal(ref.ok, true);
      assert.ok(ref.text.length > 200 && ref.text.length <= 24_500);
      assert.equal(readGuide("no-such-topic-xyz", env).ok, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("omp-style context compaction and the 1M context meter", () => {
  const settings = (over = {}) => ({
    strategy: "context-full",
    thresholdPercent: null,
    keepRecentTokens: 100,
    contextWindow: 2000,
    ...over,
  });

  it("resolves model-driven conservative defaults, explicit windows, and reserve-based triggers", () => {
    assert.equal(parseCompactionStrategy("full"), "context-full");
    assert.equal(parseCompactionStrategy("SUMMARY"), "context-full");
    assert.equal(parseCompactionStrategy("none"), "off");
    assert.equal(parseCompactionStrategy("bogus"), null);

    const automatic = resolveCompactionSettings({}, null);
    assert.equal(automatic.contextWindow, 32_768);
    assert.equal(automatic.windowSource, "model");
    const defaults = resolveCompactionSettings({OMR_CONTEXT_WINDOW: "1m"}, null);
    assert.equal(defaults.contextWindow, 1_000_000);
    assert.equal(defaults.strategy, "context-full");
    assert.equal(resolveThresholdTokens(defaults), 850_000);
    assert.equal(
      resolveCompactionSettings({ OMR_CONTEXT_WINDOW: "500k" }, null)
        .contextWindow,
      500_000,
    );
    assert.equal(
      resolveCompactionSettings({ OMR_CONTEXT_WINDOW: "2m" }, null)
        .contextWindow,
      2_000_000,
    );
    assert.equal(
      resolveThresholdTokens(
        resolveCompactionSettings({ OMR_COMPACT_THRESHOLD: "70", OMR_CONTEXT_WINDOW: "1m" }, null),
      ),
      700_000,
    );
    assert.equal(
      resolveThresholdTokens({ ...defaults, contextWindow: 100_000 }),
      100_000 - 16_384,
    );
    assert.equal(shouldCompact(849_999, defaults), false);
    assert.equal(shouldCompact(850_001, defaults), true);
    assert.equal(
      shouldCompact(900_000, { ...defaults, strategy: "off" }),
      false,
    );
  });

  it("cuts at a boundary that never separates tool calls from their results", () => {
    const call = (id) => ({
      id,
      type: "function",
      function: { name: "t", arguments: "{}" },
    });
    const messages = [
      { role: "system", content: "s" },
      { role: "user", content: "q1" },
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: "x".repeat(40_000) },
      { role: "assistant", content: "done" },
    ];
    const chars = (m) => (m.content ?? "").length + (m.tool_calls ? 50 : 0);
    const cut = findCutPoint(messages, 100, chars);
    assert.ok(cut);
    assert.notEqual(messages[cut.cut].role, "tool");
    assert.equal(
      findCutPoint(
        [
          { role: "system", content: "s" },
          { role: "user", content: "hi" },
        ],
        100_000,
        chars,
      ),
      null,
    );
  });

  it("summarizes mid-turn at the threshold, keeps the active request, tool pairing and the verbatim tail", async () => {
    const calls = [];
    let step = 0;
    const model = {
      model: "fake",
      async summarize(system, user, maxTokens) {
        calls.push({ system, user, maxTokens });
        return (
          "## Goal\nFind the gate\n## Observed\n- gate cites ev_" +
          "ab".repeat(32)
        );
      },
      async stream(messages) {
        step += 1;
        if (step <= 2) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [
              {
                id: `t${step}`,
                type: "function",
                function: { name: "binary_overview", arguments: "{}" },
              },
            ],
            finishReason: "tool_calls",
            usage: null,
            reasoningContent: null,
            thinkingBlocks: [],
          };
        }
        assert.ok(
          messages[1].content.startsWith(SUMMARY_MARKER),
          "summary is the first message after the system prompt",
        );
        assert.match(
          messages[1].content,
          /Current operator request[\s\S]*find the license gate/,
        );
        return {
          content: "final",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          reasoningContent: null,
          thinkingBlocks: [],
        };
      },
    };
    const broker = {
      definitions: () => [],
      async dispatch(name) {
        return {
          tool: name,
          text: "y".repeat(12_000),
          isError: false,
          durationMs: 1,
          evidenceIds: [],
        };
      },
    };
    const agent = new Agent(model, broker, {
      systemPrompt: "sys",
      maxSteps: 5,
      compaction: () =>
        settings({ thresholdPercent: 50, contextWindow: 10_000 }),
    });
    const reports = [];
    const turn = await agent.run("find the license gate", {
      onCompaction: (r) => reports.push(r),
    });
    assert.equal(turn.text, "final");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].strategy, "context-full");
    assert.equal(reports[0].auto, true);
    assert.ok(reports[0].afterTokens < reports[0].beforeTokens);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxTokens, 16_384);
    assert.match(calls[0].user, /find the license gate/);

    // Every tool message still directly follows the assistant message that issued its call.
    const history = agent.history;
    history.forEach((m, i) => {
      if (m.role !== "tool") return;
      const prev = history[i - 1];
      assert.ok(prev?.tool_calls?.some((c) => c.id === m.tool_call_id));
    });
    assert.equal(agent.contextUsage().window, 10_000);
    assert.equal(
      history.at(-3)?.role,
      "assistant",
      "newest tool-call step is kept verbatim",
    );
  });

  it("falls back to shake when the summarizer fails, and never retriggers every step", async () => {
    let summarizeCalls = 0;
    let step = 0;
    const model = {
      model: "fake",
      async summarize() {
        summarizeCalls += 1;
        throw new Error("summarizer offline");
      },
      async stream() {
        step += 1;
        if (step <= 3) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [
              {
                id: `t${step}`,
                type: "function",
                function: { name: "binary_overview", arguments: "{}" },
              },
            ],
            finishReason: "tool_calls",
            usage: null,
            reasoningContent: null,
            thinkingBlocks: [],
          };
        }
        return {
          content: "ok",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          reasoningContent: null,
          thinkingBlocks: [],
        };
      },
    };
    const broker = {
      definitions: () => [],
      async dispatch(name) {
        return {
          tool: name,
          text: `ev_${"cd".repeat(32)} ` + "z".repeat(9_000),
          isError: false,
          durationMs: 1,
          evidenceIds: [],
        };
      },
    };
    const agent = new Agent(model, broker, {
      systemPrompt: "sys",
      maxSteps: 8,
      compaction: () =>
        settings({ thresholdPercent: 30, keepRecentTokens: 50 }),
    });
    const reports = [];
    await agent.run("go", { onCompaction: (r) => reports.push(r) });
    assert.ok(reports.length >= 1);
    assert.equal(reports[0].strategy, "shake");
    assert.match(reports[0].note, /summary failed/);
    assert.ok(summarizeCalls <= reports.length);
    const joined = agent.history.map((m) => m.content ?? "").join("\n");
    assert.ok(
      joined.includes(`ev_${"cd".repeat(32)}`),
      "Evidence IDs survive shake",
    );
  });

  it("shows the context percentage in the status bar and HUD", () => {
    const theme = createTheme({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    ui.setStatus({
      context: { tokens: 420_000, window: 1_000_000, percent: 42 },
    });
    for (const [cols, rows] of [
      [80, 24],
      [140, 36],
    ]) {
      const frame = ui.renderFrame(cols, rows);
      for (const line of frame.lines) assert.ok(visibleWidth(line) <= cols);
      assert.match(frame.lines.map(stripAnsi).join("\n"), /ctx 42%/);
    }
    const wide = ui.renderFrame(140, 36).lines.map(stripAnsi).join("\n");
    assert.match(wide, /420k \/ 1\.0M|420k\/1\.0M/);
  });

  it("supports omp soft, remote, and snapcompact modes with 1-bit PNG bitmap frames and plain-text Evidence ledger", async () => {
    assert.equal(parseCompactionStrategy("soft"), "soft");
    assert.equal(parseCompactionStrategy("remote"), "remote");
    assert.equal(parseCompactionStrategy("snapcompact"), "snapcompact");
    assert.equal(parseCompactionStrategy("snap"), "snapcompact");
    assert.equal(COMPACTION_MODES.length, 6);

    const evId = `ev_${"a1b2c3d4".repeat(8)}`;
    const unkId = "unk_tls_pinning_gate";
    const discarded = [
      { role: "user", content: "Inspect certificate pinning in libnet.so" },
      {
        role: "assistant",
        content: "Running procedure_pseudo_code on verify_cert.",
        tool_calls: [
          {
            id: "tc_1",
            type: "function",
            function: {
              name: "procedure_pseudo_code",
              arguments: '{"address":"0x401000"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tc_1",
        content: `{"evidence_id":"${evId}","unknown_id":"${unkId}","pseudo":"${"int x = 0; ".repeat(6000)}"}`,
      },
    ];

    const archive = buildSnapcompactArchive(discarded, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      focus: "keep pinning offsets",
      previousSummary: null,
    });
    assert.ok(
      archive.images.length >= 1,
      "expected at least 1 rendered PNG bitmap frame",
    );
    const pngBytes = Buffer.from(archive.images[0].data, "base64");
    assert.deepEqual(
      [...pngBytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "frame must be a valid PNG with 8-byte PNG signature",
    );
    assert.match(
      archive.summaryText,
      new RegExp(evId),
      "64-hex Evidence ID must be preserved in plain text ledger",
    );
    assert.match(
      archive.summaryText,
      new RegExp(unkId),
      "Unknown ID must be preserved in plain text ledger",
    );

    // Verify Agent snapcompact mode performs zero LLM calls and attaches bitmap images to the archive message
    let llmSummaryCalled = 0;
    const fakeModel = {
      model: "claude-sonnet-4-6",
      providerId: "anthropic",
      async summarize() {
        llmSummaryCalled += 1;
        return "should not be called";
      },
      async stream() {
        return {
          content: "ok",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    };
    const fakeBroker = {
      definitions: () => [],
      async dispatch(name) {
        return {
          tool: name,
          text: `{"evidence_id":"${evId}","unknown":"${unkId}","dump":"${"0123456789abcdef".repeat(3500)}"}`,
          isError: false,
          durationMs: 1,
          evidenceIds: [evId],
        };
      },
    };
    const agent = new Agent(fakeModel, fakeBroker, {
      systemPrompt: "sys",
      compaction: () =>
        settings({ strategy: "snapcompact", keepRecentTokens: 50 }),
    });
    // Populate history with discarded turns plus a recent tail that exceeds keepRecentTokens (50 tokens)
    agent.history.push(...discarded, {
      role: "user",
      content: `latest question ${"z".repeat(300)}`,
    });
    const report = await agent.compactWith("snapcompact", "pinning focus");
    assert.equal(
      llmSummaryCalled,
      0,
      "snapcompact must not make an LLM summarization call",
    );
    assert.equal(report.strategy, "snapcompact");
    assert.ok((report.frames ?? 0) >= 1);
    const snapMsg = agent.history[1];
    assert.ok(snapMsg.images && snapMsg.images.length >= 1);
    assert.match(snapMsg.content ?? "", new RegExp(evId));

    // Verify Anthropic and OpenAI wire formatters emit multimodal image blocks for snapcompact messages
    const antWire = buildAnthropicPayload(agent.history, [], {
      providerId: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "k",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxTokens: 1024,
      temperature: null,
      maxSteps: 4,
      timeoutMs: 5000,
    });
    const imgBlock = antWire.messages[0].content.find(
      (b) => b.type === "image",
    );
    assert.ok(imgBlock, "expected Anthropic multimodal image block");
    assert.equal(imgBlock.source.media_type, "image/png");

    const oaiWire = toOpenAiMessages(agent.history, false, true);
    assert.equal(Array.isArray(oaiWire[1].content), true);
    assert.equal(oaiWire[1].content[1].type, "image_url");
  });

  it("supports custom remote text compaction with automatic fallback to local soft summary, plus dedicated compactionModel", async () => {
    assert.equal(normalizeCompactionModelSpec("active"), null);
    assert.equal(normalizeCompactionModelSpec("default"), null);
    assert.equal(
      normalizeCompactionModelSpec("openai:gpt-4o-mini"),
      "openai:gpt-4o-mini",
    );

    let remoteEndpointHits = 0;
    const srv = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.url === "/v1/compact-summary") {
        remoteEndpointHits += 1;
        if (remoteEndpointHits === 1) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text:
                        "## Goal\nRemote compacted summary\n## Observed\n- ev_" +
                        "ef".repeat(32),
                    },
                  ],
                },
              ],
            }),
          );
          return;
        }
        // Second call simulates 404 unsupported endpoint to test automatic fallback to local soft summary
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "## Goal\nLocal fallback summary" }, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      let primaryTurnCalls = 0;
      let primarySummarizeCalls = 0;
      const primaryModel = {
        model: "claude-opus-4-6",
        providerId: "anthropic",
        async summarize() {
          primarySummarizeCalls += 1;
          return "primary summary";
        },
        async stream() {
          primaryTurnCalls += 1;
          return {
            content: "primary investigation response",
            reasoning: "",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          };
        },
      };

      const secondaryCompactor = new ModelClient({
        providerId: "openai",
        protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 2048,
        temperature: 0.2,
        reasoningEffort: "off",
        maxSteps: 4,
        timeoutMs: 5000,
      });

      const fakeBroker = {
        definitions: () => [],
        async dispatch() {
          return {
            tool: "t",
            text: "ok",
            isError: false,
            durationMs: 1,
            evidenceIds: [],
          };
        },
      };
      const agent = new Agent(primaryModel, fakeBroker, {
        systemPrompt: "sys",
        compaction: () =>
          settings({ strategy: "remote", contextWindow: 20_000, keepRecentTokens: 40, remoteEndpoint: `http://127.0.0.1:${port}/v1/compact-summary` }),
        compactionModel: () => secondaryCompactor,
      });

      const seedHistory = () => {
        agent.clear();
        agent.history.push(
          { role: "user", content: "find crypto constants" },
          { role: "assistant", content: "x".repeat(12_000) },
          { role: "user", content: "next step" },
        );
      };

      // 1) Custom text compaction succeeds via secondaryCompactor (not native Responses state)
      seedHistory();
      const rep1 = await agent.compactWith("remote", "");
      assert.equal(rep1.strategy, "remote");
      assert.equal(rep1.compactionModel, "openai:gpt-4o-mini");
      assert.equal(
        primarySummarizeCalls,
        0,
        "primary model must not be called for compaction when compactionModel is set",
      );
      assert.match(agent.history[1].content ?? "", /Remote compacted summary/);

      // 2) Remote compaction returns 404 -> falls back automatically to local `soft` summary on secondaryCompactor
      seedHistory();
      const rep2 = await agent.compactWith("remote", "");
      assert.equal(rep2.strategy, "soft");
      assert.equal(rep2.compactionModel, "openai:gpt-4o-mini");
      assert.match(
        rep2.note ?? "",
        /remote server compaction unavailable; summarized locally/,
      );
      assert.match(agent.history[1].content ?? "", /Local fallback summary/);

      // 3) Subsequent turn continues on the primary active model (`claude-opus-4-6`)
      const turn = await agent.run("continue analysis");
      assert.equal(turn.text, "primary investigation response");
      assert.equal(primaryTurnCalls, 1);
      assert.equal(agent.modelId, "claude-opus-4-6");
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe("Cyber/RE slash commands, format routes, concurrent tools, /jb & /save", () => {
  it("registers all specialized RE & Cyber slash commands and aliases", () => {
    for (const [cmd, expected] of [
      ["frida", "frida"],
      ["hook", "frida"],
      ["crypto", "crypto"],
      ["cipher", "crypto"],
      ["decrypt", "crypto"],
      ["protocol", "protocol"],
      ["proto", "protocol"],
      ["unpack", "unpack"],
      ["extract", "unpack"],
      ["surface", "surface"],
      ["mitigations", "surface"],
      ["script", "script"],
      ["bot", "script"],
      ["adb", "adb"],
      ["save", "save"],
      ["jb", "jb"],
      ["directive", "jb"],
      ["resume", "resume"],
    ]) {
      assert.equal(
        findCommand(cmd)?.name,
        expected,
        `expected /${cmd} to resolve to /${expected}`,
      );
    }

    assert.match(fridaPrompt("/tmp/app.apk", "bypass ssl pinning"), /Frida/);
    assert.match(
      cryptoPrompt("/tmp/bin", "aes key"),
      /standalone Python decryptor/i,
    );
    assert.match(
      protocolPrompt("/tmp/capture.pcap", "login frame"),
      /state machine/i,
    );
    assert.match(unpackPrompt("/tmp/packed.exe", "pyinstaller"), /PyInstaller/);
    assert.match(surfacePrompt("/tmp/daemon.elf", ""), /Attack Surface Matrix/);
    assert.match(
      scriptPrompt("/tmp/daemon.elf", "yara", "detect loader"),
      /yara/i,
    );
  });

  it("classifies IL2CPP, DeviceTree, ESP32, Python .pyc, Kernel .ko, and selects expanded format routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-routes-"));
    try {
      const il2cppPath = join(dir, "global-metadata.dat");
      const dtbPath = join(dir, "board.dtb");
      const espPath = join(dir, "esp32.bin");
      await writeFile(
        il2cppPath,
        Buffer.from([0xaf, 0x1b, 0xb1, 0xfa, 0x18, 0, 0, 0]),
      );
      await writeFile(
        dtbPath,
        Buffer.from([0xd0, 0x0d, 0xfe, 0xed, 0, 0, 0x10, 0]),
      );
      await writeFile(
        espPath,
        Buffer.from([0xe9, 0x03, 0x02, 0x20, 0x00, 0x10, 0x00, 0x40]),
      );

      assert.equal(
        (await inspectTargetMagic(il2cppPath))?.label,
        "Unity IL2CPP Metadata",
      );
      assert.equal(
        (await inspectTargetMagic(dtbPath))?.label,
        "DeviceTree DTB",
      );
      assert.equal(
        (await inspectTargetMagic(espPath))?.label,
        "ESP32 Firmware",
      );

      const il2cppTools = new Set(
        selectRouteToolNames({
          targetPath: il2cppPath,
          targetFormat: "Unity IL2CPP Metadata",
        }),
      );
      assert.equal(il2cppTools.has("inspect_il2cpp_metadata"), true);

      const fwTools = new Set(
        selectRouteToolNames({
          targetPath: espPath,
          targetFormat: "ESP32 Firmware",
        }),
      );
      assert.equal(fwTools.has("inspect_firmware_regions"), true);
      assert.equal(fwTools.has("extract_firmware"), true);

      const wasmTools = new Set(
        selectRouteToolNames({
          targetPath: "/tmp/mod.wasm",
          targetFormat: "WebAssembly",
        }),
      );
      assert.equal(wasmTools.has("inspect_wasm_artifact"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs only REA-declared read-only calls concurrently (readOnlyHint allowlist), keeps everything else sequential, and preserves tool_call_id order", async () => {
    const hints = {
      procedure_pseudo_code: true,
      search_strings: true,
      observe_native_calls: false, // executes the target: REA says not read-only
      open_binary: false,
      legacy_tool_without_hint: null,
    };
    const hint = (toolName) => hints[toolName];
    assert.equal(
      isReadOnlyToolCall(
        "procedure_pseudo_code",
        { address: "0x401000" },
        hint,
      ),
      true,
    );
    assert.equal(
      isReadOnlyToolCall("open_binary", { path: "/tmp/a" }, hint),
      false,
    );
    assert.equal(
      isReadOnlyToolCall("observe_native_calls", {}, hint),
      false,
      "target-executing tools must not be parallelized",
    );
    assert.equal(
      isReadOnlyToolCall("legacy_tool_without_hint", {}, hint),
      false,
      "missing hint is not read-only",
    );
    assert.equal(
      isReadOnlyToolCall("not_in_catalog", {}, hint),
      false,
      "unknown tool is not read-only",
    );
    assert.equal(
      isReadOnlyToolCall(
        "rea_call",
        { name: "search_strings", arguments: {} },
        hint,
      ),
      true,
    );
    assert.equal(
      isReadOnlyToolCall(
        "rea_call",
        { name: "observe_native_calls", arguments: {} },
        hint,
      ),
      false,
    );
    assert.equal(isReadOnlyToolCall("rea_call", {}, hint), false);
    assert.equal(isReadOnlyToolCall("rea_tools", {}, hint), true);

    const runWave = async (calls, readOnly) => {
      let activeCount = 0;
      let maxConcurrentSeen = 0;
      let step = 0;
      const fakeModel = {
        model: "parallel-test",
        async stream(messages) {
          step += 1;
          if (step === 1) {
            return {
              content: "",
              reasoning: "",
              toolCalls: calls.map((c, i) => ({
                id: `call_${i + 1}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
              finishReason: "tool_calls",
              usage: null,
            };
          }
          // Tool messages must be appended in exact call order regardless of completion order.
          const toolMsgs = messages.filter((m) => m.role === "tool");
          assert.deepEqual(
            toolMsgs.map((m) => m.tool_call_id),
            calls.map((_, i) => `call_${i + 1}`),
          );
          return {
            content: "done",
            reasoning: "",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          };
        },
      };
      const fakeBroker = {
        definitions: () => [],
        beginTurn: () => {},
        ...(readOnly
          ? { isReadOnly: (name, args) => isReadOnlyToolCall(name, args, hint) }
          : {}),
        async dispatch(name, args) {
          activeCount += 1;
          maxConcurrentSeen = Math.max(maxConcurrentSeen, activeCount);
          // The first call finishes last to prove ordering is by call index, not completion.
          const delay = args.address === "0x1" ? 45 : 10;
          await new Promise((r) => setTimeout(r, delay));
          activeCount -= 1;
          return {
            tool: name,
            text: JSON.stringify({ ok: true, args }),
            isError: false,
            durationMs: delay,
            evidenceIds: [],
          };
        },
      };
      const agent = new Agent(fakeModel, fakeBroker, {
        systemPrompt: "sys",
        maxSteps: 4,
      });
      const res = await agent.run("go");
      assert.equal(res.text, "done");
      return maxConcurrentSeen;
    };

    const readOnlyCalls = [
      { name: "procedure_pseudo_code", args: { address: "0x1" } },
      { name: "procedure_pseudo_code", args: { address: "0x2" } },
      { name: "search_strings", args: { pattern: "key" } },
    ];
    assert.equal(
      await runWave(readOnlyCalls, true),
      3,
      "hinted read-only calls run as one concurrent wave",
    );

    const mixedCalls = [
      { name: "procedure_pseudo_code", args: { address: "0x1" } },
      { name: "observe_native_calls", args: { address: "0x2" } },
      { name: "search_strings", args: { pattern: "key" } },
    ];
    assert.equal(
      await runWave(mixedCalls, true),
      1,
      "a target-executing call splits the waves and is never concurrent",
    );
    assert.equal(
      await runWave(readOnlyCalls, false),
      1,
      "a broker without isReadOnly never gets concurrency",
    );
  });

  it("manages /jb operator directives in AGENTS.md with .bak backups and injects them into systemPrompt, plus extracts/saves scripts with Evidence headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-jb-save-"));
    try {
      const cwd = join(dir, "workspace");
      const sessionDir = join(dir, "session");
      const scriptsDir = join(sessionDir, "scripts");
      await writeFile(join(dir, "dummy"), "");
      const { mkdir: mkdirFs, readFile: readFileFs } =
        await import("node:fs/promises");
      await mkdirFs(cwd, { recursive: true });
      await mkdirFs(scriptsDir, { recursive: true });

      await writeFile(
        join(cwd, "AGENTS.md"),
        "# Existing Repo Guidelines\n\nKeep clean.\n",
      );

      const w1 = await writeOperatorDirective(
        cwd,
        sessionDir,
        "Always output standalone Python 3 scripts and full Frida hooks without placeholders.",
      );
      assert.equal(w1.backupPath, `${join(cwd, "AGENTS.md")}.bak`);
      const agentsContent = await readFileFs(join(cwd, "AGENTS.md"), "utf8");
      assert.match(agentsContent, /# Existing Repo Guidelines/);
      assert.match(agentsContent, /BEGIN:omr-operator-directive/);
      assert.match(agentsContent, /Always output standalone Python 3 scripts/);

      const readBack = await readOperatorDirective(cwd, sessionDir);
      assert.equal(
        readBack,
        "Always output standalone Python 3 scripts and full Frida hooks without placeholders.",
      );

      const sys = systemPrompt({
        target: "/tmp/lib.so",
        targetOpened: true,
        targetFormat: "ELF 64-bit",
        boundProvider: "rizin",
        evidenceCount: 1,
        unknownCount: 0,
        sessionDir,
        journalPath: join(sessionDir, "journal.jsonl"),
        directTools: ["binary_overview"],
        operatorDirective: readBack,
      });
      assert.match(sys, /# Active Operator Directives \(\/jb\)/);
      assert.match(sys, /Always output standalone Python 3 scripts/);

      // A fresh process has no session file: the persisted AGENTS.md block alone must yield the bare directive.
      const freshSessionDir = join(dir, "fresh-session");
      await mkdirFs(freshSessionDir, { recursive: true });
      assert.equal(
        await readOperatorDirective(cwd, freshSessionDir),
        "Always output standalone Python 3 scripts and full Frida hooks without placeholders.",
        "the block's heading must not leak into the directive",
      );

      // Clearing directive preserves existing AGENTS.md content
      await writeOperatorDirective(cwd, sessionDir, null);
      assert.equal(await readOperatorDirective(cwd, sessionDir), null);
      const clearedAgents = await readFileFs(join(cwd, "AGENTS.md"), "utf8");
      assert.match(clearedAgents, /# Existing Repo Guidelines/);
      assert.doesNotMatch(clearedAgents, /BEGIN:omr-operator-directive/);

      // Test extractCodeBlocks and saveCodeBlockToDisk with Evidence provenance headers
      const evId = `ev_${"deadbeef".repeat(8)}`;
      const md = [
        `Here is the Frida hook citing ${evId}:`,
        "```javascript",
        "Interceptor.attach(Module.findExportByName(null, 'strcmp'), {});",
        "```",
      ].join("\n");
      const blocks = extractCodeBlocks(md);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].suggestedExt, "js");

      const fakeSession = {
        id: "2026-11-08-test",
        dir: sessionDir,
        target: "/tmp/lib.so",
        journalPath: join(sessionDir, "journal.jsonl"),
        reportPath: join(sessionDir, "report.md"),
        evidencePath: join(sessionDir, "evidence.json"),
        omrMetaPath: join(sessionDir, "omr.json"),
        scriptsDir,
        historyPath: join(sessionDir, "history.json"),
      };
      const saved = await saveCodeBlockToDisk(fakeSession, md, {
        explicitPath: "hook_strcmp",
        cwd,
      });
      assert.ok(saved.path.endsWith("hook_strcmp.js"));
      const scriptText = await readFileFs(saved.path, "utf8");
      assert.match(scriptText, new RegExp(`// Retained Evidence: ${evId}`));
      assert.match(scriptText, /Interceptor\.attach/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Session persistence, resume repair & sticky tool restore", () => {
  const evA = `ev_${"ab".repeat(32)}`;
  const evB = `ev_${"cd".repeat(32)}`;
  const call = (id, name = "procedure_pseudo_code", args = "{}") => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });

  it("stores snapcompact frames once in a content-addressed asset store and rehydrates them on load", async () => {
    const home = await mkdtemp(join(tmpdir(), "omr-home-"));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const {
        mkdir: mkdirFs,
        readdir: readdirFs,
        readFile: readFileFs,
      } = await import("node:fs/promises");
      const id = "2026-11-08T10-00-00-000Z-sample";
      const dir = join(home, ".rea", "sessions", id);
      await mkdirFs(dir, { recursive: true });
      const info = {
        id,
        dir,
        target: "/tmp/sample.elf",
        journalPath: join(dir, "journal.jsonl"),
        reportPath: join(dir, "report.md"),
        evidencePath: join(dir, "evidence.json"),
        omrMetaPath: join(dir, "omr.json"),
        scriptsDir: join(dir, "scripts"),
        historyPath: join(dir, "history.json"),
      };
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(4096, 7),
      ]);
      const messages = [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: `archive ${evA}`,
          images: [{ mimeType: "image/png", data: png.toString("base64") }],
          image_tokens: 900,
        },
        { role: "assistant", content: `ok ${evB}` },
      ];

      await saveSessionHistory(info, messages, "/tmp/sample.elf", "m");
      await saveSessionHistory(info, messages, "/tmp/sample.elf", "m"); // rewrite must not duplicate the frame

      const rawHistory = await readFileFs(info.historyPath, "utf8");
      assert.equal(
        rawHistory.includes(png.toString("base64")),
        false,
        "bitmap bytes must not be inlined in history.json",
      );
      const assets = await readdirFs(join(dir, "history-assets"));
      assert.equal(assets.length, 1);
      assert.match(assets[0], /^[0-9a-f]{64}\.png$/);

      const loaded = await loadSavedSession(id);
      assert.ok(loaded);
      assert.equal(
        loaded.messages.length,
        2,
        "system message is never persisted",
      );
      assert.equal(loaded.messages[0].images[0].data, png.toString("base64"));
      assert.equal(loaded.messages[0].image_tokens, 900);
      assert.deepEqual(evidenceIdsInMessages(loaded.messages), [evA, evB]);

      // A frame that vanished degrades to the text ledger instead of failing the resume.
      await rm(join(dir, "history-assets", assets[0]));
      const degraded = await loadSavedSession(id);
      assert.ok(degraded);
      assert.equal(degraded.messages[0].images, undefined);
      assert.match(degraded.messages[0].content, new RegExp(evA));
      assert.match(
        degraded.messages[0].content,
        /bitmap frame\(s\) were unavailable/,
      );

      // A hostile asset name from disk must never reach the filesystem.
      const tampered = JSON.parse(rawHistory);
      tampered.messages[0].images = [
        { mimeType: "image/png", asset: "../../../../etc/passwd" },
      ];
      await writeFile(info.historyPath, JSON.stringify(tampered));
      const hostile = await loadSavedSession(id);
      assert.ok(hostile);
      assert.equal(hostile.messages[0].images, undefined);

      assert.equal((await listRecentSessions(5)).length, 1);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("restoreHistory re-establishes tool_call pairing and drops malformed saved messages", () => {
    const fakeModel = {
      model: "m",
      async stream() {
        return {
          content: "",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    };
    const agent = new Agent(
      fakeModel,
      {
        definitions: () => [],
        async dispatch() {
          throw new Error("unused");
        },
      },
      { systemPrompt: "SYS" },
    );
    agent.restoreHistory([
      { role: "tool", tool_call_id: "orphan_head", content: "no owner" },
      { role: "user", content: "q1" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
      { role: "tool", tool_call_id: "stranger", content: "not mine" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: null, tool_calls: [call("c"), call("d")] }, // interrupted: only one result saved
      { role: "tool", tool_call_id: "c", content: "rc" },
    ]);
    const roles = agent.history.map((m) => m.role);
    assert.deepEqual(roles, [
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "user",
    ]);
    assert.equal(agent.history[0].content, "SYS");
    assert.deepEqual(
      agent.history.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      ["a", "b"],
    );
    agent.history.forEach((m, i) => {
      if (m.role === "tool")
        assert.ok(
          agent.history
            .slice(0, i)
            .some((p) => p.tool_calls?.some((c) => c.id === m.tool_call_id)),
        );
    });
  });

  it("restoreSticky re-exposes REA tools the restored conversation used, resolving rea_call targets", () => {
    const toolDef = (name) => ({
      name,
      description: name,
      summaryLine: name,
      searchKey: name,
      nameTokens: [name],
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    });
    const catalog = new Map(
      [
        "xrefs",
        "inspect_il2cpp_metadata",
        "search_strings",
        "binary_session",
      ].map((n) => [n, toolDef(n)]),
    );
    const broker = new ReaBroker(
      { find: (n) => catalog.get(n), tools: () => [...catalog.values()] },
      {},
    );
    const exposed = () =>
      broker
        .definitions({ targetPath: "/tmp/a.elf", targetFormat: "ELF 64-bit" })
        .map((d) => d.function.name);
    assert.equal(exposed().includes("inspect_il2cpp_metadata"), false);

    broker.restoreSticky([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call(
            "1",
            "rea_call",
            '{"name":"inspect_il2cpp_metadata","arguments":{}}',
          ),
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("2", "rea_call", "{not json")],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("3", "no_such_tool"), call("4", "rea_tools")],
      },
    ]);
    assert.equal(exposed().includes("inspect_il2cpp_metadata"), true);
    assert.equal(exposed().includes("no_such_tool"), false);
    assert.equal(
      broker.isReadOnly("rea_call", { name: "inspect_il2cpp_metadata" }),
      true,
    );
    assert.equal(
      broker.isReadOnly("rea_call", { name: "no_such_tool" }),
      false,
    );
  });
});

describe("Operator authority: no restricting prompts reach the model", () => {
  it("prefixes every served REA playbook (rea_guide and rea_prompt) with the operator precedence note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-skill-"));
    try {
      await mkdir(join(dir, "references"), { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "## Overview\nIntro\n");
      await writeFile(
        join(dir, "references", "runtime-observation.md"),
        "# Runtime observation\n\nObserve runtime calls.\n",
      );
      const env = { OMR_REA_SKILL_DIR: dir };
      const guide = readGuide("ref:runtime-observation", env);
      assert.equal(guide.ok, true);
      assert.ok(guide.text.startsWith(OPERATOR_PRECEDENCE_NOTE));
      assert.match(
        guide.text,
        /Runtime observation|runtime/i,
        "REA's own text is preserved after the note",
      );
      assert.equal(
        readGuide("", env).text.startsWith(OPERATOR_PRECEDENCE_NOTE),
        false,
        "the plain topic index is not a playbook",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const rea = {
      find: () => undefined,
      tools: () => [],
      prompts: async () => [
        { name: "trace_crash", description: "d", arguments: [] },
      ],
      getPrompt: async () => "1. Obtain approval before launching the target.",
    };
    const broker = new ReaBroker(rea, {});
    const out = await broker.dispatch("rea_prompt", { name: "trace_crash" });
    assert.equal(out.isError, false);
    assert.ok(out.text.startsWith(OPERATOR_PRECEDENCE_NOTE));
    assert.match(
      out.text,
      /Obtain approval before launching the target\./,
      "REA's text is carried verbatim",
    );
  });

  it("keeps omr-authored system and workflow prompts free of refusal, gating, and disclaimer language", () => {
    const sys = systemPrompt({
      target: "/tmp/x.elf",
      targetOpened: true,
      targetFormat: "ELF 64-bit",
      boundProvider: "rizin",
      evidenceCount: 0,
      unknownCount: 0,
      sessionDir: "/tmp/s",
      journalPath: "/tmp/s/journal.jsonl",
      directTools: ["binary_session"],
    });
    const texts = [
      sys,
      investigatePrompt("/tmp/x", "goal"),
      triagePrompt("/tmp/x", ""),
      explainPrompt("/tmp/x", "main"),
      tracePrompt("/tmp/x", "feature"),
      crashPrompt("/tmp/x", "SIGSEGV"),
      auditPrompt(""),
      comparePrompt("/tmp/a", "/tmp/b"),
      fridaPrompt("/tmp/x", "hook"),
      cryptoPrompt("/tmp/x", ""),
      protocolPrompt("/tmp/x", ""),
      unpackPrompt("/tmp/x", ""),
      surfacePrompt("/tmp/x", ""),
      scriptPrompt("/tmp/x", "python", "goal"),
      adbPrompt("/tmp/x", "devices"),
      browserPrompt("/tmp/x", "open target"),
      iocPrompt("/tmp/x", ""),
      diffCvePrompt("/tmp/a", "/tmp/b", "cve"),
      sandboxPrompt("/tmp/x", "behavior"),
      deobfuscatePrompt("/tmp/x", "strings"),
      sbomPrompt("/tmp/x", "deps"),
      capaPrompt("/tmp/x", "mitre"),
      firmwarePrompt("/tmp/x", "squashfs"),
      masvsPrompt("/tmp/x", "manifest"),
      forgePrompt("/tmp/x", "extractor"),
    ];
    // Each pattern is a way a prompt can talk the agent out of work the operator asked for.
    const gating = [
      /\b(i|you) (can(?:no|')t|must not|should not|shouldn't|will not|won't) (help|assist|provide|do|write|generate)/i,
      /\brefus(e|al|ing)\b/i,
      /\b(decline|disclaimer|ethical|ethics|legality|illegal|unlawful|malicious intent|misuse|responsible disclosure)\b/i,
      /\b(only|first) (if|after) (the )?(user|operator) (confirms|approves|authori[sz]es|consents)\b/i,
      /\b(ask|request|obtain|get) (the )?(user|operator)('s)? (for )?(permission|approval|consent|confirmation)\b/i,
      /\bauthori[sz]ed (testing|use|targets?) only\b/i,
    ];
    for (const text of texts) {
      for (const pattern of gating) {
        // The one sanctioned mention is the operator-authority clause that forbids those behaviors.
        const without = text
          .replace(/Act on the operator's scope[^\n]*/g, "")
          .replace(/wherever one says to ask the user[^\n]*?run it\./g, "");
        assert.doesNotMatch(
          without,
          pattern,
          `restricting language ${pattern} found in an omr prompt`,
        );
      }
    }
    assert.match(sys, /operator who launched omr owns/);
    assert.match(sys, /do not ask for confirmation/);
  });
});

describe("Project AGENTS.md instructions and Ctrl+Backspace word delete", () => {
  it("reads <cwd>/AGENTS.md live, excludes omr's own /jb block, bounds it, and injects it before the live context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-agents-"));
    try {
      assert.equal(
        readProjectInstructions(dir),
        null,
        "no AGENTS.md means no section",
      );

      const agentsPath = join(dir, "AGENTS.md");
      await writeFile(
        agentsPath,
        "# House rules\r\n\r\nAlways name hooks after the symbol.\n\n<!-- BEGIN:omr-operator-directive -->\n## OMR Operator Directives\n\nJB ONLY TEXT\n<!-- END:omr-operator-directive -->\n",
      );
      const first = readProjectInstructions(dir);
      assert.ok(first);
      assert.equal(first.path, agentsPath);
      assert.match(first.text, /Always name hooks after the symbol\./);
      assert.doesNotMatch(
        first.text,
        /JB ONLY TEXT/,
        "the /jb block is delivered separately, not duplicated",
      );
      assert.equal(first.text.includes("\r"), false);
      assert.equal(first.truncated, false);

      // An edit is picked up on the next read (size changes), with no restart.
      await writeFile(
        agentsPath,
        "# House rules\n\nAlways name hooks after the symbol and keep them under 40 lines.\n",
      );
      assert.match(readProjectInstructions(dir).text, /under 40 lines/);

      // A file that only holds omr's block has no project instructions.
      await writeFile(
        agentsPath,
        "<!-- BEGIN:omr-operator-directive -->\nonly jb\n<!-- END:omr-operator-directive -->\n",
      );
      assert.equal(readProjectInstructions(dir), null);

      await writeFile(agentsPath, `# Big\n${"x".repeat(PROJECT_INSTRUCTIONS_LIMIT + 500)}`);
      const big = readProjectInstructions(dir);
      assert.equal(big.text.length, PROJECT_INSTRUCTIONS_LIMIT);
      assert.equal(big.truncated, true);
      assert.ok(big.chars > big.text.length);

      const sys = systemPrompt({
        target: "/tmp/a.elf",
        targetOpened: true,
        targetFormat: "ELF 64-bit",
        boundProvider: "rizin",
        evidenceCount: 0,
        unknownCount: 0,
        sessionDir: "/tmp/s",
        journalPath: "/tmp/s/journal.jsonl",
        directTools: ["binary_session"],
        operatorDirective: "quick jb directive",
        projectInstructions: {
          path: agentsPath,
          text: "Name hooks after the symbol.",
          truncated: true,
        },
      });
      const project = sys.indexOf("# Project Instructions (AGENTS.md)");
      const live = sys.indexOf("# Live Session Context");
      const jb = sys.indexOf("# Active Operator Directives (/jb)");
      assert.ok(
        project > 0 && project < live && live < jb,
        "project instructions precede the live context; /jb stays last and wins",
      );
      assert.match(sys, /Name hooks after the symbol\./);
      assert.match(sys, /AGENTS\.md was cut here/);
      assert.match(sys, /already authorized: apply them as written/);

      const without = systemPrompt({
        target: null,
        sessionDir: "/tmp/s",
        journalPath: "/tmp/s/journal.jsonl",
        directTools: [],
        projectInstructions: null,
      });
      assert.equal(without.includes("# Project Instructions"), false);

      // /agents.md <path> reads an arbitrary instruction file the same way.
      const other = join(dir, "team-rules.md");
      await writeFile(other, "Use Python 3 for every decoder.\n");
      assert.equal(
        readInstructionFile(other).text,
        "Use Python 3 for every decoder.",
      );
      assert.equal(readInstructionFile(join(dir, "missing.md")), null);
      assert.equal(
        readInstructionFile(dir),
        null,
        "a directory is not an instruction file",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers /agents.md (alias /agents) as its own command and keeps /jb", () => {
    assert.equal(findCommand("agents.md")?.name, "agents.md");
    assert.equal(findCommand("agents")?.name, "agents.md");
    assert.equal(findCommand("jb")?.name, "jb");
    assert.equal(findCommand("directive")?.name, "jb");
  });

  it("deletes whole words on Ctrl+Backspace for every common terminal encoding, once per key repeat", () => {
    const theme = createTheme({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    const make = (text) => {
      const ui = new TerminalUi({
        i18n: englishUi,
        commands: COMMANDS,
        theme,
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      });
      ui.handleText(text);
      return ui;
    };

    let ui = make("hello brave new world");
    ui.handleText("\b");
    assert.equal(
      ui.composer,
      "hello brave new ",
      "Ctrl+Backspace (BS) removes the last word",
    );
    assert.equal(ui.cursor, ui.composer.length);

    // Holding the key delivers repeats, often batched into one chunk: each one removes another word.
    ui.handleText("\b\b");
    assert.equal(ui.composer, "hello ");
    ui.handleText("\b");
    assert.equal(ui.composer, "");
    ui.handleText("\b");
    assert.equal(ui.composer, "", "deleting past the start is harmless");

    for (const seq of [
      "\x1b[127;5u",
      "\x1b[8;5u",
      "\x1b[27;5;127~",
      "\x1b[27;5;8~",
      "\x1b\x7f",
      "\x17",
    ]) {
      ui = make("alpha beta");
      ui.handleText(seq);
      assert.equal(
        ui.composer,
        "alpha ",
        `sequence ${JSON.stringify(seq)} deletes one word`,
      );
    }

    ui = make("alpha beta");
    ui.handleText("\x7f");
    assert.equal(
      ui.composer,
      "alpha bet",
      "plain Backspace still deletes a single character",
    );

    // Mid-line: only the word before the cursor goes, the text after it stays.
    ui = make("one two three");
    ui.handleText("\x1b[D".repeat(5)); // cursor sits right before "three"
    ui.handleText("\b");
    assert.equal(ui.composer, "one three");
    assert.equal(ui.cursor, 4);

    ui = make("one two three");
    ui.handleText("\x1b[D".repeat(6)); // cursor sits on the space after "two"
    ui.handleText("\b");
    assert.equal(ui.composer, "one  three");
  });
});

describe("Multi-browser hub: Camoufox anti-detect MCP bridge, Chromium/Firefox/Zen, Proxy & Tor", () => {
  it("builds DNS-leak-safe Chromium and Firefox/Zen configurations for direct, HTTP/SOCKS5 proxy, and Tor", () => {
    const torChromium = buildChromiumLaunchArgs({
      profileDir: "/tmp/p",
      cdpPort: 9222,
      headless: true,
      networkMode: "tor",
      proxyUrl: "socks5h://127.0.0.1:9050",
      url: "http://example.onion",
    });
    assert.ok(torChromium.includes("--proxy-server=socks5://127.0.0.1:9050"));
    assert.ok(
      torChromium.some((a) =>
        a.startsWith("--host-resolver-rules=MAP * ~NOTFOUND"),
      ),
      "Tor/SOCKS5 must prevent local DNS leaks",
    );
    assert.equal(torChromium.at(-1), "http://example.onion");

    const torFirefox = buildFirefoxProfilePrefs(
      9229,
      "tor",
      "socks5h://127.0.0.1:9050",
    );
    assert.match(torFirefox, /network\.proxy\.type",\s*1/);
    assert.match(torFirefox, /network\.proxy\.socks",\s*"127\.0\.0\.1"/);
    assert.match(torFirefox, /network\.proxy\.socks_port",\s*9050/);
    assert.match(torFirefox, /network\.proxy\.socks_remote_dns",\s*true/);

    const httpFirefox = buildFirefoxProfilePrefs(
      9229,
      "proxy",
      "http://10.0.0.2:8080",
    );
    assert.match(httpFirefox, /network\.proxy\.http",\s*"10\.0\.0\.2"/);
    assert.match(httpFirefox, /network\.proxy\.http_port",\s*8080/);
  });

  it("bridges all 11 camofox_* tools + omr_browser through ReaBroker and saves screenshots to the session directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-camofox-"));
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
    ]);
    const requests = [];
    const srv = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : null,
      });
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            engine: "camoufox",
            browserRunning: true,
            activeTabs: 1,
            activeSessions: 1,
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/tabs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tabId: "tab-cf-1",
            url: JSON.parse(body).url,
            title: "Cloudflare Protected",
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url?.startsWith("/tabs/tab-cf-1/snapshot")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tabId: "tab-cf-1",
            tree: "[e1] button 'Verify you are human'",
            screenshot: {
              data: pngBytes.toString("base64"),
              mimeType: "image/png",
            },
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url?.startsWith("/tabs/tab-cf-1/screenshot")
      ) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(pngBytes);
        return;
      }
      if (req.method === "POST" && req.url === "/tabs/tab-cf-1/evaluate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: "cf_clearance_ok" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      const mgr = new BrowserManager(dir, {
        CAMOFOX_BASE_URL: `http://127.0.0.1:${port}`,
        CAMOFOX_USER_ID: "test-user",
        CAMOFOX_SESSION_KEY: "sec-1",
        OMR_TOR_PROXY: `socks5h://127.0.0.1:${port}`,
      });
      const rea = { find: () => undefined, tools: () => [], sessionDir: dir };
      const broker = new ReaBroker(rea, { browser: mgr });

      assert.equal(BROWSER_TOOLS.length, 12);
      assert.equal(
        broker.isReadOnly("camofox_snapshot", { tabId: "tab-cf-1" }),
        true,
      );
      assert.equal(broker.isReadOnly("camofox_list_tabs", {}), true);
      assert.equal(
        broker.isReadOnly("camofox_create_tab", { url: "https://example.com" }),
        false,
      );

      // Intent-based sticky promotion for Cloudflare/CAPTCHA/Tor/browser tasks
      broker.beginTurn(
        "Bypass Cloudflare Turnstile CAPTCHA with camofox or tor browser",
      );
      const promotedNames = broker.definitions().map((d) => d.function.name);
      assert.ok(promotedNames.includes("camofox_create_tab"));
      assert.ok(promotedNames.includes("omr_browser"));

      // Catalog search finds camofox tools via rea_tools
      const searchOut = await broker.dispatch("rea_tools", {
        query: "camofox cloudflare",
      });
      assert.equal(searchOut.isError, false);
      assert.match(searchOut.text, /camofox_create_tab/);

      const created = await broker.dispatch("camofox_create_tab", {
        url: "https://target.example",
      });
      assert.equal(created.isError, false);
      assert.match(created.text, /tab-cf-1/);

      const snap = await broker.dispatch("camofox_snapshot", {
        tabId: "tab-cf-1",
      });
      assert.equal(snap.isError, false);
      assert.match(snap.text, /saved_screenshot_path/);
      assert.doesNotMatch(
        snap.text,
        new RegExp(pngBytes.toString("base64")),
        "raw base64 image is externalized to disk",
      );

      const evalOut = await broker.dispatch("camofox_evaluate", {
        tabId: "tab-cf-1",
        expression: "document.cookie",
      });
      assert.equal(evalOut.isError, false);
      assert.match(evalOut.text, /cf_clearance_ok/);

      const statusOut = await broker.dispatch("omr_browser", {
        action: "status",
        tor: true,
      });
      assert.equal(statusOut.isError, false);
      assert.match(statusOut.text, /"networkMode": "tor"/);

      const statusSnap = await mgr.status();
      const rendered = renderBrowserStatus(statusSnap);
      assert.match(rendered, /camofox/i);
      assert.match(rendered, /tor/i);
      assert.ok(discoverInstalledBrowsers().length >= 3);
    } finally {
      await new Promise((r) => srv.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers /browser (/camofox, /web, /tor), /ioc (/yara, /sigma, /dfir), /diff-cve (/patch-diff), /sandbox, /deobfuscate, and /sbom", () => {
    assert.equal(findCommand("browser")?.name, "browser");
    assert.equal(findCommand("camofox")?.name, "browser");
    assert.equal(findCommand("web")?.name, "browser");
    assert.equal(findCommand("tor")?.name, "browser");
    assert.equal(findCommand("ioc")?.name, "ioc");
    assert.equal(findCommand("yara")?.name, "ioc");
    assert.equal(findCommand("sigma")?.name, "ioc");
    assert.equal(findCommand("dfir")?.name, "ioc");
    assert.equal(findCommand("diff-cve")?.name, "diff-cve");
    assert.equal(findCommand("patch-diff")?.name, "diff-cve");
    assert.equal(findCommand("sandbox")?.name, "sandbox");
    assert.equal(findCommand("behavior")?.name, "sandbox");
    assert.equal(findCommand("proc-diff")?.name, "sandbox");
    assert.equal(findCommand("deobfuscate")?.name, "deobfuscate");
    assert.equal(findCommand("deobf")?.name, "deobfuscate");
    assert.equal(findCommand("strings-decrypt")?.name, "deobfuscate");
    assert.equal(findCommand("sbom")?.name, "sbom");
    assert.equal(findCommand("supply-chain")?.name, "sbom");
    assert.equal(findCommand("deps")?.name, "sbom");
  });

  it("autonomously routes natural-language requests to the 24 OMR workflows and serves full playbooks via omr_workflow", async () => {
    assert.equal(OMR_WORKFLOWS.length, 24);
    assert.equal(findOmrWorkflow("strings-decrypt")?.id, "deobfuscate");
    assert.equal(findOmrWorkflow("supply-chain")?.id, "sbom");
    assert.equal(findOmrWorkflow("proc-diff")?.id, "sandbox");
    assert.equal(findOmrWorkflow("mitre")?.id, "capa");
    assert.equal(findOmrWorkflow("iot")?.id, "firmware");
    assert.equal(findOmrWorkflow("mastg")?.id, "masvs");
    assert.equal(findOmrWorkflow("toolgen")?.id, "forge");

    // Natural-language Turkish & English queries without slash commands match the right playbooks
    const matchedTr = matchWorkflowsForInput(
      "bu dosyanın içindeki şifreli stringleri çöz ve yara kuralı çıkar",
      3,
    ).map((w) => w.id);
    assert.ok(matchedTr.includes("deobfuscate"));
    assert.ok(matchedTr.includes("ioc"));

    const matchedEn = matchWorkflowsForInput(
      "check supply chain dependencies, rpath hijacking, and sbom versions",
      3,
    ).map((w) => w.id);
    assert.equal(matchedEn[0], "sbom");

    const note = autonomousWorkflowNote(
      "run behavioral sandbox process diff and check dropped files",
    );
    assert.ok(note);
    assert.match(note, /\/sandbox/);
    assert.match(note, /omr_workflow/);

    // omr_workflow meta-tool lists all 20 workflows and loads any playbook on demand while promoting its tools
    const toolDef = (name) => ({
      name,
      description: name,
      summaryLine: name,
      searchKey: name,
      nameTokens: [name],
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    });
    const catalog = new Map(
      [
        "trace_native_values",
        "procedure_pseudo_code",
        "capture_process_scenario",
        "compare_process_captures",
        "trace_dylib_resolution",
      ].map((n) => [n, toolDef(n)]),
    );
    const rea = {
      find: (n) => catalog.get(n),
      tools: () => [...catalog.values()],
    };
    const broker = new ReaBroker(rea, {});

    assert.equal(
      broker.isReadOnly("omr_workflow", { workflow: "deobfuscate" }),
      true,
    );

    const indexOut = await broker.dispatch("omr_workflow", {});
    assert.equal(indexOut.isError, false);
    assert.match(indexOut.text, /\/sandbox/);
    assert.match(indexOut.text, /\/deobfuscate/);
    assert.match(indexOut.text, /\/sbom/);

    const deobfOut = await broker.dispatch("omr_workflow", {
      workflow: "deobfuscate",
      focus: "decrypt stack strings",
    });
    assert.equal(deobfOut.isError, false);
    assert.match(deobfOut.text, /Control-Flow|Deobfuscation/i);
    assert.match(deobfOut.text, /auto-saved to `<session>\/scripts\/`/);

    const exposed = broker
      .definitions({ targetPath: "/tmp/obf.elf", targetFormat: "ELF 64-bit" })
      .map((d) => d.function.name);
    assert.ok(
      exposed.includes("trace_native_values"),
      "omr_workflow promotes the playbook's REA tools into the active window",
    );
  });
});

describe("omr_run: verified script execution and CDP hardening", () => {
  const withScripts = async (fn) => {
    const dir = await mkdtemp(join(tmpdir(), "omr-run-"));
    try {
      const mgr = new BrowserManager(dir, {});
      const broker = new ReaBroker(
        { find: () => undefined, tools: () => [] },
        { browser: mgr, scriptsDir: () => dir },
      );
      await fn(broker, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("writes and runs a decryptor, returns real output, records the run, and is not treated as read-only", async () => {
    await withScripts(async (broker, dir) => {
      assert.equal(broker.isReadOnly("omr_run", { script: "a.py" }), false);
      const code =
        "key = 0x5a\nprint(bytes(b ^ key for b in bytes.fromhex('3f2f3e3b')).decode())\n";
      const out = await broker.dispatch("omr_run", {
        script: "decrypt.py",
        code,
      });
      assert.equal(out.isError, false);
      assert.match(out.text, /exit 0/);
      assert.match(out.text, /--- stdout ---\n.+/);
      assert.match(out.text, /sha256: [0-9a-f]{64}/);
      const { readdir, readFile } = await import("node:fs/promises");
      const runs = await readdir(join(dir, ".runs"));
      assert.equal(runs.length, 1);
      const record = JSON.parse(
        await readFile(join(dir, ".runs", runs[0]), "utf8"),
      );
      assert.equal(record.exitCode, 0);
      assert.equal(record.interpreter, "python3");
    });
  });

  it("reports failures honestly: non-zero exit is an error and stderr is returned", async () => {
    await withScripts(async (broker) => {
      const out = await broker.dispatch("omr_run", {
        script: "boom.py",
        code: "import sys\nsys.stderr.write('bad key')\nsys.exit(3)\n",
      });
      assert.equal(out.isError, true);
      assert.match(out.text, /exit 3/);
      assert.match(out.text, /bad key/);
    });
  });

  it("scrubs the ambient environment so provider keys never reach a script", async () => {
    await withScripts(async (broker) => {
      process.env.OMR_TEST_SECRET = "s3cr3t-value";
      try {
        const out = await broker.dispatch("omr_run", {
          script: "env.py",
          code: "import os\nprint('LEAK' if os.environ.get('OMR_TEST_SECRET') else 'clean')\n",
        });
        assert.match(out.text, /clean/);
        assert.doesNotMatch(out.text, /LEAK|s3cr3t-value/);
      } finally {
        delete process.env.OMR_TEST_SECRET;
      }
    });
  });

  it("keeps every path inside the session scripts directory, including symlinks", async () => {
    await withScripts(async (broker, dir) => {
      const { symlink } = await import("node:fs/promises");
      const outside = join(tmpdir(), `omr-outside-${process.pid}.py`);
      await writeFile(outside, "print('escaped')\n");
      try {
        await symlink(outside, join(dir, "link.py"));
        for (const script of [
          "../x.py",
          outside,
          "link.py",
          "sub/../../x.py",
        ]) {
          const out = await broker.dispatch("omr_run", { script });
          assert.equal(out.isError, true, script);
          assert.doesNotMatch(out.text, /escaped/);
        }
        const traversalWrite = await broker.dispatch("omr_run", {
          script: "../w.py",
          code: "print(1)",
        });
        assert.equal(traversalWrite.isError, true);
        assert.match(traversalWrite.text, /plain file name/);
      } finally {
        await rm(outside, { force: true });
      }
    });
  });

  it("kills runaway scripts at the timeout and bounds huge output", async () => {
    await withScripts(async (broker) => {
      const slow = await broker.dispatch("omr_run", {
        script: "slow.py",
        code: "import time\ntime.sleep(30)\n",
        timeout_s: 1,
      });
      assert.equal(slow.isError, true);
      assert.match(slow.text, /TIMED OUT/);

      const big = await broker.dispatch("omr_run", {
        script: "big.py",
        code: "print('A' * 300000)\n",
      });
      assert.equal(big.isError, false);
      assert.match(big.text, /omr dropped \d+ bytes/);
      assert.ok(big.text.length < 70_000);
    });
  });

  it("points .js files at Frida instead of running them under Node, and requires a session", async () => {
    await withScripts(async (broker) => {
      const out = await broker.dispatch("omr_run", {
        script: "hook.js",
        code: "console.log(1)",
      });
      assert.equal(out.isError, true);
      assert.match(out.text, /Frida/);
    });
    const bare = new ReaBroker({ find: () => undefined, tools: () => [] }, {});
    const none = await bare.dispatch("omr_run", { script: "a.py" });
    assert.equal(none.isError, true);
  });

  it("isolates the network by default and only reaches the host when asked", async (t) => {
    if (!(await networkIsolationAvailable())) {
      t.skip("unprivileged network namespaces are unavailable on this host");
      return;
    }
    const srv = createServer((req, res) => res.end("hit"));
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const code = `import socket\ns = socket.socket()\ns.settimeout(2)\ntry:\n    s.connect(('127.0.0.1', ${port}))\n    print('CONNECTED')\nexcept OSError:\n    print('BLOCKED')\n`;

    try {
      await withScripts(async (broker) => {
        const isolated = await broker.dispatch("omr_run", {
          script: "net.py",
          code,
        });
        assert.match(isolated.text, /network: isolated/);
        assert.match(isolated.text, /BLOCKED/);
        const host = await broker.dispatch("omr_run", {
          script: "net.py",
          network: true,
        });
        assert.match(host.text, /network: host/);
        assert.match(host.text, /CONNECTED/);
      });
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it("launches Chromium without the wildcard CDP origin allowance", () => {
    const args = buildChromiumLaunchArgs({
      profileDir: "/tmp/p",
      cdpPort: 4321,
      headless: true,
      networkMode: "direct",
      proxyUrl: null,
    });
    assert.ok(args.includes("--remote-debugging-port=4321"));
    assert.equal(
      args.some((a) => a.startsWith("--remote-allow-origins")),
      false,
    );
  });
});

describe("Intent routing corpus (Turkish + English): recall and zero false promotions", () => {
  const positives = [
    ["bu apk içindeki ssl pinning'i atlat", "frida"],
    ["dosyanın şifreleme algoritmasını bul ve çöz", "crypto"],
    ["paketlenmiş binary'yi aç", "unpack"],
    ["iki sürüm arasındaki güvenlik yamasını bul", "diff-cve"],
    ["bu zararlıyı analiz et yara yaz", "ioc"],
    ["ağ trafiğini incele pcap", "protocol"],
    ["çökme analizi yap sigsegv", "crash"],
    ["cloudflare engelliyor siteye gir", "browser"],
    ["tarayıcıyla siteyi aç", "browser"],
    ["kütüphane bağımlılıklarını çıkar", "sbom"],
    ["şifreli stringleri çöz", "deobfuscate"],
    ["saldırı yüzeyini çıkar", "surface"],
    ["find hardcoded api key", "crypto"],
    ["bypass license check", "frida"],
    ["unpack this pyinstaller binary", "unpack"],
    ["write a yara rule for this malware", "ioc"],
    ["diff the cve patch between 1.2 and 1.3", "diff-cve"],
    ["decrypt the config with aes", "crypto"],
    ["find the c2 beacon mutex", "ioc"],
    ["reconstruct the handshake opcodes from the pcap", "protocol"],
    ["list embedded libraries and an sbom", "sbom"],
    ["hook this function with frida", "frida"],
    ["pull logcat from the android device", "adb"],
    ["run it in a sandbox and watch the child process", "sandbox"],
    ["deobfuscate the stack strings", "deobfuscate"],
    ["use tor to open the .onion site", "browser"],
    ["why does the app crash with sigsegv", "crash"],
    ["write a script to solve it", "script"],
    ["map mitre att&ck techniques and capa rules", "capa"],
    ["extract squashfs partition and u-boot env from firmware", "firmware"],
    ["run owasp masvs mastg audit on exported activities", "masvs"],
    ["otomatik config extractor tool hazırla", "forge"],
  ];
  // Generic wording must route nowhere. The last two have no owning workflow today; the model
  // falls back to the workflow index in its system prompt.
  const negatives = [
    "please extract the strings and compare runtime device behaviour",
    "why does this proxy device dynamic extract fail",
    "explain what main does",
    "how does the license check work",
    "show me the imports",
    "what does this binary do",
    "ne işe yarıyor bu dosya",
    "decompile main and explain",
    "emulate this function",
    "fuzz the parser",
  ];

  it("routes every labeled request to its workflow", () => {
    const misses = positives.filter(
      ([q, id]) => !matchWorkflowsForInput(q, 2).some((w) => w.id === id),
    );
    assert.deepEqual(misses, [], `unrouted: ${JSON.stringify(misses)}`);
    assert.ok(positives.length >= 25);
  });

  it("routes generic wording nowhere", () => {
    const false_hits = negatives
      .map((q) => [q, matchWorkflowsForInput(q, 3).map((w) => w.id)])
      .filter(([, ids]) => ids.length > 0);
    assert.deepEqual(false_hits, []);
  });

  it("leaves the exposed tool list byte-identical on generic wording (prompt-cache safe)", () => {
    const tool = (name) => ({
      name,
      description: name,
      summaryLine: name,
      searchKey: name,
      nameTokens: [name],
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    });
    const catalog = new Map(
      [
        "instrument_with_frida",
        "start_gdb_session",
        "compare_artifacts",
        "inspect_signature",
        "read_bytes",
      ].map((n) => [n, tool(n)]),
    );
    const broker = new ReaBroker(
      { find: (n) => catalog.get(n), tools: () => [...catalog.values()] },
      {},
    );
    const ctx = { targetPath: "/tmp/a.elf", targetFormat: "ELF 64-bit" };
    const before = JSON.stringify(broker.definitions(ctx));
    for (const q of negatives) broker.beginTurn(q);
    assert.equal(JSON.stringify(broker.definitions(ctx)), before);
    broker.beginTurn("hook this function with frida");
    assert.ok(
      broker
        .definitions(ctx)
        .some((d) => d.function.name === "instrument_with_frida"),
    );
    broker.beginTurn("set a breakpoint in gdb");
    assert.ok(
      broker
        .definitions(ctx)
        .some((d) => d.function.name === "start_gdb_session"),
    );
  });
});

describe("LoopGuard: repeated identical calls stop burning steps", () => {
  it("lets identical read-only calls run twice, then answers instead of executing, regardless of key order", () => {
    const guard = new LoopGuard();
    const a = { path: "/x", detail: "summary" };
    const reordered = { detail: "summary", path: "/x" };
    for (let i = 0; i < LOOP_LIMIT; i += 1) {
      assert.equal(guard.check("xrefs", a, true), null);
      guard.record("xrefs", a, true, false);
    }
    assert.match(guard.check("xrefs", reordered, true), /loop guard/);
    assert.equal(
      guard.check("xrefs", { path: "/y" }, true),
      null,
      "different arguments are a different call",
    );
  });

  it("clears after a successful state-changing call, and blocks only repeated failures for mutating calls", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < LOOP_LIMIT; i += 1)
      guard.record("search_strings", { q: "k" }, true, false);
    assert.ok(guard.check("search_strings", { q: "k" }, true));
    guard.record("open_binary", { path: "/other" }, false, false);
    assert.equal(
      guard.check("search_strings", { q: "k" }, true),
      null,
      "session changed, results may differ",
    );

    guard.record("omr_run", { script: "a.py" }, false, true);
    assert.equal(
      guard.check("omr_run", { script: "a.py" }, false),
      null,
      "one failure may be retried",
    );
    guard.record("omr_run", { script: "a.py" }, false, true);
    assert.match(
      guard.check("omr_run", { script: "a.py" }, false),
      /failed 2 times/,
    );
  });

  it("warns a model that repeats the same call but still runs it and never ends the turn", async () => {
    let dispatched = 0;
    let step = 0;
    const model = {
      model: "loop",
      async stream() {
        step += 1;
        if (step <= 5) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [
              {
                id: `t${step}`,
                type: "function",
                function: {
                  name: "procedure_pseudo_code",
                  arguments: '{"symbol":"main"}',
                },
              },
            ],
            finishReason: "tool_calls",
            usage: null,
          };
        }
        return {
          content: "done",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    };
    const broker = {
      definitions: () => [],
      isReadOnly: () => true,
      async dispatch(name) {
        dispatched += 1;
        return {
          tool: name,
          text: "pseudo",
          isError: false,
          durationMs: 1,
          evidenceIds: [],
        };
      },
    };
    const agent = new Agent(model, broker, {
      systemPrompt: "sys",
      maxSteps: 10,
    });
    const turn = await agent.run("decompile main");
    assert.equal(turn.text, "done");
    assert.equal(dispatched, 5, "every call executes; the guard only nudges");
    const guarded = agent.history.filter(
      (m) => m.role === "tool" && /loop guard/.test(m.content ?? ""),
    );
    assert.equal(guarded.length, 5 - LOOP_LIMIT);
    assert.ok(guarded.every((m) => /pseudo/.test(m.content)), "the real result is still delivered");
    agent.history.forEach((m, i) => {
      if (m.role === "tool")
        assert.ok(
          agent.history[i - 1].tool_calls?.some(
            (c) => c.id === m.tool_call_id,
          ) || agent.history[i - 1].role === "tool",
        );
    });
  });
});

describe("Network Guard (◈ net guard): outage hold, live ping probe, and mid-stream auto-resume", () => {
  it("pauses on mid-turn or mid-stream internet drops, pings until connectivity returns, rolls back partial stream fragments, and resumes automatically without user intervention", async () => {
    let requestNum = 0;
    const srv = createServer((req, res) => {
      requestNum += 1;
      if (requestNum === 1) {
        // Step 1 succeeds and requests a local REA tool call
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_net_1",
                      type: "function",
                      function: {
                        name: "binary_overview",
                        arguments: '{"path":"/tmp/sample.elf"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }

      if (requestNum === 2) {
        // Step 2 starts streaming partial tokens, then drops connection mid-stream before finish_reason/[DONE]!
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: "partial thought before drop",
                  content: "Partial fragment that must be rolled back ",
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        // Prematurely close the stream without [DONE] or finish_reason to simulate Wi-Fi / ISP drop mid-stream
        res.end();
        return;
      }

      // Step 2 retry after ping succeeds: delivers complete final answer
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content:
                  "Complete forensic answer after internet came back [ev_net_01].",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 12,
            total_tokens: 32,
          },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address();
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

    try {
      let probeCalls = 0;
      const statusEvents = [];
      let streamResets = 0;

      const client = new ModelClient({
        baseUrl,
        apiKey: "sk-test",
        model: "gpt-4o",
        maxTokens: 256,
        temperature: 0,
        timeoutMs: 5000,
        maxRetries: 2,
        pingIntervalMs: 15,
        maxNetworkWaitMs: 5000,
        networkProbe: async () => {
          probeCalls += 1;
          if (probeCalls < 3) {
            return {
              ok: false,
              latencyMs: null,
              error: "ENETUNREACH 127.0.0.1",
            };
          }
          return {
            ok: true,
            latencyMs: 14,
          };
        },
      });

      const broker = {
        definitions: () => [],
        isReadOnly: () => true,
        async dispatch(name) {
          return {
            tool: name,
            text: '{"entry":"0x401000","evidence_id":"ev_net_01"}',
            isError: false,
            durationMs: 2,
            evidenceIds: ["ev_net_01"],
          };
        },
      };

      const agent = new Agent(client, broker, {
        systemPrompt: "sys",
        maxSteps: 6,
      });

      const ui = new TerminalUi({
        i18n: englishUi,
        commands: COMMANDS,
        theme: createTheme({ COLORTERM: "truecolor", TERM: "xterm-256color" }),
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      });

      const turn = await agent.run("triage /tmp/sample.elf", {
        onAssistantStart: () => ui.beginAssistant(),
        onReasoningDelta: (d) => ui.appendReasoning(d),
        onAssistantDelta: (d) => ui.appendAssistant(d),
        onAssistantEnd: (t) => ui.endAssistant(t),
        onStreamReset: () => {
          streamResets += 1;
          ui.resetActiveStream();
        },
        onNetworkStatus: (notice) => {
          statusEvents.push(notice);
          ui.setNetworkStatus(notice);
        },
      });

      assert.equal(requestNum, 3, "step 1 + dropped step 2 + auto-resumed step 2");
      assert.equal(probeCalls, 3, "probed 3 times until link came back");
      assert.equal(streamResets, 1, "rolled back the interrupted partial stream");
      assert.equal(
        turn.text,
        "Complete forensic answer after internet came back [ev_net_01].",
        "final answer has zero duplicate partial prefix from before the drop",
      );
      assert.equal(turn.aborted, false);
      assert.equal(turn.toolCalls, 1);

      // Verify status lifecycle: offline -> pinging -> restored
      assert.ok(statusEvents.some((e) => e.state === "offline"));
      assert.ok(statusEvents.some((e) => e.state === "pinging"));
      const restored = statusEvents.at(-1);
      assert.equal(restored?.state, "restored");
      assert.equal(restored?.latencyMs, 14);
      assert.equal(restored?.target, `127.0.0.1:${addr.port}`);

      // Verify real TCP probe helper against open vs closed port
      const liveProbe = await probeEndpointConnectivity(baseUrl, 1000);
      assert.equal(liveProbe.ok, true);
      assert.equal(typeof liveProbe.latencyMs, "number");
    } finally {
      srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    }

    const deadProbe = await probeEndpointConnectivity(baseUrl, 400);
    assert.equal(deadProbe.ok, false);
    assert.equal(formatPingTarget("https://api.openai.com/v1"), "api.openai.com:443");
    assert.equal(
      isNetworkOutageError(new TypeError("fetch failed: ECONNRESET")),
      true,
    );
  });

  it("renders the ◈ net guard ping box and ✓ PING OK restored badge cleanly across all viewport sizes", () => {
    const theme = createTheme({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });

    ui.setNetworkStatus({
      state: "pinging",
      attempt: 4,
      target: "api.anthropic.com:443",
      reason: "ENOTFOUND api.anthropic.com",
      offlineDurationMs: 6200,
      nextPingInMs: 2500,
      latencyMs: null,
    });

    for (const [cols, rows] of [
      [54, 15],
      [80, 24],
      [136, 38],
    ]) {
      const frame = ui.renderFrame(cols, rows);
      assert.equal(frame.lines.length, rows);
      for (const line of frame.lines) {
        assert.ok(
          visibleWidth(line) <= cols,
          `line width ${visibleWidth(line)} exceeds cols=${cols}`,
        );
      }
      const plain = frame.lines.map((l) => stripAnsi(l)).join("\n");
      assert.match(plain, /net guard/);
      assert.match(plain, /PING ──▸ api\.anthropic\.com:443/);
      assert.match(plain, /ping #4/);
    }

    // Now transition to restored state and verify ✓ tick badge is rendered
    ui.setNetworkStatus({
      state: "restored",
      attempt: 5,
      target: "api.anthropic.com:443",
      reason: "connected",
      offlineDurationMs: 7500,
      nextPingInMs: null,
      latencyMs: 21,
    });

    const restoredFrame = ui.renderFrame(100, 26);
    assert.equal(restoredFrame.lines.length, 26);
    const restoredPlain = restoredFrame.lines.map((l) => stripAnsi(l)).join("\n");
    assert.match(restoredPlain, /✓ link restored/);
    assert.match(restoredPlain, /✓ PING OK ──▸ api\.anthropic\.com:443 \(21ms\)/);
    assert.match(restoredPlain, /continuing session/);
  });
});

describe("Step budget auto-extension, mid-turn checkpoints, and crash-resume", () => {
  const toolStep = (n) => ({
    content: "",
    reasoning: "",
    toolCalls: [
      {
        id: `t${n}`,
        type: "function",
        function: {
          name: "procedure_pseudo_code",
          // Distinct arguments per step so LoopGuard never blocks them.
          arguments: JSON.stringify({ symbol: `fn_${n}` }),
        },
      },
    ],
    finishReason: "tool_calls",
    usage: null,
    reasoningContent: null,
    thinkingBlocks: [],
  });
  const finalStep = {
    content: "done",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    reasoningContent: null,
    thinkingBlocks: [],
  };
  const okBroker = (isError = false) => {
    let evidenceSequence = 0;
    return ({
    definitions: () => [],
    isReadOnly: () => true,
    async dispatch(name) {
      return {
        tool: name,
        text: "result",
        isError,
        durationMs: 1,
        evidenceIds: isError ? [] : [`ev_${(++evidenceSequence).toString(16).padStart(64, "0")}`],
      };
    },
    });
  };
  const scriptedModel = (toolSteps) => {
    let n = 0;
    return {
      model: "scripted",
      async stream() {
        n += 1;
        return n <= toolSteps ? toolStep(n) : finalStep;
      },
    };
  };

  it("parses --resume (last) and --resume=<id> without swallowing the target or command", () => {
    assert.equal(parseArgs(["node", "omr"]).resume, null);
    assert.equal(parseArgs(["node", "omr", "--resume"]).resume, "last");
    const withTarget = parseArgs(["node", "omr", "--resume", "/status"]);
    assert.equal(withTarget.resume, "last");
    assert.equal(withTarget.command, "/status");
    assert.equal(
      parseArgs(["node", "omr", "--resume=2026-11-10T10-00", "a.elf"]).resume,
      "2026-11-10T10-00",
    );
    assert.throws(() => parseArgs(["node", "omr", "--resume="]), /requires a value/);
  });

  it("extends the step budget while tool calls keep succeeding, up to the configured limit", async () => {
    // 7 productive steps with a 3-step budget: needs two extensions (3 -> 6 -> 9).
    const extended = [];
    const agent = new Agent(scriptedModel(7), okBroker(), {
      systemPrompt: "sys",
      maxSteps: 3,
      autoExtendSteps: 2,
    });
    const turn = await agent.run("go", {
      onStepBudgetExtended: (n) => extended.push(n),
    });
    assert.equal(turn.text, "done");
    assert.equal(turn.steps, 8);
    assert.deepEqual(
      extended.map((n) => [n.step, n.newBudget, n.extension, n.maxExtensions]),
      [
        [3, 6, 1, 2],
        [6, 9, 2, 2],
      ],
    );

    // A model that never stops is still cut off once the extensions are spent.
    const endless = new Agent(scriptedModel(1000), okBroker(), {
      systemPrompt: "sys",
      maxSteps: 3,
      autoExtendSteps: 2,
    });
    const capped = await endless.run("go");
    assert.equal(capped.steps, 9);
    assert.match(capped.text, /step limit reached: 9 model steps/);

    // Disabled by default and when set to 0: unchanged behavior.
    for (const opts of [{}, { autoExtendSteps: 0 }]) {
      const plain = new Agent(scriptedModel(1000), okBroker(), {
        systemPrompt: "sys",
        maxSteps: 3,
        ...opts,
      });
      const r = await plain.run("go");
      assert.equal(r.steps, 3);
      assert.match(r.text, /step limit reached: 3 model steps/);
    }

    // Failing tools are not progress: no extension is granted.
    const failing = new Agent(scriptedModel(1000), okBroker(true), {
      systemPrompt: "sys",
      maxSteps: 3,
      autoExtendSteps: 2,
    });
    assert.equal((await failing.run("go")).steps, 3);
  });

  it("checkpoints after every completed step with a valid, resumable history", async () => {
    const snapshots = [];
    const agent = new Agent(scriptedModel(3), okBroker(), {
      systemPrompt: "sys",
      maxSteps: 10,
    });
    await agent.run("go", {
      onCheckpoint: () => {
        snapshots.push(agent.history.map((m) => ({ ...m })));
      },
    });
    assert.equal(snapshots.length, 3, "one checkpoint per tool-bearing step");
    snapshots.forEach((history, i) => {
      assert.equal(history.at(-1).role, "tool", `checkpoint ${i + 1} ends on a tool result`);
      history.forEach((m, idx) => {
        if (m.role !== "tool") return;
        assert.ok(
          history[idx - 1].tool_calls?.some((c) => c.id === m.tool_call_id) ||
            history[idx - 1].role === "tool",
          "every tool result stays paired with its tool_call",
        );
      });
    });
  });

  it("persists the in-flight flag and reports it on load, clearing it on a normal save", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-inflight-"));
    try {
      const info = await createSession("/tmp/sample.elf", null, { rootDir: root });
      const messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "decompile main" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "x", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "main: 0x401000" },
      ];
      await saveSessionHistory(info, messages, "/tmp/sample.elf", "m", {
        inFlight: true,
      });
      let loaded = await loadSavedSession("last", undefined, root);
      assert.equal(loaded?.inFlight, true);
      assert.equal(loaded?.messages.at(-1)?.role, "tool");

      await saveSessionHistory(info, messages, "/tmp/sample.elf", "m");
      loaded = await loadSavedSession("last", undefined, root);
      assert.equal(loaded?.inFlight, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Provider Failover Chain, Proxy-Aware Net Guard, and Token Budget Guard", () => {
  it("switches to the next fallback candidate on primary failure and stays sticky", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryClient = {
      model: "openai:gpt-5.4",
      stream: async () => {
        primaryCalls += 1;
        throw new Error("HTTP 429 rate limit exceeded");
      },
    };
    const fallbackClient = {
      model: "anthropic:claude-sonnet-4-6",
      stream: async (_msgs, _tools, _signal, onText) => {
        fallbackCalls += 1;
        onText("recovered from fallback");
        return {
          message: { role: "assistant", content: "recovered from fallback" },
          finishReason: "stop",
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        };
      },
    };
    const notices = [];
    const failover = new FailoverModelClient(
      [
        { spec: "openai:gpt-5.4", client: primaryClient },
        { spec: "anthropic:claude-sonnet-4-6", client: fallbackClient },
      ],
      (n) => notices.push(n),
    );
    assert.equal(failover.model, "openai:gpt-5.4");
    const step1 = await failover.stream([], [], undefined, () => {});
    assert.equal(step1.message.content, "recovered from fallback");
    assert.equal(failover.model, "anthropic:claude-sonnet-4-6");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].from, "openai:gpt-5.4");
    assert.equal(notices[0].to, "anthropic:claude-sonnet-4-6");

    // Subsequent turns stick to the healthy fallback without re-hitting the dead primary
    await failover.stream([], [], undefined, () => {});
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 2);
  });

  it("resolves HTTPS_PROXY / HTTP_PROXY while honoring NO_PROXY and probes through proxy", async () => {
    const proxySrv = createServer((_req, res) => res.end("ok"));
    await new Promise((resolve) => proxySrv.listen(0, "127.0.0.1", resolve));
    const proxyPort = proxySrv.address().port;
    try {
      const envWithProxy = {
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "internal.corp,localhost",
      };
      const resolved = resolveProxyForEndpoint(
        "https://api.openai.com/v1",
        envWithProxy,
      );
      assert.equal(resolved?.host, "127.0.0.1");
      assert.equal(resolved?.port, proxyPort);
      assert.equal(
        resolveProxyForEndpoint("https://internal.corp/v1", envWithProxy),
        null,
      );

      // Probe an unreachable external port, but with HTTPS_PROXY pointing at our live local proxy server
      const probe = await probeEndpointConnectivity(
        "https://198.51.100.1:443/v1",
        2000,
        2000,
        envWithProxy,
      );
      assert.equal(probe.ok, true);
      assert.equal(probe.viaProxy, `127.0.0.1:${proxyPort}`);
    } finally {
      await new Promise((resolve) => proxySrv.close(resolve));
    }
  });

  it("parses token budgets, estimates cost, and halts the Agent loop cleanly when budgetTokens is reached", async () => {
    assert.equal(parseTokenBudgetSpec("500k"), 500_000);
    assert.equal(parseTokenBudgetSpec("1.5m"), 1_500_000);
    assert.equal(parseTokenBudgetSpec("off"), null);
    assert.deepEqual(
      parseFallbackModelsSpec("anthropic:claude-sonnet-4-6, ollama:qwen3-coder"),
      ["anthropic:claude-sonnet-4-6", "ollama:qwen3-coder"],
    );
    assert.ok(estimateSessionCostUsd("claude-sonnet-4-6", 1_000_000) > 0);
    assert.equal(estimateSessionCostUsd("ollama:qwen3", 1_000_000), 0);

    let stepCount = 0;
    const heavyUsageModel = {
      model: "gpt-5.4",
      stream: async () => {
        stepCount += 1;
        return {
          content: "",
          reasoning: "",
          toolCalls: [
            {
              id: `c_${stepCount}`,
              type: "function",
              function: { name: "t", arguments: JSON.stringify({ stepCount }) },
            },
          ],
          finishReason: "tool_calls",
          usage: {
            prompt_tokens: 600,
            completion_tokens: 400,
            total_tokens: 1_000,
          },
          reasoningContent: null,
          thinkingBlocks: [],
        };
      },
    };
    const broker = {
      definitions: () => [],
      dispatch: async () => ({
        callId: "c",
        name: "t",
        text: "ok",
        isError: false,
        durationMs: 1,
        evidenceIds: [],
      }),
    };
    const budgetEvents = [];
    const agent = new Agent(heavyUsageModel, broker, {
      systemPrompt: "sys",
      maxSteps: 10,
      budgetTokens: () => 1_500,
    });
    const turn = await agent.run("go", {
      onBudgetReached: (info) => budgetEvents.push(info),
    });
    // Step 1 uses 1000 tokens (<1500), step 2 brings totalTokens to 2000 (>=1500), so step 3 is blocked!
    assert.equal(turn.steps, 2);
    assert.equal(budgetEvents.length, 1);
    assert.equal(budgetEvents[0].usedTokens, 2_000);
    assert.equal(budgetEvents[0].budgetTokens, 1_500);
    assert.match(turn.text, /token budget reached \(2000 \/ 1500 tokens\)/);
  });
});

describe("Live TUI & Agent UX: steering, double-enter, wheel scroll, unrestricted thinking, first-paste delete, clipboard & box tables", () => {
  const theme = createTheme({
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
  });

  it("allows deleting the very first bracketed paste with Backspace immediately (no stuck pasteMode)", () => {
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });

    // Single-chunk bracketed paste followed by Backspace
    ui.handleText("\x1b[200~ilk yapistirma\x1b[201~");
    assert.equal(ui.pasteMode, false, "pasteMode must exit on the closing 201~ in the same chunk");
    assert.equal(ui.composer, "ilk yapistirma");

    ui.handleText("\x7f\x7f\x7f");
    assert.equal(
      ui.composer,
      "ilk yapisti",
      "Backspace immediately deletes characters from the first paste",
    );
  });

  it("scrolls chat timeline on SGR mouse wheel and arrow bursts without triggering input history, while single Up arrow recalls history", () => {
    const submitted = [];
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });

    // Populate input history with a prior command and add long chat output
    ui.handleText("onceki komut\r");
    assert.deepEqual(submitted, ["onceki komut"]);
    assert.equal(ui.composer, "");

    for (let i = 1; i <= 40; i += 1) {
      ui.addSystem(`satir ${i}: uzun sohbet gecmisi testi`);
    }
    ui.renderFrame(100, 24);
    assert.equal(ui.scroll, 0);

    // SGR mouse wheel up (\x1b[<64;20;10M) scrolls timeline up and NEVER loads history into composer
    ui.handleText("\x1b[<64;20;10M");
    assert.ok(ui.scroll > 0, "mouse wheel up scrolls chat timeline");
    assert.equal(
      ui.composer,
      "",
      "mouse wheel up must not pollute composer with input history",
    );

    // Coalesced arrow burst (terminal alternate-scroll) also scrolls timeline without touching history
    const prevScroll = ui.scroll;
    ui.handleText("\x1b[A\x1b[A\x1b[A");
    assert.ok(ui.scroll > prevScroll, "coalesced arrow burst scrolls timeline");
    assert.equal(ui.composer, "");

    // Wheel down back to bottom (scroll = 0)
    for (let i = 0; i < 10; i += 1) {
      ui.handleText("\x1b[<65;20;10M");
    }
    assert.equal(ui.scroll, 0);
    assert.equal(ui.composer, "");

    // Genuine single Up arrow at scroll === 0 recalls input history
    ui.handleText("\x1b[A");
    assert.equal(ui.composer, "onceki komut");
  });

  it("supports omp-style live steering queue (single Enter), Double-Enter immediate send, and Alt+Up dequeue", () => {
    const submissions = [];
    const queued = [];
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: (line, opts) => {
        submissions.push({ line, opts });
        if (!opts?.immediate && line.trim()) {
          queued.push(line.trim());
          ui.setQueuedSteers(queued);
        }
      },
      onDequeueSteer: () => {
        const text = queued.pop();
        ui.setQueuedSteers(queued);
        return text ? { text } : undefined;
      },
      onInterrupt: () => {},
      onExit: () => {},
    });

    ui.setBusy("thinking");

    // 1. Single Enter while busy -> queues steering (immediate: false)
    ui.handleText("ikinci adimda su adresi kontrol et\r");
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].line, "ikinci adimda su adresi kontrol et");
    assert.equal(submissions[0].opts?.immediate, false);
    assert.deepEqual(ui.getQueuedSteers(), ["ikinci adimda su adresi kontrol et"]);

    // Steering box is rendered above the composer
    const frameWithSteer = stripAnsi(ui.renderFrame(100, 28).lines.join("\n"));
    assert.match(frameWithSteer, /✻ steering/);
    assert.match(frameWithSteer, /ikinci adimda su adresi kontrol et/);

    // 2. Pressing Enter again on empty composer while steering is queued -> immediate interrupt & send!
    ui.handleText("\r");
    assert.equal(submissions.length, 2);
    assert.equal(submissions[1].line, "");
    assert.equal(submissions[1].opts?.immediate, true);

    // 3. Alt+Up (\x1b[1;3A) pops queued steering back into the composer for editing
    ui.handleText("\x1b[1;3A");
    assert.equal(ui.composer, "ikinci adimda su adresi kontrol et");
    assert.deepEqual(ui.getQueuedSteers(), []);
  });

  it("renders unrestricted omp-style thinking blocks without 3-line clipping or post-turn text wipe", () => {
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });

    const lines = Array.from(
      { length: 12 },
      (_, idx) => `Dusunce adimi #${idx + 1}: binary sembol ve xref analizi yapiliyor.`,
    ).join("\n");
    ui.appendReasoning(lines);

    const activeFrame = stripAnsi(ui.renderFrame(110, 36).lines.join("\n"));
    assert.match(activeFrame, /Thinking…/);
    assert.match(activeFrame, /Dusunce adimi #1:/);
    assert.match(activeFrame, /Dusunce adimi #12:/);

    // Finishing reasoning and assistant stream preserves full thought history
    ui.appendAssistant("Analiz tamamlandi.");
    ui.endAssistant("Analiz tamamlandi.");
    const doneFrame = stripAnsi(ui.renderFrame(110, 36).lines.join("\n"));
    assert.match(doneFrame, /Thought for/);
    assert.match(doneFrame, /Dusunce adimi #1:/);
    assert.match(doneFrame, /Dusunce adimi #12:/);
  });

  it("supports Ctrl+V image staging, Backspace image removal, Ctrl+Shift+V text paste, and Ctrl+Shift+C + mouse drag copy", async () => {
    // 1x1 PNG magic bytes
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    let copiedText = "";
    let submittedOpts = null;
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: (_line, opts) => {
        submittedOpts = opts;
      },
      onClipboardImage: () => ({
        mimeType: "image/png",
        bytes: pngBytes,
      }),
      onClipboardText: () => "panodan yapistirilan metin",
      onCopyText: (txt) => {
        copiedText = txt;
      },
      onInterrupt: () => {},
      onExit: () => {},
    });

    // Ctrl+V (\x16) stages the clipboard image
    ui.handleText("\x16");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.getStagedImages().length, 1);
    assert.equal(ui.getStagedImages()[0].mimeType, "image/png");

    // Backspace on empty composer removes the staged image
    ui.handleText("\x7f");
    assert.equal(ui.getStagedImages().length, 0);

    // Stage image again, then Ctrl+Shift+V (\x1b[118;6u) pastes text alongside it
    ui.handleText("\x16");
    await new Promise((r) => setTimeout(r, 20));
    ui.handleText("\x1b[118;6u");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.composer, "panodan yapistirilan metin");
    assert.equal(ui.getStagedImages().length, 1);

    // Submitting sends both text and ChatImageBlock attachment
    ui.handleText("\r");
    assert.equal(submittedOpts?.images?.length, 1);
    assert.equal(submittedOpts.images[0].mimeType, "image/png");

    // Add assistant message and test mouse drag selection + Ctrl+Shift+C copy
    ui.appendAssistant("Kopyalanacak onemli cikti satiri");
    ui.endAssistant("Kopyalanacak onemli cikti satiri");
    ui.renderFrame(100, 24);

    // Ctrl+Shift+C (\x1b[99;6u) without selection copies latest assistant response
    ui.handleText("\x1b[99;6u");
    assert.equal(copiedText, "Kopyalanacak onemli cikti satiri");
  });

  it("renders Markdown tables as clean aligned box tables and requires full outputs + recommendations in systemPrompt", () => {
    const md = [
      "## Data repaired",
      "",
      "| item | before | after |",
      "| --- | --- | --- |",
      "| `acc.txt` | 3 proven + `avs` missing | 6 proven, every one with a live inbox |",
      "| orphaned inboxes | 15 | 0 |",
      "| operator's `th-*` inboxes | 181 | **181 — untouched** |",
    ].join("\n");

    const rendered = stripAnsi(renderMarkdown(md, 92, theme).join("\n"));
    assert.match(rendered, /╭─+┬─+┬─+╮/, "renders top box border with column joints");
    assert.match(rendered, /├─+┼─+┼─+┤/, "renders header separator with column joints");
    assert.match(rendered, /╰─+┴─+┴─+╯/, "renders bottom box border with column joints");
    assert.match(rendered, /acc\.txt/);
    assert.match(rendered, /181 — untouched/);

    const sys = systemPrompt({
      target: null,
      sessionDir: "/tmp/s",
      journalPath: "/tmp/s/journal.jsonl",
      directTools: [],
    });
    assert.match(sys, /Never suppress or truncate findings/);
    assert.match(sys, /Öneriler & Sonraki Adımlar/);
    assert.match(sys, /Recommendations & Next Steps/);
  });

  it("hydrates full conversation history into TUI timeline, HUD recent calls, and composer history on /resume, and opens omp-style session picker modal", () => {
    let submittedLine = null;
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme,
      onSubmit: (line) => {
        submittedLine = line;
      },
      onInterrupt: () => {},
      onExit: () => {},
    });

    const restoredMessages = [
      {
        role: "user",
        content:
          "dostum bu hedefi analiz et\n\n[omr autonomous workflow match: /triage — Rapid binary triage]",
      },
      {
        role: "assistant",
        reasoning_content: "Once PE basliklarini ve importlari inceleyelim.",
        content: "Binary analizine basliyorum.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "omr_run",
              arguments: JSON.stringify({ command: "file target.bin", label: "check header" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content:
          "omr_run check header (bash) → exit 0 in 79 ms\nstdout:\nELF 64-bit LSB pie executable, evidence ev_deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      },
      {
        role: "assistant",
        content: "## Sonuc\nHedef ELF 64-bit PIE ikilisidir.",
      },
    ];

    ui.hydrateFromHistory(restoredMessages, {
      bannerText: "resumed session 2026-11-10T14-18-56-237Z-session (4 messages)",
    });

    const frame = stripAnsi(ui.renderFrame(140, 36).lines.join("\n"));
    assert.match(frame, /dostum bu hedefi analiz et/, "user prompt is rendered in viewport");
    assert.doesNotMatch(
      frame,
      /omr autonomous workflow match/,
      "internal workflow note is stripped from hydrated user message",
    );
    assert.match(frame, /Once PE basliklarini/, "historical reasoning block is rendered");
    assert.match(frame, /omr_run/, "historical tool call is rendered");
    assert.match(frame, /79ms/, "historical tool duration is parsed and displayed");
    assert.match(frame, /ev_deadbeef/, "historical evidence chip is extracted");
    assert.match(frame, /Hedef ELF 64-bit PIE ikilisidir/, "assistant response is rendered");
    assert.match(frame, /resumed session 2026-11-10T14-18-56-237Z-session/, "resume banner is rendered");

    // Up arrow recalls the restored user prompt from composer history
    ui.handleText("\x1b[A");
    assert.equal(ui.composer, "dostum bu hedefi analiz et");
    ui.handleText("\x1b[B");
    assert.equal(ui.composer, "");

    // Open session picker modal and select a session
    ui.openSessionPicker([
      {
        id: "2026-11-10T14-18-56-237Z-session",
        dir: "/tmp/s1",
        updatedAt: "2026-11-10T17:08:00.000Z",
        messageCount: 278,
        userTurnCount: 12,
        toolCallCount: 127,
        target: "target.bin",
        model: "custom:DeepSeek-V4.1-Flash",
        title: "dostum bu sistem tamamen calisir durumda mi kontrol et",
        firstUserPrompt: "dostum bu sistem tamamen calisir durumda mi kontrol et",
        lastMessagePreview: "All 6 proven accounts verified.",
        inFlight: false,
      },
      {
        id: "2026-11-10T12-00-00-000Z-session",
        dir: "/tmp/s2",
        updatedAt: "2026-11-10T12:30:00.000Z",
        messageCount: 42,
        userTurnCount: 4,
        toolCallCount: 18,
        target: "crackme.elf",
        model: "claude-sonnet-4-6",
        title: "crackme.elf icindeki lisans kontrolunu bul",
        firstUserPrompt: "crackme.elf icindeki lisans kontrolunu bul",
        lastMessagePreview: "Found check_serial at 0x401210",
        inFlight: true,
      },
    ]);

    assert.equal(ui.isSessionPickerOpen, true);
    const modalFrame = stripAnsi(ui.renderFrame(140, 36).lines.join("\n"));
    assert.match(modalFrame, /◈ resume session/);
    assert.match(modalFrame, /278 msg/);
    assert.match(modalFrame, /dostum bu sistem tamamen calisir/);

    // Filter by typing "crackme" and press Enter
    ui.handleText("crackme");
    ui.handleText("\r");
    assert.equal(ui.isSessionPickerOpen, false);
    assert.equal(submittedLine, "/resume 2026-11-10T12-00-00-000Z-session");
  });

  it("renders real-time & per-turn TPS in bottom status bar and HUD, fetches all endpoint models with capability tags, derives work-based session titles, and supports #index / shortId resume", async () => {
    let submittedLine = null;
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      onSubmit: (line) => {
        submittedLine = line;
      },
      onInterrupt: () => {},
      onExit: () => {},
    });

    // 1. Bottom status bar & HUD show provider:model and real-time / final TPS
    ui.setStatus({
      model: "riverai/deepseek-ai/DeepSeek-V4.1-Flash-1017",
      modelProvider: "custom",
      tps: 68.4,
      tpsLive: true,
      ttftMs: 240,
    });
    const frameLive = stripAnsi(ui.renderFrame(140, 36).lines.join("\n"));
    assert.match(
      frameLive,
      /◆ custom:DeepSeek-V4\.1-Flash-1017/,
      "status bar shows provider:model",
    );
    assert.match(
      frameLive,
      /⚡ 68\.4 tps/,
      "status bar shows real-time TPS speed",
    );
    assert.match(
      frameLive,
      /speed\s+⚡ 68\.4 tok\/s \(240ms\)/,
      "HUD telemetry shows tok/s and TTFT",
    );

    // 2. Typing `/res` + Enter completes and submits `/resume` directly (not `/resume ` sub-arg menu)
    ui.handleText("/res");
    ui.handleText("\r");
    assert.equal(
      submittedLine,
      "/resume",
      "/res + Enter submits /resume directly to open interactive picker",
    );

    // 3. Work-based chat title derivation filters operating-spec boilerplate & negations
    const derivedWorkTitle = deriveSessionTitle(
      [
        {
          role: "user",
          content:
            "This document is the operating specification for the assistant in this workspace.\nThis is a real production run.",
        },
        {
          role: "assistant",
          content: "Inspecting workspace...",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "omr_run",
                arguments: JSON.stringify({
                  command:
                    "cd /home/dev/Desktop/sample-project && ls -la",
                }),
              },
            },
          ],
        },
        {
          role: "user",
          content: "yes make it and do not push and do not make batch",
        },
        {
          role: "assistant",
          content:
            "Done.\n\n**`proxies.txt`**: 60 proxies, 60 live, 0 dead, 0 duplicates.",
        },
      ],
      null,
      null,
    );
    assert.match(
      derivedWorkTitle.title,
      /sample-project/,
      "derives project name from tool call path",
    );
    assert.match(
      derivedWorkTitle.title,
      /60 proxies, 60 live/,
      "derives outcome summary from assistant completion",
    );
    assert.doesNotMatch(
      derivedWorkTitle.title,
      /operating specification/i,
      "filters pasted operating specification boilerplate",
    );

    // 4. Short session ID formatting and numeric `#1` / `shortId` loading
    assert.equal(
      formatShortSessionId("2026-11-10T17-49-13-994Z-session"),
      "1110-1749",
    );
    const tmpRoot = await mkdtemp(join(tmpdir(), "omr-sess-short-"));
    try {
      const s1 = await createSession("crackme.elf", "custom:DeepSeek-V4.1", {
        rootDir: tmpRoot,
      });
      await saveSessionHistory(
        s1,
        [
          { role: "user", content: " crackme.elf lisans kontrolunu coz " },
          {
            role: "assistant",
            content: "## Lisans Kontrolu Cozuldu\nAnahtar: OMR-2026.",
          },
        ],
        "crackme.elf",
        "custom:DeepSeek-V4.1",
      );
      const list = await listRecentSessions(10, undefined, tmpRoot);
      assert.equal(list.length, 1);
      assert.equal(list[0].index, 1);
      assert.equal(list[0].shortId, formatShortSessionId(s1.id));
      assert.match(list[0].title, /crackme\.elf/);
      assert.match(list[0].title, /Lisans Kontrolu Cozuldu/);

      const byNum = await loadSavedSession("1", undefined, tmpRoot);
      assert.ok(byNum, "loads session by numeric index '1'");
      assert.equal(byNum.summary.id, s1.id);

      const byHashNum = await loadSavedSession("#1", undefined, tmpRoot);
      assert.ok(byHashNum, "loads session by '#1'");
      assert.equal(byHashNum.summary.id, s1.id);

      const byShortId = await loadSavedSession(
        list[0].shortId,
        undefined,
        tmpRoot,
      );
      assert.ok(byShortId, "loads session by shortId");
      assert.equal(byShortId.summary.id, s1.id);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    // 5. Live model fetching extracts rich model metadata & capabilities from custom endpoint
    const mockServer = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "riverai/deepseek-ai/DeepSeek-V4.1-Flash-1017",
                owned_by: "riverai",
                context_length: 1000000,
                supported_parameters: ["reasoning", "tools"],
                architecture: { input_modalities: ["text", "image"] },
              },
              {
                id: "combo/claude-sonnet-4-6",
                owned_by: "combo",
                contextWindow: 200000,
                thinking: true,
                tool_call: true,
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    try {
      const addr = mockServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const refreshed = await fetchProviderModels({
        id: "custom",
        name: "Custom Endpoint",
        protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        connected: true,
        local: false,
        apiKey: "sk-test-key",
        apiKeyEnv: "NINEROUTER_API_KEY",
        keySource: "env NINEROUTER_API_KEY",
        envHint: "NINEROUTER_API_KEY",
        headers: {},
        models: [],
        liveLoaded: false,
        error: null,
      });
      assert.equal(refreshed.liveLoaded, true);
      assert.equal(refreshed.models.length, 2);
      const ds = refreshed.models.find((m) => m.id.includes("DeepSeek-V4.1"));
      assert.ok(ds);
      assert.match(ds.note ?? "", /riverai/);
      assert.match(ds.note ?? "", /1M ctx/);
      assert.match(ds.note ?? "", /think/);
      assert.match(ds.note ?? "", /vision/);
      assert.match(ds.note ?? "", /tools/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});

describe("Vision, Chat Image Attachment, Multi-Source Screenshots, @file/@image Mentions, and Autonomous Agent Vision Tools", () => {
  it("encodes/decodes RGB PNG, transcodes 24-bit BMP to PNG, renders 24-bit ANSI terminal half-block previews, and produces non-vision forensic fallbacks", () => {
    const w = 12;
    const h = 8;
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 3;
        rgb[idx] = x * 20;
        rgb[idx + 1] = y * 30;
        rgb[idx + 2] = 180;
      }
    }
    const pngBuf = encodeRgbPng(w, h, rgb, {
      Title: "OMR Visual Evidence",
      Author: "oh-my-rea",
    });
    assert.ok(pngBuf.length > 32);
    const decoded = decodePngRgba(pngBuf);
    assert.ok(decoded);
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.equal(decoded.rgba[0], 0);
    assert.equal(decoded.rgba[1], 0);
    assert.equal(decoded.rgba[2], 180);
    assert.equal(decoded.rgba[3], 255);

    // 24-bit ANSI half-block preview
    const previewLines = renderAnsiImagePreview(pngBuf, {
      maxCols: 12,
      maxRows: 4,
      filePath: "/tmp/sample.png",
    });
    assert.ok(previewLines.length >= 2);
    assert.match(previewLines.join("\n"), /▀/);
    assert.match(previewLines.join("\n"), /\x1b\[38;2;/);

    // Synthesize a minimal 2x2 24-bit uncompressed BMP and transcode to PNG
    const rowStride = 8; // ((2 * 3 + 3) & ~3) = 8
    const pixelArraySize = rowStride * 2;
    const bmpBuf = Buffer.alloc(54 + pixelArraySize, 0);
    bmpBuf.write("BM", 0, "ascii");
    bmpBuf.writeUInt32LE(54 + pixelArraySize, 2);
    bmpBuf.writeUInt32LE(54, 10);
    bmpBuf.writeUInt32LE(40, 14);
    bmpBuf.writeInt32LE(2, 18);
    bmpBuf.writeInt32LE(2, 22);
    bmpBuf.writeUInt16LE(1, 26);
    bmpBuf.writeUInt16LE(24, 28);
    bmpBuf[54] = 255;
    bmpBuf[55] = 0;
    bmpBuf[56] = 128;
    const transcodedPng = transcodeBmpToPng(bmpBuf);
    assert.ok(transcodedPng);
    const decodedBmp = decodePngRgba(transcodedPng);
    assert.ok(decodedBmp);
    assert.equal(decodedBmp.width, 2);
    assert.equal(decodedBmp.height, 2);

    // Forensic image inspection & non-vision text fallback
    const forensics = inspectImageForensics(pngBuf, "image/png", "sample.png");
    assert.equal(forensics.width, 12);
    assert.equal(forensics.height, 8);
    assert.equal(forensics.sha256.length, 64);
    assert.ok(forensics.textChunks.some((c) => c.key === "Title" && c.value === "OMR Visual Evidence"));

    const fallbackText = describeAttachedImagesFallback([
      {
        mimeType: "image/png",
        data: pngBuf.toString("base64"),
      },
    ]);
    assert.match(fallbackText, /\[Attached Image #1 \(vision fallback for text-only endpoint\)/);
    assert.match(fallbackText, /12×8px/);
    assert.match(fallbackText, /OMR Visual Evidence/);

    // Verify toOpenAiMessages and buildAnthropicPayload use fallback when imageInputs is false
    const msgWithImage = [
      {
        role: "user",
        content: "Bu gorselde ne var?",
        images: [
          {
            mimeType: "image/png",
            data: pngBuf.toString("base64"),
          },
        ],
      },
    ];
    const openAiNoVision = toOpenAiMessages(msgWithImage, true, false);
    assert.equal(typeof openAiNoVision[0].content, "string");
    assert.match(openAiNoVision[0].content, /vision fallback for text-only endpoint/);

    const anthropicNoVision = buildAnthropicPayload(
      msgWithImage,
      [],
      {
        provider: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-6",
        apiKey: "test",
        keySource: "test",
        headers: {},
        maxTokens: 1024,
        maxSteps: 10,
        autoExtendSteps: 0,
        temperature: 0,
        reasoningEffort: "off",
        timeoutMs: 5000,
        pingIntervalMs: 0,
        netWaitMs: 0,
        fallbackModels: [],
        budgetTokens: 0,
      },
      { disableImages: true },
    );
    const firstBlock = anthropicNoVision.messages[0].content[0];
    assert.equal(firstBlock.type, "text");
    assert.match(firstBlock.text, /vision fallback for text-only endpoint/);

    // OSC 8 hyperlink helper
    const link = osc8FileLink("/tmp/chart.png", "chart.png");
    assert.match(link, /\x1b\]8;;file:\/\/\/tmp\/chart\.png\x07chart\.png\x1b\]8;;\x07/);
    assert.equal(isImageFilePath("screenshot.webp"), true);
    assert.equal(isImageFilePath("notes.txt"), false);
  });

  it("renders a 640x360 2D RGB Byte-Class & Shannon Entropy Heatmap PNG for binary visual forensics", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "omr-vision-bin-"));
    try {
      const binPath = join(tmpDir, "target.elf");
      const buf = Buffer.alloc(16384);
      // ELF header + zeros + ASCII table + high-entropy pseudo-encrypted block
      buf.write("\x7fELF\x02\x01\x01\x00", 0, "binary");
      buf.write("SECRET_LICENSE_GATE_2026_OMR_FORENSICS\x00".repeat(40), 1024, "utf8");
      for (let i = 4096; i < 16384; i++) {
        buf[i] = (i * 73 + 41) & 0xff;
      }
      await writeFile(binPath, buf);

      const res = await renderBinaryVisualForensicsPng(binPath, tmpDir);
      assert.equal(res.width, 640);
      assert.equal(res.height, 360);
      assert.match(res.path, /binary-vision-target\.elf\.png$/);
      assert.ok(res.avgEntropy > 3.0);
      assert.ok(res.peakEntropy >= res.avgEntropy);

      const shot = await captureScreenshot({
        mode: "binary",
        targetPath: binPath,
        outputDir: tmpDir,
        cwd: tmpDir,
      });
      assert.equal(shot.mode, "binary");
      assert.equal(shot.width, 640);
      assert.equal(shot.height, 360);
      assert.equal(shot.mimeType, "image/png");
      assert.ok(shot.bytes.length > 100);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("completes @file / @image mentions in TUI and extracts @image attachments + @file:start-end context blocks on turn submission", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "omr-mentions-"));
    try {
      const rgb = new Uint8Array(4 * 4 * 3).fill(200);
      const pngBuf = encodeRgbPng(4, 4, rgb);
      const imgPath = join(tmpDir, "evidence.png");
      const srcPath = join(tmpDir, "gate.c");
      await writeFile(imgPath, pngBuf);
      await writeFile(
        srcPath,
        [
          "#include <stdio.h>",
          "int verify_token(const char *t) {",
          "  return t[0] == 'O' && t[1] == 'M' && t[2] == 'R';",
          "}",
        ].join("\n"),
        "utf8",
      );

      // 1. Direct completion helper
      const completion = completeAtMention("incele @ev", 10, tmpDir);
      assert.ok(completion);
      assert.ok(completion.candidates.some((c) => c.replacement.includes("@evidence.png")));
      assert.ok(completion.candidates.some((c) => c.badge === "IMG"));

      // 2. TUI `@` autocomplete popup and Tab completion
      const ui = new TerminalUi({
        i18n: englishUi,
        commands: COMMANDS,
        cwd: tmpDir,
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      });
      ui.handleText("bu gorsele bak @ev");
      const frame = stripAnsi(ui.renderFrame(120, 32).lines.join("\n"));
      assert.match(frame, /@ mention \(images & files\)/);
      assert.match(frame, /evidence\.png/);
      ui.handleText("\t");
      assert.match(ui.composer, /@evidence\.png /);

      // 3. extractPromptMentions resolves @evidence.png into an attached image and @gate.c:2-3 into a <file> slice
      const resolved = await extractPromptMentions(
        "Incele: @evidence.png ve @gate.c:2-3 icindeki kontrolu acikla",
        tmpDir,
      );
      assert.equal(resolved.images.length, 1);
      assert.equal(resolved.images[0].mimeType, "image/png");
      assert.equal(resolved.images[0].width, 4);
      assert.equal(resolved.images[0].height, 4);
      assert.equal(resolved.fileBlocks.length, 1);
      assert.equal(resolved.fileBlocks[0].displayPath, "gate.c");
      assert.equal(resolved.fileBlocks[0].lineRange, "2-3");
      assert.match(resolved.fileBlocks[0].content, /2: int verify_token/);
      assert.match(resolved.fileBlocks[0].content, /3:   return t\[0\] == 'O'/);
      assert.doesNotMatch(resolved.fileBlocks[0].content, /1: #include/);
      assert.match(resolved.contextAppendix ?? "", /<file path="gate\.c".*lines="2-3">/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows the agent to autonomously load images via omr_view_image and omr_screenshot and injects ChatImageBlock[] into the next model step", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "omr-agent-vision-"));
    try {
      const rgb = new Uint8Array(8 * 8 * 3).fill(120);
      const pngBuf = encodeRgbPng(8, 8, rgb);
      const imgPath = join(tmpDir, "ui_screen.png");
      await writeFile(imgPath, pngBuf);

      const fakeRea = {
        tools: () => [],
        find: () => undefined,
        prompts: () => [],
        callTool: async () => ({ ok: true, text: "", raw: {}, evidenceIds: [], unknownIds: [] }),
        getPrompt: async () => "",
        sessionDir: tmpDir,
      };
      const broker = new ReaBroker(fakeRea, {
        cwd: tmpDir,
        getTargetPath: () => imgPath,
      });

      // Verify omr_view_image returns BrokerOutcome.images
      const viewOutcome = await broker.dispatch("omr_view_image", {
        source: imgPath,
        detail: "high",
      });
      assert.equal(viewOutcome.isError, false);
      assert.ok(viewOutcome.images && viewOutcome.images.length === 1);
      assert.equal(viewOutcome.images[0].mimeType, "image/png");

      // Verify Agent.run injects a user vision message right after the tool step
      let stepCount = 0;
      let sawInjectedVisionOnStep2 = false;
      const fakeModel = {
        model: "vision-test-model",
        stream: async (messages, _tools, _signal, onText) => {
          stepCount++;
          if (stepCount === 1) {
            const tc = {
              id: "call_view_1",
              type: "function",
              function: {
                name: "omr_view_image",
                arguments: JSON.stringify({ source: imgPath }),
              },
            };
            return {
              content: "Loading image...",
              reasoning: "",
              toolCalls: [tc],
              finishReason: "tool_calls",
              usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
              reasoningContent: null,
              thinkingBlocks: [],
            };
          }
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === "user" && Array.isArray(lastMsg.images) && lastMsg.images.length === 1) {
            sawInjectedVisionOnStep2 = true;
          }
          onText?.("Visual analysis complete: 8x8 PNG verified.");
          return {
            content: "Visual analysis complete: 8x8 PNG verified.",
            reasoning: "",
            toolCalls: [],
            finishReason: "stop",
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
            reasoningContent: null,
            thinkingBlocks: [],
          };
        },
        summarize: async () => "summary",
      };

      const agent = new Agent(fakeModel, broker, {
        maxSteps: 6,
        systemPrompt: () => "You are OMR.",
      });
      const turn = await agent.run("Inspect ui_screen.png");
      assert.equal(sawInjectedVisionOnStep2, true);
      assert.match(turn.text, /8x8 PNG verified/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads clipboard images from KDE Plasma Klipper store and handles Ctrl+V + empty/Klipper bracketed paste in TUI", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "omr-klipper-clip-"));
    const prevKlipperEnv = process.env.OMR_KLIPPER_DATA_DIR;
    try {
      process.env.OMR_KLIPPER_DATA_DIR = tmpDir;

      // 1. Create an older text entry and a newer PNG image entry in Klipper's data directory
      const textHash = "1111111111111111111111111111111111111111";
      const imgHash = "2222222222222222222222222222222222222222";
      const textDir = join(tmpDir, textHash);
      const imgDir = join(tmpDir, imgHash);
      await mkdir(textDir, { recursive: true });
      await mkdir(imgDir, { recursive: true });

      await writeFile(join(textDir, textHash), "eski metin kopyasi", "utf8");
      const oldTime = new Date(Date.now() - 10_000);
      await utimes(textDir, oldTime, oldTime);

      const rgb = new Uint8Array(16 * 9 * 3).fill(180);
      const pngBuf = encodeRgbPng(16, 9, rgb);
      await writeFile(join(imgDir, imgHash), pngBuf);
      const newTime = new Date(Date.now());
      await utimes(imgDir, newTime, newTime);

      assert.equal(isKlipperImagePlaceholder("▨ 1920 × 168"), true);
      assert.equal(isKlipperImagePlaceholder("normal text"), false);

      const klipperImg = await readKdeKlipperClipboardImage(tmpDir);
      assert.ok(klipperImg);
      assert.equal(klipperImg.mimeType, "image/png");
      assert.equal(klipperImg.bytes.length, pngBuf.length);

      // When newest entry is an image, readKdeKlipperClipboardText returns "" so image paste wins
      const klipperTextWhileImg = await readKdeKlipperClipboardText(tmpDir);
      assert.equal(klipperTextWhileImg, "");

      const clipImg = await readImageFromClipboard(tmpDir);
      assert.ok(clipImg);
      assert.equal(clipImg.mimeType, "image/png");

      // 2. Verify TUI attaches clipboard image on:
      //    - Ctrl+V (\x16)
      //    - Empty bracketed paste (\x1b[200~\x1b[201~) sent by terminals when pasting an image
      //    - KDE Klipper placeholder bracketed paste (\x1b[200~▨ 16 × 9\x1b[201~)
      const submitted = [];
      const ui = new TerminalUi({
        i18n: englishUi,
        commands: COMMANDS,
        cwd: tmpDir,
        onSubmit: (line, opts) => {
          submitted.push({ line, opts });
        },
        onInterrupt: () => {},
        onExit: () => {},
      });

      // Empty bracketed paste (\x1b[200~\x1b[201~)
      ui.handleText("\x1b[200~\x1b[201~");
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(ui.getStagedImages().length, 1);
      assert.equal(ui.getStagedImages()[0].width, 16);
      assert.equal(ui.getStagedImages()[0].height, 9);

      // KDE Klipper placeholder bracketed paste (\x1b[200~▨ 16 × 9\x1b[201~)
      ui.handleText("\x1b[200~▨ 16 × 9\x1b[201~");
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(ui.getStagedImages().length, 2);
      assert.equal(ui.composer, "");

      // Composer frame shows staged image count and prompt placeholder
      const frame = stripAnsi(ui.renderFrame(120, 32).lines.join("\n"));
      assert.match(frame, /prompt · 📎 2 images/);

      // Running a slash command (/image) does NOT consume staged images in submit()
      ui.handleText("/image\r");
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].line, "/image");
      assert.equal(submitted[0].opts, undefined);
      assert.equal(ui.getStagedImages().length, 2);

      // Pressing Enter on an empty composer sends the staged images directly to the model
      ui.handleText("\r");
      assert.equal(submitted.length, 2);
      assert.equal(submitted[1].line, "");
      assert.equal(submitted[1].opts?.images?.length, 2);
      assert.equal(ui.getStagedImages().length, 0);
    } finally {
      if (prevKlipperEnv === undefined) delete process.env.OMR_KLIPPER_DATA_DIR;
      else process.env.OMR_KLIPPER_DATA_DIR = prevKlipperEnv;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});




describe("Uninterrupted turns: empty tool_calls recovery & robust terminal input", () => {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const stubBroker = {
    definitions: () => [],
    async dispatch(name) {
      return { tool: name, text: '{"ok":true}', isError: false, durationMs: 1, evidenceIds: [] };
    },
  };

  it("repairs a finish_reason=tool_calls reply that carried no tool call instead of ending the turn", async () => {
    const checkpoints = [];
    let calls = 0;
    const model = {
      model: "fake",
      async stream(messages) {
        calls += 1;
        if (calls === 1) return { content: "", reasoning: "", toolCalls: [], finishReason: "tool_calls", usage };
        if (calls === 2) {
          const last = messages.at(-1);
          assert.equal(last.role, "user");
          assert.match(last.content, /contained no valid tool call/);
          return { content: "", reasoning: "", toolCalls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }], finishReason: "tool_calls", usage };
        }
        return { content: "done", reasoning: "", toolCalls: [], finishReason: "stop", usage };
      },
    };
    const agent = new Agent(model, stubBroker, {
      systemPrompt: "s",
      maxSteps: 3,
      historyCheckpoint: async (messages) => { checkpoints.push(structuredClone(messages)); },
    });
    const turn = await agent.run("go");
    assert.equal(turn.status, "completed");
    assert.equal(turn.text, "done");
    assert.equal(calls, 3);
    // The empty assistant reply must not stay in history as a content:null protocol violation.
    for (const messages of checkpoints) {
      assert.ok(messages.filter((m) => m.role === "assistant").every((m) => m.content !== null || m.tool_calls?.length));
    }
  });

  it("continues after a length cut-off and still reports partial after repeated empty replies", async () => {
    let calls = 0;
    const model = {
      model: "fake",
      async stream() {
        calls += 1;
        if (calls === 1) return { content: "half", reasoning: "", toolCalls: [], finishReason: "length", usage };
        return { content: "rest", reasoning: "", toolCalls: [], finishReason: "stop", usage };
      },
    };
    const turn = await new Agent(model, stubBroker, { systemPrompt: () => "s", maxSteps: 3 }).run("go");
    assert.equal(turn.status, "completed");
    assert.equal(calls, 2);

    let always = 0;
    const stuck = {
      model: "fake",
      async stream() {
        always += 1;
        return { content: "", reasoning: "", toolCalls: [], finishReason: "tool_calls", usage };
      },
    };
    const stalledAgent = new Agent(stuck, stubBroker, { systemPrompt: "s" });
    const stalled = await stalledAgent.run("go");
    assert.equal(stalled.status, "partial");
    assert.equal(stalled.finishReason, "tool_calls");
    assert.equal(always, 4);
    assert.ok(stalledAgent.history.every((message) => message.role !== "assistant"));
  });

  const makeUi = (over = {}) => {
    const events = { interrupts: 0, exits: 0 };
    const ui = new TerminalUi({
      i18n: englishUi,
      commands: COMMANDS,
      theme: createTheme({ COLORTERM: "truecolor", TERM: "xterm-256color" }),
      onSubmit: () => {},
      onInterrupt: () => { events.interrupts += 1; },
      onExit: () => { events.exits += 1; },
      ...over,
    });
    return { ui, events };
  };

  it("joins an SGR mouse sequence split across chunks instead of firing a phantom Esc interrupt", async () => {
    const { ui, events } = makeUi();
    ui.setBusy("working");
    ui.handleText("\x1b[<64;10");
    ui.handleText(";5M");
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(events.interrupts, 0, "split wheel sequence must not cancel the turn");
    assert.equal(ui.composer, "", "no stray characters leak into the composer");
    ui.handleText("\x1b[<64;10");
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(events.interrupts, 0, "an abandoned sequence is not a lone Esc");
    // A genuine lone Esc still cancels, after the short wait.
    ui.handleText("\x1b");
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(events.interrupts, 1);
  });

  it("keeps a bracketed paste intact when the markers are split across chunks and chunks are slow", async () => {
    const { ui } = makeUi();
    ui.handleText("\x1b[20");
    ui.handleText("0~abc");
    assert.equal(ui.pasteMode, true);
    await new Promise((r) => setTimeout(r, 300)); // well past the old 150 ms safety flush
    assert.equal(ui.pasteMode, true, "paste must survive a slow gap between chunks");
    ui.handleText("def\x1b[2");
    ui.handleText("01~");
    assert.equal(ui.pasteMode, false);
    assert.equal(ui.composer, "abcdef");
  });

  it("interrupts on the first Ctrl+C and supports Shift+Insert and Ctrl+Insert", async () => {
    const copies = [];
    const { ui, events } = makeUi({ onClipboardText: async () => "yapistirilan", onCopyText: (text) => copies.push(text) });
    ui.setBusy("working");
    ui.handleText("\x03");
    assert.equal(events.interrupts, 1);

    ui.setBusy(null);
    ui.handleText("\x1b[2;2~");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ui.composer, "yapistirilan");
    ui.endAssistant("copied response");
    ui.handleText("\x1b[2;5~");
    assert.deepEqual(copies, ["copied response"]);
  });
});

describe("Remembered thinking effort", () => {
  it("persists only reasoning_effort, keeps other keys, and is picked up by the next launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-effort-"));
    try {
      const env = { XDG_CONFIG_HOME: dir, NINEROUTER_API_KEY: "k" };
      await mkdir(join(dir, "rea"), { recursive: true });
      const cfg = join(dir, "rea", "omr-model.json");
      await writeFile(
        cfg,
        JSON.stringify({ base_url: "https://x.example/v1", model: "m1", api_key_env: "NINEROUTER_API_KEY", max_steps: 40 }),
      );
      assert.equal(resolveModelConfig(env).config.reasoningEffort, "auto", "no stored effort yet");

      assert.equal(saveReasoningEffortDefault("high", env), cfg);
      const stored = JSON.parse(await (await import("node:fs/promises")).readFile(cfg, "utf8"));
      assert.equal(stored.reasoning_effort, "high");
      assert.equal(stored.model, "m1");
      assert.equal(stored.max_steps, 40);
      assert.equal(resolveModelConfig(env).config.reasoningEffort, "high", "next launch starts with the chosen effort");
      assert.equal(resolveModelConfig(env).config.maxSteps, 0);
      assert.equal(resolveModelConfig(env).config.autoExtendSteps, 0);

      saveReasoningEffortDefault("off", env);
      assert.equal(resolveModelConfig(env).config.reasoningEffort, "off");
      // An explicit env override still wins for a single run.
      assert.equal(resolveModelConfig({ ...env, OMR_EFFORT: "low" }).config.reasoningEffort, "low");

      const malformed = '{"reasoning_effort":';
      await writeFile(cfg, malformed);
      assert.throws(() => saveReasoningEffortDefault("high", env), /Unable to read the existing model configuration/);
      assert.equal(await (await import("node:fs/promises")).readFile(cfg, "utf8"), malformed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
