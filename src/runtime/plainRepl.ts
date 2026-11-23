import { createInterface } from "node:readline";
import type { OmrContext } from "./context.js";

/** readline handles raw Ctrl+C itself; cooked/host interrupts arrive on process instead. */
export const runPlainRepl = (ctx: OmrContext, resumeLine: string | null,
  submit: (line: string, after: () => void) => void, detach: () => void): Promise<number> => {
  const options = { input: process.stdin, output: process.stdout, prompt: "omr › " };
  let repl;
  try { repl = createInterface({ ...options, terminal: process.env["TERM"] !== "dumb" }); }
  catch (error) {
    if (!(error instanceof Error) || !/setRawMode/.test(error.message)) throw error;
    repl = createInterface({ ...options, terminal: false });
  }
  const prompt = (): void => repl.prompt();
  let interrupted = false;
  const onInterrupt = (): void => {
    if (ctx.activeAbort) { ctx.activeAbort.abort(); return; }
    interrupted = true;
    repl.close();
  };
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  process.on("SIGINT", onInterrupt);
  repl.on("SIGINT", onInterrupt);
  repl.on("line", line => submit(line, prompt));
  repl.once("close", () => {
    process.off("SIGINT", onInterrupt);
    detach();
    void ctx.shutdown(interrupted ? "cancelled" : "complete").then(() => resolve(interrupted ? 130 : 0), reject);
  });
  if (resumeLine) submit(resumeLine, prompt);
  else prompt();
  return promise;
};
