/**
 * Keystroke capture for the window between process start and the TUI taking over stdin.
 *
 * Until raw mode is on, the terminal's line discipline owns the keyboard: Enter arrives as `\n`
 * (which the composer treats as "insert newline", not "submit") and nothing is handled until a
 * whole line is read. Starting raw capture before the heavy modules load, then replaying the
 * buffered bytes into the TUI, means a command typed during startup is neither lost nor mangled.
 */
let listener: ((chunk: string | Buffer) => void) | null = null;
let buffered: string[] = [];

/** Puts a TTY stdin in raw mode and buffers what is typed. No-op when stdin is not a TTY. */
export const beginEarlyInput = (): void => {
  if (listener || !process.stdin.isTTY) return;
  buffered = [];
  listener = (chunk) => {
    buffered.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8"); // multi-byte characters split across reads are reassembled
  process.stdin.on("data", listener);
  process.stdin.resume();
};

const detach = (): string => {
  if (!listener) return "";
  process.stdin.off("data", listener);
  listener = null;
  const text = buffered.join("");
  buffered = [];
  return text;
};

/**
 * Hands the captured bytes to the TUI and leaves stdin flowing in raw mode. Call it synchronously
 * next to attaching the TUI's own `data` listener so no chunk can arrive in between.
 */
export const takeEarlyInput = (): string => normalizeTypedAhead(detach());

/**
 * Bytes typed before raw mode was on went through the tty's cooked line discipline, which turns Enter
 * (`\r`) into `\n`. The composer reads `\n` as "insert newline", so a command typed that early would
 * never run. One plain line ending in a single `\n` is that Enter; anything else (multi-line paste,
 * escape sequences) is left exactly as typed.
 */
export const normalizeTypedAhead = (text: string): string => text.replace(/^([^\r\n\x1b]+)\n$/, "$1\r");

/** The TUI will not start (plain / JSON / one-shot run): restore the terminal and drop the buffer. */
export const releaseEarlyInput = (): void => {
  if (!listener) return;
  detach();
  process.stdin.setRawMode(false);
  process.stdin.pause();
};
