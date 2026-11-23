import assert from "node:assert/strict";
import { test } from "node:test";
import { createTheme, stripAnsi, truncateAnsi, visibleWidth } from "../dist/ansi.js";
import { I18n } from "../dist/i18n/index.js";
import { renderSupportLine, SUPPORT_URL } from "../dist/support.js";
import { TerminalUi } from "../dist/tui.js";

const theme = createTheme({ TERM: "xterm-256color", COLORTERM: "truecolor" });

test("support text fits the terminal with or without a hyperlink", async () => {
  const i18n = new I18n();
  await i18n.switchTo("tr");
  const linked = renderSupportLine(80, i18n, theme, true);
  assert.ok(linked.includes(theme.amber));
  assert.ok(linked.includes(`\x1b]8;;${SUPPORT_URL}\x07`));
  assert.equal(stripAnsi(linked), "☕ omr’ı destekle: buymeacoffee.com/omrdev");
  assert.equal(visibleWidth(linked), visibleWidth(stripAnsi(linked)));
  const plain = renderSupportLine(24, i18n, theme, false);
  assert.equal(stripAnsi(plain), "buymeacoffee.com/omrdev");
  assert.ok(!plain.includes("\x1b]8;"));
  const clipped = truncateAnsi(linked, 12);
  assert.ok(clipped.includes("\x1b]8;;\x07"), "clipping must close the link");
  assert.ok(visibleWidth(clipped) <= 12);
});

test("startup notices leave the splash visible, and the support row stays above the composer", async () => {
  for (const [locale, prompt, hint] of [
    ["en", "prompt", "Language: English · Türkçe için /lang tr"],
    ["tr", "istem", "Dil: Türkçe · For English: /lang en"],
  ]) {
    const i18n = new I18n();
    await i18n.switchTo(locale);
    const ui = new TerminalUi({ i18n, theme, commands: [], onSubmit() {}, onInterrupt() {}, onExit() {} });
    ui.addSystem("Startup notice", true);
    for (const width of [80, 120]) {
      const frame = ui.renderFrame(width, 24);
      const lines = frame.lines.map(stripAnsi);
      assert.ok(lines.some((line) => line.includes("██████")));
      assert.ok(lines.some((line) => line.includes(hint)));
      assert.ok(lines.some((line) => line.includes("Startup notice")));
      const composer = lines.findIndex((line) => line.startsWith(`╭─ ${prompt} `));
      assert.ok(composer > 0);
      assert.ok(lines[composer - 1].includes("buymeacoffee.com/omrdev"));
      assert.equal(frame.cursor.row, composer + 2);
      assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
    }
    const tiny = ui.renderFrame(24, 8);
    const tinyScreen = tiny.lines.map(stripAnsi).join("\n");
    assert.match(tinyScreen, /\/lang en · \/lang tr/);
    assert.doesNotMatch(tinyScreen, /██████|╔═╗╔╦╗/);
    assert.ok(tiny.lines.every((line) => visibleWidth(line) <= 24));
    ui.addUser("Hello omr");
    const transcript = ui.renderFrame(80, 24).lines.map(stripAnsi);
    assert.ok(transcript.some((line) => line.includes("Hello omr")));
    assert.ok(!transcript.some((line) => line.includes("██████")));
    const composer = transcript.findIndex((line) => line.startsWith(`╭─ ${prompt} `));
    assert.ok(transcript[composer - 1].includes("buymeacoffee.com/omrdev"));
  }
});
