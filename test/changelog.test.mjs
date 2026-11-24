import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHANGELOG_FILE, changelogText, parseChangelog, releaseSummary } from "../dist/changelog.js";
import { VERSION } from "../dist/version.js";

test("the packaged changelog covers the current version and lists releases newest first", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const markdown = await readFile(CHANGELOG_FILE, "utf8");
  const sections = parseChangelog(markdown);
  assert.equal(pkg.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[""].version, VERSION);
  assert.ok(pkg.files.includes("CHANGELOG.md"));
  assert.ok(sections.has(VERSION));
  assert.equal([...sections.keys()][0], "Unreleased");
  const releases = [...sections.keys()].slice(1);
  assert.deepEqual(releases, releases.toSorted((a, b) => b.localeCompare(a, "en", { numeric: true })));
  for (const version of ["0.5.0", "0.5.1", "0.6.0"]) assert.ok(sections.has(version), version);
  for (const version of releases) {
    const section = sections.get(version);
    assert.match(section.split("\n")[0], /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/);
    assert.ok(releaseSummary(section));
    for (const [, label] of section.matchAll(/^### (.*)$/gm)) {
      assert.ok(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"].includes(label), label);
    }
  }
  assert.equal(await changelogText(), sections.get(VERSION));
  assert.equal(await changelogText("v0.5.1"), sections.get("0.5.1"));
  assert.equal(await changelogText("--all"), markdown.replaceAll("\r\n", "\n").trim());
  assert.equal(await changelogText("9.9.9"), null);
  assert.throws(() => parseChangelog("## [0.6.0]\n## [0.6.0]\n"), /Duplicate/);
});

test("a CRLF changelog produces the same release notes and full text as LF", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omr-changelog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "CHANGELOG.md");
  const markdown = "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-11-23\n\n### Fixed\n\n- First sentence. Second sentence.\n";
  const crlf = markdown.replaceAll("\n", "\r\n");
  await writeFile(file, crlf);

  assert.deepEqual(parseChangelog(crlf), parseChangelog(markdown));
  const section = await changelogText("v1.2.3", file);
  assert.equal(section, markdown.slice(markdown.indexOf("## [1.2.3]")).trim());
  assert.equal(releaseSummary(section), "- First sentence.");
  assert.equal(await changelogText("--all", file), markdown.trim());
});
