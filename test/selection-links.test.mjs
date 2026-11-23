import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createTheme, highlightVisualCols, slicePlainByVisualCols, stripAnsi, styleVisualSpans, visibleWidth } from "../dist/ansi.js";
import { I18n } from "../dist/i18n/index.js";
import { findLinks, linkSpansForLines, osc8Spans, safeLinkUrl, trimUrl } from "../dist/links.js";
import { openerCommand, openUrl } from "../dist/opener.js";
import { ClickCounter, lineRange, normalizeSelection, selectionRowSpans, wordRangeAt } from "../dist/selection.js";
import { SUPPORT_URL } from "../dist/support.js";
import { TerminalUi } from "../dist/tui.js";

const theme = createTheme({ TERM: "xterm-256color", COLORTERM: "truecolor" });
const INV = "\x1b[7m";

/** Display columns of a rendered line that are drawn with SGR 7 (inverse). */
const inverseCols = (line) => {
  const cols = [];
  let col = 0;
  let inverse = false;
  for (let i = 0; i < line.length;) {
    const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (sgr) {
      for (const code of sgr[1].split(";")) {
        if (code === "7") inverse = true;
        if (code === "27" || code === "0" || code === "") inverse = false;
      }
      i += sgr[0].length;
      continue;
    }
    const osc = /^\x1b\]8;[^\x07]*\x07/.exec(line.slice(i));
    if (osc) {
      i += osc[0].length;
      continue;
    }
    const cp = line.codePointAt(i);
    const width = visibleWidth(String.fromCodePoint(cp));
    for (let k = 0; k < width; k += 1) if (inverse) cols.push(col + k);
    col += width;
    i += cp > 0xffff ? 2 : 1;
  }
  return cols;
};
const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);

const makeUi = async (language = "en", extra = {}) => {
  const i18n = new I18n();
  await i18n.switchTo(language);
  const copied = [];
  const opened = [];
  const ui = new TerminalUi({
    i18n, theme, commands: [], onSubmit() {}, onInterrupt() {}, onExit() {},
    onCopyText: (text) => copied.push(text), onOpenUrl: (url) => opened.push(url), ...extra,
  });
  return { ui, copied, opened };
};
// SGR mouse reports: 1-based column/row; 32 = motion, 16 = Ctrl.
const press = (ui, col, row, btn = 0) => ui.handleText(`\x1b[<${btn};${col + 1};${row + 1}M`);
const drag = (ui, col, row) => ui.handleText(`\x1b[<32;${col + 1};${row + 1}M`);
const release = (ui, col, row, btn = 0) => ui.handleText(`\x1b[<${btn};${col + 1};${row + 1}m`);
const findCell = (lines, text) => {
  const row = lines.findIndex((line) => stripAnsi(line).includes(text));
  assert.ok(row >= 0, `"${text}" is not on screen`);
  const plain = stripAnsi(lines[row]);
  return { row, col: visibleWidth(plain.slice(0, plain.indexOf(text))) };
};

test("the span styler keeps width, survives resets and colours, and restores the line style", () => {
  const line = `${theme.muted}abc ${theme.neonCyan}def${theme.reset} ${theme.userBg}ghi${theme.reset}`;
  const out = highlightVisualCols(line, 2, 9);
  assert.equal(stripAnsi(out), stripAnsi(line));
  assert.equal(visibleWidth(out), visibleWidth(line));
  assert.deepEqual(inverseCols(out), range(2, 9));
  // The background of "ghi" after the span is replayed, not lost.
  assert.ok(out.endsWith(`${theme.userBg}hi${theme.reset}`) || out.includes(`\x1b[0m${theme.userBg}hi`), JSON.stringify(out));

  // Wide glyphs: touching either cell selects the glyph; combining marks stay with their base.
  const wide = "a界b éx ığş";
  assert.deepEqual(inverseCols(highlightVisualCols(wide, 2, 3)), [1, 2]);
  assert.equal(slicePlainByVisualCols(wide, 2, 3), "界");
  assert.equal(slicePlainByVisualCols(wide, 5, 6), "é");
  assert.match(highlightVisualCols(wide, 5, 6), /\x1b\[7mé\x1b\[0m/);
  assert.equal(slicePlainByVisualCols(wide, 8, 11), "ığş");
  assert.deepEqual(inverseCols(highlightVisualCols(wide, 8, 11)), [8, 9, 10]);

  const linked = styleVisualSpans("see https://x.io now", [{ from: 4, to: 16, on: "\x1b[4m", href: "https://x.io/" }]);
  assert.equal(stripAnsi(linked), "see https://x.io now");
  assert.ok(linked.includes("\x1b]8;;https://x.io/\x07\x1b[4mhttps://x.io\x1b]8;;\x07"));
});

test("selection geometry maps multi-line, scrolled and clipped selections to frame cells", () => {
  assert.equal(normalizeSelection({ line: 3, col: 4 }, { line: 3, col: 4 }), null);
  const sel = normalizeSelection({ line: 7, col: 2 }, { line: 4, col: 5 });
  assert.deepEqual(sel, { startLine: 4, startCol: 5, endLine: 7, endCol: 2 });
  const widths = [10, 10, 10, 10, 12, 0, 30, 9];
  const spans = selectionRowSpans(sel, { firstLine: 5, height: 3, rowOffset: 1, colOffset: 2, width: 20 }, (i) => widths[i]);
  // Line 4 is scrolled off; line 5 is empty; line 6 is clipped to the 20-column region.
  assert.deepEqual(spans, [{ row: 2, from: 2, to: 22 }, { row: 3, from: 2, to: 4 }]);
});

test("double-click words and triple-click lines use display columns, including Turkish and wide text", () => {
  const plain = "  açık hedef yok: /open <path>. 界面 https://ex.io/a?b=1.";
  const col = (text) => visibleWidth(plain.slice(0, plain.indexOf(text)));
  assert.deepEqual(wordRangeAt(plain, col("açık") + 2), { from: col("açık"), to: col("açık") + 4 });
  assert.deepEqual(wordRangeAt(plain, col("yok")), { from: col("yok"), to: col("yok") + 3 }, "trailing ':' is not part of the word");
  assert.deepEqual(wordRangeAt(plain, col("界面") + 3), { from: col("界面"), to: col("界面") + 4 });
  assert.deepEqual(wordRangeAt(plain, col("https") + 9), { from: col("https"), to: col("https") + "https://ex.io/a?b=1".length });
  assert.equal(wordRangeAt(plain, 0), null);
  assert.deepEqual(wordRangeAt(plain, col("<")), { from: col("<"), to: col("<") + 1 });
  assert.deepEqual(lineRange(plain), { from: 2, to: visibleWidth(plain) });
  assert.equal(lineRange("   "), null);
  const clicks = new ClickCounter(400);
  assert.deepEqual([clicks.press(1, 1, 0), clicks.press(1, 2, 100), clicks.press(1, 2, 200), clicks.press(1, 2, 300)], [1, 2, 3, 1]);
  assert.equal(clicks.press(1, 2, 2000), 1);
  assert.equal(clicks.press(2, 2, 2100), 1);
});

test("dragging highlights the selection live in the transcript and copies it on release", async () => {
  const { ui, copied } = await makeUi("tr");
  ui.addUser("merhaba");
  ui.addSystem("Kanıt dayalı ikili dosya incelemesi\nikinci satır: çözümleme ve şifre");
  let lines = ui.renderFrame(100, 24).lines;
  const a = findCell(lines, "dayalı");
  const b = findCell(lines, "çözümleme");
  press(ui, a.col, a.row);
  drag(ui, a.col + 3, a.row);
  lines = ui.renderFrame(100, 24).lines;
  assert.deepEqual(inverseCols(lines[a.row]), range(a.col, a.col + 3), "highlight follows the drag");
  drag(ui, b.col + "çözümleme".length, b.row);
  lines = ui.renderFrame(100, 24).lines;
  assert.ok(inverseCols(lines[a.row]).includes(a.col));
  assert.deepEqual(inverseCols(lines[b.row]).filter((c) => c >= b.col), range(b.col, b.col + "çözümleme".length));
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
  release(ui, b.col + "çözümleme".length, b.row);
  assert.deepEqual(copied, ["dayalı ikili dosya incelemesi\n· ikinci satır: çözümleme"]);
  lines = ui.renderFrame(100, 24).lines;
  assert.ok(inverseCols(lines[b.row]).length > 0, "the copied selection stays visible");
  assert.match(stripAnsi(lines.at(-1)), /Seçim kopyalandı/);

  ui.handleKey("\x1b");
  lines = ui.renderFrame(100, 24).lines;
  assert.ok(lines.every((line) => !line.includes(INV)), "Esc clears the highlight");
  await delay(500); // let the drag press above fall out of the double-click window

  // Double-click selects a word, triple-click the whole line; a single click clears.
  press(ui, a.col + 1, a.row); release(ui, a.col + 1, a.row);
  press(ui, a.col + 1, a.row); release(ui, a.col + 1, a.row);
  assert.equal(copied.at(-1), "dayalı");
  assert.deepEqual(inverseCols(ui.renderFrame(100, 24).lines[a.row]), range(a.col, a.col + 6));
  press(ui, a.col + 1, a.row); release(ui, a.col + 1, a.row);
  assert.equal(copied.at(-1), "· Kanıt dayalı ikili dosya incelemesi", "triple-click copies the whole rendered line");
  await delay(500);
  press(ui, 50, a.row + 6); release(ui, 50, a.row + 6);
  assert.ok(ui.renderFrame(100, 24).lines.every((line) => !line.includes(INV)), "a click elsewhere clears");
});

test("selection highlights the startup splash, the HUD and the prompt, and copy clears it", async () => {
  const { ui, copied } = await makeUi("en");
  ui.addSystem("Startup notice line", true);
  let lines = ui.renderFrame(140, 34).lines;
  const hero = findCell(lines, "Startup notice");
  press(ui, hero.col, hero.row);
  drag(ui, hero.col + 7, hero.row);
  lines = ui.renderFrame(140, 34).lines;
  assert.deepEqual(inverseCols(lines[hero.row]), range(hero.col, hero.col + 7), "splash selection is visible");
  release(ui, hero.col + 7, hero.row);
  assert.equal(copied.at(-1), "Startup");

  const hud = findCell(lines, "TELEMETRY");
  press(ui, hud.col, hud.row);
  drag(ui, hud.col + 9, hud.row);
  lines = ui.renderFrame(140, 34).lines;
  assert.deepEqual(inverseCols(lines[hud.row]), range(hud.col, hud.col + 9));
  release(ui, hud.col + 9, hud.row);
  assert.equal(copied.at(-1), "TELEMETRY");

  ui.handleText("analyze ığdır şifre");
  lines = ui.renderFrame(140, 34).lines;
  const prompt = findCell(lines, "ığdır");
  press(ui, prompt.col, prompt.row);
  drag(ui, prompt.col + 5, prompt.row);
  lines = ui.renderFrame(140, 34).lines;
  assert.deepEqual(inverseCols(lines[prompt.row]), range(prompt.col, prompt.col + 5));
  release(ui, prompt.col + 5, prompt.row);
  assert.equal(copied.at(-1), "ığdır");
  ui.handleKey("\x1b[99;6u"); // Ctrl+Shift+C copies and clears
  assert.equal(copied.at(-1), "ığdır");
  assert.ok(ui.renderFrame(140, 34).lines.every((line) => !line.includes(INV)));
});

test("URL detection trims prose punctuation, keeps balanced brackets and follows wrapped lines", () => {
  const urls = (text) => findLinks(text).map((link) => text.slice(link.start, link.end));
  assert.deepEqual(urls("See https://example.com/a_(b)c, then (https://x.io/y). Done."), ["https://example.com/a_(b)c", "https://x.io/y"]);
  assert.deepEqual(urls("[docs](https://ex.io/docs#Install) and <https://ex.io/q?a=1&b=2>!"), ["https://ex.io/docs#Install", "https://ex.io/q?a=1&b=2"]);
  assert.deepEqual(urls("mailto:dev@omr.io; nothttps://x.io; javascript:alert(1) file:///etc/passwd"), ["mailto:dev@omr.io"]);
  assert.deepEqual(urls("ünicode https://ex.io/çay?ş=1… │"), ["https://ex.io/çay?ş=1"]);
  assert.equal(trimUrl("https://a.io/x)."), "https://a.io/x");

  const lines = [
    `${theme.muted}· read https://example.com/very/${theme.reset}`,
    `${theme.muted}· long/path?x=1. Then more${theme.reset}`,
    "· https://short.io end",
  ];
  const width = visibleWidth(lines[0]) + 1; // a full system line: "· " + text wrapped at width - 3
  const spans = linkSpansForLines(lines, 1, 3, width);
  assert.deepEqual(spans.get(1), [{ from: 2, to: 15, url: "https://example.com/very/long/path?x=1" }]);
  assert.deepEqual(spans.get(2), [{ from: 2, to: 18, url: "https://short.io/" }]);
  assert.equal(linkSpansForLines(lines, 0, 1, width).get(0)[0].url, "https://example.com/very/long/path?x=1");
  assert.equal(linkSpansForLines(lines, 0, 1, 200).get(0)[0].url, "https://example.com/very/", "no continuation off a short line");

  const osc = osc8Spans(`☕ ${theme.amber}\x1b]8;;${SUPPORT_URL}\x07Support omr\x1b]8;;\x07${theme.reset} x`);
  assert.deepEqual(osc, [{ from: 3, to: 14, url: SUPPORT_URL, osc8: true }], "☕ is two columns wide");
});

test("only http, https and mailto URLs with a host are ever opened", () => {
  for (const ok of ["https://ex.io/a?b=c&d=$(id)", "http://127.0.0.1:8080/", "mailto:dev@omr.io"]) assert.ok(safeLinkUrl(ok), ok);
  for (const bad of [
    "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://ex.io/", "vbscript:x", "about:blank",
    "https://", "https://user:pw@ex.io/", "https://ex.io/a b", "https://ex.io/\x07", "mailto:nobody", "-https://ex.io", "x".repeat(3000),
  ]) assert.equal(safeLinkUrl(bad), null, bad);
  assert.deepEqual(openerCommand("https://ex.io/", "linux"), { command: "xdg-open", args: ["https://ex.io/"] });
  assert.deepEqual(openerCommand("https://ex.io/", "darwin"), { command: "/usr/bin/open", args: ["https://ex.io/"] });
  assert.deepEqual(openerCommand("https://ex.io/?a&b|c", "win32"), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://ex.io/?a&b|c"] });
});

test("the opener is spawned detached without a shell, and rejects disallowed schemes before spawning", async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => { child.unrefd = true; };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  assert.deepEqual(await openUrl("javascript:alert(1)", { spawnImpl: fakeSpawn }), { ok: false, reason: "invalid" });
  assert.equal(calls.length, 0);
  const result = await openUrl("https://ex.io/a;b?q=$(id)&r=`id`", { platform: "linux", spawnImpl: fakeSpawn });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "xdg-open");
  assert.equal(calls[0].args.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");

  if (process.platform === "win32") return;
  // Real spawn against a stub `xdg-open` on PATH: the URL arrives as one literal argument.
  const root = await mkdtemp(join(tmpdir(), "omr-opener-"));
  try {
    const record = join(root, "args");
    const stub = join(root, "xdg-open");
    await writeFile(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(record)}; done\n`);
    await chmod(stub, 0o755);
    const url = "https://ex.io/p;q?a=$(touch${IFS}pwned)&b=`id`|c";
    const real = await openUrl(url, { platform: "linux", env: { PATH: root } });
    assert.equal(real.ok, true);
    for (let i = 0; i < 100 && !(await readFile(record, "utf8").catch(() => "")); i += 1) await delay(20);
    assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [new URL(url).href]);
    const missing = await openUrl("https://ex.io/", { platform: "linux", env: { PATH: join(root, "none") } });
    assert.deepEqual(missing, { ok: false, reason: "failed", url: "https://ex.io/" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("links render underlined with OSC 8, and Ctrl+click (or a plain click on the support link) opens them", async () => {
  const { ui, opened } = await makeUi("en");
  ui.addUser("links?");
  ui.appendAssistant("Docs: https://github.com/voidvenom/oh-my-rea/blob/main/docs/REFERENCE.md#keeping-up-to-date-and-more (see there).");
  ui.endAssistant("Docs: https://github.com/voidvenom/oh-my-rea/blob/main/docs/REFERENCE.md#keeping-up-to-date-and-more (see there).");
  let lines = ui.renderFrame(80, 24).lines;
  const url = "https://github.com/voidvenom/oh-my-rea/blob/main/docs/REFERENCE.md#keeping-up-to-date-and-more";
  const first = findCell(lines, "https://github.com");
  assert.ok(lines[first.row].includes(`\x1b]8;;${url}\x07`), "OSC 8 is emitted");
  assert.ok(lines[first.row].includes(`${theme.underline}${theme.sky}`), "underline + link colour");
  const tail = findCell(lines, "and-more");
  assert.ok(tail.row > first.row, "the URL wraps in an 80-column terminal");

  press(ui, tail.col + 2, tail.row); release(ui, tail.col + 2, tail.row);
  assert.deepEqual(opened, [], "a plain click on a text URL does not open it");
  press(ui, tail.col + 2, tail.row, 16); release(ui, tail.col + 2, tail.row, 16);
  assert.deepEqual(opened, [url], "Ctrl+click on the wrapped part opens the whole URL");
  lines = ui.renderFrame(80, 24).lines;
  assert.match(stripAnsi(lines.at(-1)), /Opening https:\/\/github\.com/);
  assert.ok(lines.every((line) => !line.includes(INV)), "Ctrl+click does not start a selection");

  const support = findCell(lines, "buymeacoffee.com/omrdev");
  assert.ok(lines[support.row].includes(`${theme.underline}${theme.sky}buymeacoffee.com/omrdev`));
  press(ui, support.col + 3, support.row); release(ui, support.col + 3, support.row);
  assert.deepEqual(opened, [url, SUPPORT_URL]);
});
