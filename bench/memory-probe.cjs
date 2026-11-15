// Separate process high-water RSS, in Node's documented KiB units.
process.once("exit", () => {
  const usage = process.resourceUsage();
  process.stderr.write(`\nOMR_BENCH_RESOURCE ${JSON.stringify({ maxRssKiB: usage.maxRSS, rssBytes: process.memoryUsage().rss, userCpuUs: usage.userCPUTime, systemCpuUs: usage.systemCPUTime })}\n`);
});
