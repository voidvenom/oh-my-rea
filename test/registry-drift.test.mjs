import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../dist/commands.js";
import { OMR_PROFILES } from "../dist/profiles.js";
import { OMR_WORKFLOWS } from "../dist/prompts.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

describe("Single-source command registry, handler binding, and zero-drift invariants", () => {
  it("derives every OMR_WORKFLOWS entry into COMMANDS, binds a runtime handler, and documents it in README.md", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const registry = createDefaultCommandRegistry();

    for (const wf of OMR_WORKFLOWS) {
      const cmd = COMMANDS.find((c) => c.name === wf.id);
      assert.ok(
        cmd,
        `OMR_WORKFLOWS entry "${wf.id}" is missing from COMMANDS`,
      );
      assert.deepEqual(
        cmd.aliases ?? [],
        wf.aliases,
        `Command /${wf.id} aliases drifted from OMR_WORKFLOWS`,
      );
      assert.equal(
        cmd.description,
        wf.summary,
        `Command /${wf.id} description drifted from OMR_WORKFLOWS.summary`,
      );
      assert.equal(
        cmd.workflowId,
        wf.id,
        `Command /${wf.id} workflowId drifted from OMR_WORKFLOWS`,
      );
      assert.equal(
        registry.hasHandler(wf.id),
        true,
        `Command /${wf.id} has no registered handler in CommandRegistry`,
      );
      assert.equal(
        readme.includes(`/${wf.id}`),
        true,
        `README.md does not document /${wf.id}`,
      );
    }
  });

  it("registers a runtime handler for every built-in command in COMMANDS (except exit) with zero name/alias collisions", () => {
    const registry = createDefaultCommandRegistry();
    assert.deepEqual(registry.missingBuiltinHandlers(), []);

    const seenKeys = new Map();
    for (const cmd of COMMANDS) {
      for (const key of [cmd.name, ...(cmd.aliases ?? [])]) {
        const lower = key.toLowerCase();
        assert.equal(
          seenKeys.has(lower),
          false,
          `Duplicate command name or alias "${lower}" between /${seenKeys.get(lower)} and /${cmd.name}`,
        );
        seenKeys.set(lower, cmd.name);
      }
      assert.ok(
        cmd.requires,
        `Command /${cmd.name} must declare explicit requires metadata`,
      );
    }
  });

  it("keeps src/runtime.ts as a lean composition root (<= 400 lines) and keeps profiles/subagents free of refusal language", async () => {
    const runtimeSrc = await readFile(
      join(repoRoot, "src", "runtime.ts"),
      "utf8",
    );
    const lineCount = runtimeSrc.split("\n").length;
    assert.ok(
      lineCount <= 400,
      `Expected src/runtime.ts to stay <= 400 lines, got ${lineCount}`,
    );

    const subagentSrc = await readFile(
      join(repoRoot, "src", "subagent.ts"),
      "utf8",
    );
    const forbidden =
      /\b(?:i cannot assist|i can't assist|as an ai|for educational purposes only|seek permission|obtain authorization|unethical|illegal activity)\b/i;

    for (const profile of OMR_PROFILES) {
      assert.equal(
        forbidden.test(profile.systemLens),
        false,
        `Profile "${profile.id}" contains restricted/disclaimer phrasing`,
      );
      assert.equal(
        forbidden.test(profile.summary),
        false,
        `Profile "${profile.id}" summary contains restricted/disclaimer phrasing`,
      );
    }
    assert.equal(
      forbidden.test(subagentSrc),
      false,
      "subagent.ts contains restricted/disclaimer phrasing",
    );
  });
});
