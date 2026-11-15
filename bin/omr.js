#!/usr/bin/env node
import("../dist/main.js").catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
