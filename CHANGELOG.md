# Changelog

This project uses the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Fixed

- Display release notes consistently when `CHANGELOG.md` uses Windows line endings.

## [0.8.0] - 2026-11-23

### Added

- macOS and Windows support alongside Linux. It is verified with platform mocks and with Windows Node under Wine, but not yet exercised on native macOS or Windows hosts. The fixes below cover launching, storage, processes and desktop integration. See the README platform notes for terminal and provider caveats.
- An amber box in the TUI announces available updates. It shows the new version in English or Turkish with the `omr update` command highlighted.
- Ctrl+click opens links in the TUI. This covers URLs in answers, notices, drawers and the HUD (including URLs wrapped across lines), plus a plain click on the support link. Links are underlined in the link colour and still carry OSC 8 for terminals that open them natively. Only `http`, `https` and `mailto` URLs open, through `xdg-open`, `/usr/bin/open` or `rundll32 url.dll,FileProtocolHandler`, launched directly without a shell. A short status toast confirms the launch.
- Double-click selects a word and triple-click selects a line in the TUI.

### Changed

- Every interactive launch checks the registry in the background, after the first paint. The update box appears in the same session as soon as the registry answers, instead of on the next launch. A cached result shows at once and is updated in place. A minimum interval of 60 seconds between checks prevents bursts of launches from hammering the registry. The timeout is 3 seconds and failures are silent. `OMR_NO_UPDATE_CHECK=1` and CI still disable checks. The check honours `npm_config_registry`.
- A CI matrix covers Linux, macOS and Windows on the supported Node lines, including installation and smoke tests from the npm tarball. It has not run yet; it runs once the branch is pushed.

### Fixed

- In-app mouse selection is now visible. The selected cells are drawn inverted while you drag, across wrapped and multi-line selections in the transcript, the startup splash, the HUD and the prompt. Display width is respected for wide characters, combining marks and Turkish letters. The highlight stays after the automatic copy and clears on Esc, Ctrl+C / Ctrl+Shift+C, a click elsewhere, or a resize.
- Start npm-installed REA and run `omr setup` and `omr update` on Windows without passing arguments through batch shims. `omr /status` now works even when REA is missing.
- Use native macOS and Windows config and session locations while retaining existing legacy files and explicit overrides. Retry Windows file replacement when another process briefly holds a file open.
- Support Windows Python and PowerShell for `omr_run`, report available interpreters, and clean up running Windows child trees on cancellation where the host permits it.
- Fix Windows drive, UNC and file URL handling, Unicode clipboard copy, and browser discovery on macOS and Windows.

## [0.7.0] - 2026-11-23

### Added

- A support link above the TUI prompt and below the startup logo, with clickable terminal links and plain-text fallback. The link is also in CLI help and the README.
- A language switch hint on the startup screen.
- `omr changelog [version|--all]` and a paged `/changelog` view read the packaged release history.
- Interactive launches show a short release summary once per installed version. `omr update` shows it immediately when the newly installed package includes notes.
- Turkish and English terminal interfaces. Select a language with `--lang`, `OMR_LANG`, or `/lang`.
- Operator settings `OMR_SUBAGENT_MAX_STEPS` / `subagent_max_steps` and `OMR_SUBAGENT_CONCURRENCY` / `subagent_concurrency` control subagent turns and worker slots. The default is unlimited steps and four slots.

### Changed

- `/lang en` and `/lang tr` switch immediately and save the selection. Startup overrides through `--lang` and `OMR_LANG` apply to the current launch.
- Update notices show installed and available versions. They point to `/changelog` and `omr update`. The first launch with an empty cache primes it in the background, and the next launch can show the result.
- npm packages include this changelog. The maintainer script requires a section for the version being released, and the GitHub Release uses that section as its notes.
- `omr_run` wait windows return partial output and a `run_id` while the script continues. The operator's `OMR_RUN_MAX_TIMEOUT_SEC` still stops an overlong script and returns its captured output.
- The status line and HUD track concurrent subagents. `omr_task` encourages background fan-out and later collection. Expiring wait windows return control to the parent while workers continue.

### Removed

- Model-selected `omr_task.max_steps`, Forge manifest timeouts, and recipe analysis time and heap overrides. Operators control these limits.

### Fixed

- The original startup logo stays visible alongside startup notices until the transcript starts.
- A cooked Enter that reaches the TUI in its first input chunk submits a typed-ahead command.

## [0.6.0] - 2026-11-23

### Added

- A real-PTY startup benchmark measures first paint, early input, cold model-limit lookup and the transcript preview and completion for a large `--resume`.

### Changed

- Turns and subagents run without a step cap by default. Set `OMR_MAX_STEPS` (or config `max_steps`) to opt in. Old persisted `max_steps: 40` values are ignored because they were previously written by default. Set `OMR_MAX_STEPS=40` to request that exact cap.
- Set `OMR_AUTO_EXTEND_STEPS` (or config `auto_extend_steps`) alongside a step cap to grant up to 10 extra blocks while tools keep succeeding. A successful tool call can extend a capped turn even when it produces no new Evidence. Exhausting the cap reports `step_budget`.
- The TUI paints and accepts input before REA connects or model-limit lookups complete. `--resume` displays a saved transcript preview before restoring the continuation and skips the throwaway REA connection. Session lookup reads only the index entries needed by the query. Histories over 4 MiB restore a bounded recent projection and retain the full source history on disk.
- Measured locally with Node 24.22.1 and the same warm-filesystem PTY harness (p50 in ms, 5 samples on 0.5.1 and 10 on 0.6.0): first paint 574 → 96, first paint with an unanswered model-limit request 5,415 → 92, resume transcript 3,187 → 110, resume completion 3,187 → 2,436. Timing depends on hardware, the session, and the REA installation.
- MCP output schemas compile on first validation per tool, removing the upfront compile of the whole catalog. A failed schema compile stays isolated to that tool.
- Setup, update checks and MCP use the same launcher order: `OMR_REA_COMMAND`, a REA checkout (including a sibling `rea/scripts/rea.mjs`), then `PATH`. Only the active `PATH` install is checked for REA registry updates.
- Thinking effort selected in the TUI or with `/effort` is remembered. `OMR_EFFORT` still takes precedence.
- Provider retries default to 12 per request (`OMR_MAX_RETRIES`), with jittered backoff for 429s, 5xxs, provider errors, dropped connections and stalls. Only model progress resets the stream idle timer (`OMR_TIMEOUT_MS`, 600,000 ms by default, `0` disables). REA tool inactivity defaults to 300,000 ms (`OMR_TOOL_TIMEOUT_MS`), with progress resetting the timer.

### Removed

- Removed the default turn cap and automatic extra step blocks, the default ceiling on explicitly requested `omr_run` timeouts, and the default maximum wait during a network outage. Configure `OMR_RUN_MAX_TIMEOUT_SEC` or `OMR_NET_WAIT_MS` for those limits. A script with no requested timeout still defaults to 30 seconds.
- Removed two blocking `rea --version` probes from normal startup. REA detection resolves the launcher, and a background cache refresh records versions for installed REA binaries.

### Fixed

- A turn can compact repeatedly as its context fills. If summarization and tool-output stubbing cannot free enough space, it drops old complete tool exchanges while retaining Evidence and Unknowns in the session ledger. Loop tracking has bounded memory and warns about repeated calls while allowing them to run.
- Failed, timed-out and uncertain tool calls become error results the model can handle. Cancellation settles even when a tool ignores its abort signal. REA reconnects before the next model step after a disconnect, and uncertain side effects remain in the execution journal for reconciliation.
- Empty `tool_calls` finishes and `max_tokens` cuts get a bounded recovery attempt. A plain-text response without a finish reason can complete the turn. The TUI shows the reason when a turn ends early.
- Captured startup keystrokes are replayed into the TUI. A single cooked Enter on a typed-ahead line is treated as a submit.
- Unit tests use an isolated home, XDG paths and environment, mock public model catalogs, and exercise sibling REA launchers and Unicode paths.

## [0.5.1] - 2026-11-16

### Added

- Added a maintainer release script for checks, manual npm publishing and tagging, and a test that checks workflow command documentation against the reference.

### Changed

- Reworked the README and moved the detailed configuration and command reference into `docs/REFERENCE.md`.
- The tag workflow creates GitHub Releases. npm publishing remains a maintainer action.

### Fixed

- Corrected the MIT license copyright holder.

## [0.5.0] - 2026-11-16

### Added

- First repository release of the omr terminal UI and CLI, with REA MCP integration, an Evidence and Unknowns ledger, and a session journal.
- Added a multi-provider streaming model client, model and reasoning pickers, guided investigation workflows, subagents, compaction, and crash-safe session resume.
- Included deterministic commands, report export, JSONL events, a JavaScript SDK, and first-run REA setup and update commands.
