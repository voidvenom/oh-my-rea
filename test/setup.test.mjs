import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, nodeSatisfiesRea, parseVersion } from "../dist/setup.js";

test("parseVersion extracts the first semver triple", () => {
  assert.deepEqual(parseVersion("rea 6.9.0\n"), [6, 9, 0]);
  assert.equal(parseVersion("no version"), null);
});

test("compareVersions orders numerically, not lexically", () => {
  assert.ok(compareVersions([6, 10, 0], [6, 9, 9]) > 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test("nodeSatisfiesRea matches rea-agents engines ^22.23.4 || ^24.22.1 || >=26.12.1", () => {
  for (const ok of [[22, 23, 4], [22, 99, 0], [24, 22, 1], [24, 30, 0], [26, 12, 1], [27, 0, 0]]) assert.equal(nodeSatisfiesRea(ok), true, ok.join("."));
  for (const bad of [[22, 23, 3], [22, 0, 0], [23, 5, 0], [24, 22, 0], [25, 9, 0], [26, 12, 0], [20, 0, 0]]) assert.equal(nodeSatisfiesRea(bad), false, bad.join("."));
});
