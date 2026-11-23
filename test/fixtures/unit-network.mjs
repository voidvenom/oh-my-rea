// Unit tests can make real loopback requests to their own fixtures. Public endpoints must be mocked.
const realFetch = globalThis.fetch;
const unexpected = new Set();
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return realFetch(input, init);
  }
  const target = `${url.origin}${url.pathname}`;
  unexpected.add(target);
  throw new Error(`Public fetch in unit test: ${target}`);
};

process.on("exit", () => {
  // Production often degrades gracefully on a failed probe. Fail the test gate even if it caught the error.
  if (unexpected.size) {
    process.stderr.write(`Unexpected public fetches in unit tests:\n${[...unexpected].join("\n")}\n`);
    process.exitCode = 1;
  }
});
