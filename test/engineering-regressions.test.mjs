import assert from "node:assert/strict";
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runSessionScript } from "../dist/exec.js";
import { JournalTailer } from "../dist/journal.js";
import { Rea } from "../dist/rea.js";

const withScratch = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), "omr-regression-"));
  const scriptsDir = join(root, "scripts");
  await mkdir(scriptsDir);
  try {
    await fn({ root, scriptsDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const waitUntil = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

describe("B07: MCP startup owns failed child processes", () => {
  it("keeps normal discovery, tool calls and explicit close working", async () => {
    await withScratch(async ({ root }) => {
      const pidPath = join(root, "pid");
      const lost = [];
      let rea;
      try {
        rea = await Rea.connect(join(root, "session"), {
          PATH: process.env.PATH,
          OMR_REA_COMMAND: fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)),
          OMR_FIXTURE_PID_FILE: pidPath,
          OMR_FIXTURE_MODE: "normal",
        }, [], { onLost: (detail) => lost.push(detail) });
        assert.equal(rea.tools()[0].name, "fixture_echo");
        assert.deepEqual((await rea.call("fixture_echo", { value: 42 })).payload, { value: 42 });
        const pid = Number(await readFile(pidPath, "utf8"));
        await rea.close();
        assert.equal(await waitUntil(() => !isAlive(pid)), true);
        assert.deepEqual(lost, []);
      } finally { await rea?.close(); }
    });
  });

  it("does not spawn a child when startup is already cancelled", async () => {
    await withScratch(async ({ root }) => {
      const abort = new AbortController();
      abort.abort();
      const pidPath = join(root, "pid");
      await assert.rejects(Rea.connect(join(root, "session"), {
        OMR_REA_COMMAND: fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)),
        OMR_FIXTURE_PID_FILE: pidPath,
      }, [], { signal: abort.signal }), { name: "AbortError" });
      await assert.rejects(lstat(pidPath), { code: "ENOENT" });
    });
  });

  it("cancels an initialization that never receives a response", async () => {
    await withScratch(async ({ root }) => {
      const abort = new AbortController();
      const pidPath = join(root, "pid");
      let pid;
      const startup = Rea.connect(join(root, "session"), {
        PATH: process.env.PATH,
        OMR_REA_COMMAND: fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)),
        OMR_FIXTURE_PID_FILE: pidPath,
        OMR_FIXTURE_MODE: "quiet-init",
      }, [], { signal: abort.signal });
      const rejected = assert.rejects(startup, { name: "AbortError" });
      try {
        assert.equal(await waitUntil(async () => {
          try { pid = Number(await readFile(pidPath, "utf8")); return true; } catch { return false; }
        }), true);
        abort.abort();
        await rejected;
        assert.equal(await waitUntil(() => !isAlive(pid)), true);
      } finally {
        abort.abort();
        if (pid && isAlive(pid)) process.kill(pid, "SIGTERM");
        await rejected;
      }
    });
  });

  it("closes the stdio peer when catalog discovery fails", async () => {
    await withScratch(async ({ root }) => {
      const pidPath = join(root, "pid");
      let pid;
      try {
        await assert.rejects(Rea.connect(join(root, "session"), {
          PATH: process.env.PATH,
          OMR_REA_COMMAND: fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)),
          OMR_FIXTURE_PID_FILE: pidPath,
        }, []), /controlled catalog failure/);
        pid = Number(await readFile(pidPath, "utf8"));
        assert.equal(await waitUntil(() => !isAlive(pid)), true, "failed startup left its child running");
      } finally {
        if (pid && isAlive(pid)) {
          process.kill(pid, "SIGTERM");
          await waitUntil(() => !isAlive(pid));
        }
      }
    });
  });
});

describe("B11: concurrent journal readers share one incremental pass", () => {
  it("counts records once and still consumes appended partial lines", async () => {
    await withScratch(async ({ root }) => {
      const path = join(root, "journal.jsonl");
      const call = JSON.stringify({ type: "tool.call", call_id: "c1", tool: "read_bytes" });
      const result = JSON.stringify({ type: "tool.result", call_id: "c1", tool: "read_bytes", ok: true });
      await writeFile(path, `${call}\n${result}\n`);
      const tailer = new JournalTailer(path);
      const snapshots = await Promise.all(Array.from({ length: 10 }, () => tailer.sync()));
      assert.equal(tailer.snapshot().counts.records, 2);
      assert.equal(tailer.snapshot().counts.tool_calls, 1);
      assert.ok(snapshots.every((s) => s.counts.records === 2));
      await appendFile(path, '{"type":"session.end","outcome":"complete"');
      await Promise.all([tailer.sync(), tailer.sync()]);
      assert.equal(tailer.snapshot().counts.records, 2);
      await appendFile(path, "}\n");
      await Promise.all([tailer.sync(), tailer.sync()]);
      assert.equal(tailer.snapshot().counts.records, 3);
      assert.equal(tailer.snapshot().phase, "ended");
    });
  });
});

describe("B01: script publication preserves files outside the session", () => {
  it("rejects a symlink before writing its existing external target", async () => {
    await withScratch(async ({ root, scriptsDir }) => {
      const outside = join(root, "outside.mjs");
      const original = "console.log('original');\n";
      await writeFile(outside, original);
      await symlink(outside, join(scriptsDir, "decoder.mjs"));
      const result = await runSessionScript({
        scriptsDir,
        script: "decoder.mjs",
        code: "console.log(42);\n",
      });
      assert.ok("error" in result);
      assert.equal(await readFile(outside, "utf8"), original);
      assert.equal((await lstat(join(scriptsDir, "decoder.mjs"))).isSymbolicLink(), true);
    });
  });

  it("does not create an external target through a dangling symlink", async () => {
    await withScratch(async ({ root, scriptsDir }) => {
      const outside = join(root, "absent.mjs");
      await symlink(outside, join(scriptsDir, "decoder.mjs"));
      const result = await runSessionScript({ scriptsDir, script: "decoder.mjs", code: "console.log(42);" });
      assert.ok("error" in result);
      await assert.rejects(lstat(outside), { code: "ENOENT" });
    });
  });

  it("replaces a regular hardlinked script without changing the other link", async () => {
    await withScratch(async ({ root, scriptsDir }) => {
      const outside = join(root, "outside.mjs");
      const original = "console.log('original');\n";
      await writeFile(outside, original);
      await link(outside, join(scriptsDir, "decoder.mjs"));
      const result = await runSessionScript({ scriptsDir, script: "decoder.mjs", code: "console.log(42);\n" });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /42/);
      assert.equal(await readFile(outside, "utf8"), original);
      assert.equal(await readFile(join(scriptsDir, "decoder.mjs"), "utf8"), "console.log(42);\n");
    });
  });
});
