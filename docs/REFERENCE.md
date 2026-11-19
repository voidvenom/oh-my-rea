# omr reference

Detailed reference for omr: configuration, commands, tools, session layout, SDK and measurement. For installation and a quick tour, see the [README](../README.md).

> Some sections below are still written in Turkish and will be translated.

## Model configuration

Write `~/.config/rea/omr-model.json`:

```json
{
  "base_url": "https://your-endpoint/v1",
  "model": "your-model-id",
  "api_key_env": "YOUR_API_KEY_ENV",
  "max_tokens": 8192,
  "max_steps": 40
}
```

- `api_key_env` names the exported environment variable holding the key; `api_key` is also accepted.
- Zero-config startup works automatically whenever any supported provider key is exported in your shell.
- Optional `"providers"` map in `omr-model.json` lets you define multiple custom/self-hosted provider profiles alongside the 33 built-in providers.
- Environment overrides: `OMR_PROVIDER`, `OMR_PROTOCOL`, `OMR_BASE_URL`, `OMR_MODEL`, `OMR_FALLBACK_MODELS` (comma-separated `provider:model` failover chain), `OMR_BUDGET_TOKENS` (cumulative session token cap), `OMR_EFFORT` (`auto` · `off` · `minimal` · `low` · `medium` · `high` · `xhigh`), `OMR_API_KEY`, `OMR_API_KEY_ENV`, `OMR_MAX_TOKENS`, `OMR_MAX_STEPS`, `OMR_AUTO_EXTEND_STEPS` (default `2`: extra step blocks granted while tool calls keep succeeding; `0` disables), `OMR_TEMPERATURE`, `OMR_TIMEOUT_MS`, `OMR_PING_INTERVAL_MS` / `OMR_NET_WAIT_MS` (Network Guard probe interval and maximum hold, honoring `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` & `NO_PROXY`).
- **Crash safety**: the conversation is checkpointed after every completed step. `omr --resume` (or `--resume=<id>`, or `/resume`) restores the last session and, if it ended mid-turn (crash, kill, power loss), continues that turn automatically — no manual `continue` needed.
- `XDG_CONFIG_HOME` relocates the config directory.
- `/model`, `/effort`, `/providers`, `/failover`, `/budget`, `/net`, and `/doctor` inspect resolved endpoints, models, failover chains, token budgets, proxy-aware Net Guard probes, thinking budgets, and key sources (never printing secret values). Pressing `Alt+S` / `Ctrl+S` in the Model Picker (or `/model --save <provider:model>`, `/effort --save <level>`, `/failover --save <chain>`, `/budget --save <tokens>`) saves the default additively to `omr-model.json` with an automatic `.bak` backup.

## Usage

```bash
omr                                      # interactive TUI in cwd (auto-detects single target)
omr target.apk                           # bind target, launch TUI
omr target.apk "find the license gate"   # one-shot bounded investigation
omr /status                              # one-shot deterministic command
omr --plain target.apk                   # line REPL mode (no alternate screen)
omr --json /status                       # versioned JSONL events (omr-events/v1)
omr --no-model                           # deterministic commands only
omr --model <id>                         # override configured model id
omr --profile <name>                     # pre-warm cyber/RE profile (recon|malware|vuln|crypto|frida|android|firmware|web)
omr --resume                             # restore the last session; continue an interrupted turn automatically
omr --dashboard target.apk               # serve live session dashboard on 127.0.0.1
```

In the TUI:

- **Continuous Live Bitstream**: Opens immediately (< 50 ms first paint) with the `OMR` emblem, continuously flowing binary wings, top-bar 8-bit pulse, and a real-byte hex/bit disassembler strip inspecting the active artifact's magic header (`ELF`, `APK`, `PE`, `Mach-O`, `DEX`, `WASM`, `PCAP`, `SQLite`). Default `on` mode streams continuously even while idle (backed by cached timeline lines & differential ANSI frames); cycle modes (`on` · `eco` · `busy` · `off`) with `Ctrl+B` or `/binary`.
- **Interactive Model, Provider & Thinking Effort Selector** (`Alt+M`, `F2`, `Alt+E`, `/model`, `/effort`, `/providers`): Full two-pane matrix browsing all 33+ built-in, local, and custom providers, live `/models` discovery (`Alt+R` / `Ctrl+R`), instant fuzzy filtering, and arbitrary custom model ID entry. Selecting a model smoothly opens a Step-2 **Thinking / Reasoning Effort** bar (`auto` · `off` · `minimal` · `low` · `medium` · `high` · `xhigh`) mapped to Anthropic `thinking.budget_tokens` and OpenAI/OpenRouter `reasoning_effort`, with default config persistence (`Alt+S` / `Ctrl+S`).
- **Unified Investigation Timeline**: User prompts, live model reasoning (`◈ thinking`), connected inline tool-call trees (`╭─ / ├─ / ╰─` with durations & `⟦ev_…⟧` chips), and syntax-highlighted Markdown reports render in chronological order on all terminal widths.
- **Disassembler HUD** (`≥116` columns): Continuous binary/hex oscilloscope, target magic & size, bound deep provider, active LLM provider & model, Evidence/Unknown/Journal/Token telemetry, and recent tool call trace.
- **Inspector & Output Drawer**: Local command outputs open in a dismissible drawer (`Esc` closes; `Ctrl+O` expands to a full-screen top-aligned viewer with `↑/↓`, `j/k`, `PgUp/PgDn`, `g/G`).
- **Multi-line Composer, Ghost Hints, `@` Mentions & Fuzzy Palette**: Auto-grows up to 6 lines (`Shift+Enter` / `Alt+Enter` / `Ctrl+J` for newline). Typing `/` or pressing `Ctrl+K` opens the fuzzy command palette with inline ghost autocomplete (`Tab` or `→` accepts), shortcut pills, sub-argument completion (`/binary `, `/model `, `/providers `, `/image `, `/screenshot `), and path completion (`/open`, `/export`, `/compare`, `/image`). Typing `@` opens the workspace file & image mention popup (`@screenshot.png` attaches the image to the vision turn; `@src/main.c:10-40` injects the sliced file into `<file>` context).
- **Vision, Image Attachments & Multi-Source Screenshots** (`/image`, `/screenshot`, `Ctrl+V`, `Alt+S`): Paste clipboard images (`Ctrl+V`), drag-and-drop image paths, mention `@image.png`, or run `/image <path|url|clipboard|list|clear> [prompt]` and `/screenshot [desktop|region|window|adb|browser|binary] [prompt]` (`Alt+S` quick capture). Renders 24-bit ANSI half-block (`▀`) terminal image previews, clickable OSC 8 `file://` links, and a `640×360` 2D RGB Byte-Class & Shannon Entropy Heatmap (`binary` mode) for visual binary forensics. Non-vision models automatically receive a deterministic forensic visual summary (dimensions, SHA-256, byte entropy, 6×4 RGB color grid, and ASCII strings).
- **Safe Cancellation**: `Esc` or `Ctrl+C` aborts an active model/tool turn immediately (propagating cancellation to REA and keeping chat history valid); when idle, `Ctrl+C` twice or `Ctrl+D` exits cleanly.

## Commands

| Command                                                                                                            | Kind     | Purpose                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `/open <path>`                                                                                                     | local    | open and bind a target artifact                                                                          |
| `/triage [focus]`                                                                                                  | prompt   | rapid format, security, entrypoint & route reconnaissance                                                |
| `/investigate [goal]`                                                                                              | workflow | bounded Evidence-backed investigation                                                                    |
| `/explain <symbol\|addr>`                                                                                          | prompt   | decompile & explain a function, class, or address with citations                                         |
| `/trace <symbol\|feature>`                                                                                         | workflow | trace callers, callees & cross-references                                                                |
| `/crash <symptom>`                                                                                                 | workflow | correlate crash signal/address/stack symptom with static paths                                           |
| `/audit [scope]`                                                                                                   | workflow | audit open residual unknowns against retained Evidence                                                   |
| `/compare <left> <right>`                                                                                          | workflow | compare two application versions via inventory & dossiers                                                |
| `/find <query>`                                                                                                    | local    | zero-token search (APK classes, binary strings & procedures)                                             |
| `/status`                                                                                                          | local    | target, providers, Evidence/Unknown counts, tokens & journal                                             |
| `/evidence [ev_id]`                                                                                                | local    | retained Evidence summary or single record (supports unambiguous prefix)                                 |
| `/unknowns`                                                                                                        | local    | residual Unknown ledger                                                                                  |
| `/report [view\|export [path]\|json [path]]`                                                                       | local    | view or export cumulative forensic session report (standalone Markdown or JSON dossier)                  |
| `/export [path]`                                                                                                   | local    | export canonical Evidence bundle JSON                                                                    |
| `/journal`                                                                                                         | local    | formatted tail of `journal.jsonl`                                                                        |
| `/doctor`                                                                                                          | local    | REA providers, MCP catalog size, env sources & model config                                              |
| `/model [--save] [provider:]model`                                                                                 | local    | open interactive Model & Provider Matrix (`Alt+M`) or switch active model                                |
| `/effort [--save] [level]`                                                                                         | local    | open interactive Thinking Effort bar (`Alt+E`) or set `auto\|off\|minimal\|low\|medium\|high\|xhigh`     |
| `/providers [id]`                                                                                                  | local    | browse all 33+ cloud, router, local & custom LLM providers                                               |
| `/failover [provider:model,...\|off] [--save]`                                                                     | local    | configure or inspect automatic multi-provider failover chain (`OMR_FALLBACK_MODELS`)                     |
| `/budget [<tokens>\|off] [--save]`                                                                                 | local    | inspect session token/cost usage or set a maximum token budget cap (`OMR_BUDGET_TOKENS`)                 |
| `/net [status\|probe\|interval <ms>\|wait <ms>]`                                                                   | local    | inspect Net Guard status, proxy routing, or run live latency probes (`/net-guard`, `/ping`)              |
| `/compact`                                                                                                         | local    | compact older tool outputs into Evidence-preserving stubs                                                |
| `/binary [on\|eco\|busy\|off]`                                                                                     | local    | toggle continuous binary bitstream & HUD mode (`Ctrl+B`)                                                 |
| `/dashboard`                                                                                                       | local    | serve the live loopback session dashboard                                                                |
| `/clear`                                                                                                           | local    | clear conversation history and return to hero view                                                       |
| `/close`                                                                                                           | local    | close the active target                                                                                  |
| `/frida <goal>`                                                                                                    | workflow | Synthesize Evidence-pinned Frida (.js) instrumentation hooks & optionally attach live                    |
| `/crypto [focus]`                                                                                                  | workflow | Locate cipher constants, S-boxes, KDFs & entropy regions and synthesize a standalone Python decryptor    |
| `/protocol [focus]`                                                                                                | workflow | Reconstruct wire/IPC packet framing & state machines and generate a Python protocol client/decoder       |
| `/unpack [focus]`                                                                                                  | workflow | Identify packers/containers (PyInstaller, Bun, ASAR, UPX, Firmware, IL2CPP, Flutter) & map payloads      |
| `/surface [focus]`                                                                                                 | workflow | Map binary hardening (PIE, NX, Canary, RELRO, signatures), external entrypoints & sensitive sinks        |
| `/ioc [focus]`                                                                                                     | workflow | Extract Evidence-pinned IOCs, C2/mutex/byte indicators & synthesize a production YARA rule               |
| `/diff-cve <left> <right> [focus]`                                                                                 | workflow | Diff two binary/package versions to pinpoint security patches, added bounds checks & root causes         |
| `/sandbox [focus]`                                                                                                 | workflow | Capture & correlate runtime process behavior, native API calls, child processes & network activity       |
| `/deobfuscate [focus]`                                                                                             | workflow | Decode encrypted/stack string tables, dynamic API hash resolution & obfuscated control flow              |
| `/sbom [focus]`                                                                                                    | workflow | Inventory linked & statically embedded libraries, compiler/runtime versions, certs & crypto modules      |
| `/capa [focus]`                                                                                                    | workflow | Map binary capabilities to MITRE ATT&CK techniques, Malware Behavior Catalog (MBC) & capa rule YAML      |
| `/firmware [focus]`                                                                                                | workflow | Audit firmware/IoT image partitions, DeviceTree/U-Boot, embedded filesystems, NVRAM & daemon sinks       |
| `/masvs [focus]`                                                                                                   | workflow | Mobile security audit (OWASP MASVS / MASTG) for Android APK & iOS IPA: manifest, IPC, pinning & JNI      |
| `/forge [list\|install <preset\|all>\|command <name> <goal>\|<goal>]`                                              | workflow | Automated cyber/RE tool & slash-command synthesizer (`/toolgen`, `/craft`, `/maketool`)                  |
| `/browser [status\|camofox\|chromium\|firefox\|zen\|tor\|proxy <url>\|tabs\|close\|<url\|goal>]`                   | local    | Multi-browser & stealth hub: Camoufox (anti-CAPTCHA/Cloudflare), Chromium, Firefox, Zen, Proxy & Tor     |
| `/script <frida\|python\|gdb\|rizin\|yara> <goal>`                                                                 | workflow | Synthesize an Evidence-pinned RE script/bot (frida\|python\|gdb\|rizin\|yara) and auto-save to session   |
| `/adb [devices\|packages\|pull <pkg>\|logcat\|<goal>]`                                                             | local    | Android ADB hub: devices, packages, pull <pkg>, logcat, or guided live Android workflow                  |
| `/image [<path\|url\|clipboard\|list\|clear> [prompt...]]`                                                         | local    | Attach local/URL/clipboard images (`Ctrl+V` or `@file.png`), preview in terminal, or run a vision prompt (`/img`, `/attach`) |
| `/screenshot [desktop\|region\|window\|adb\|browser\|binary [path\|url]] [prompt...]`                              | local    | Capture a screenshot (desktop, region, window, Android ADB, browser, or 2D binary entropy heatmap) (`Alt+S`, `/shot`, `/ss`, `/vision`) |
| `/spawn [--bg] [workflow] <goal>`                                                                                  | workflow | Launch an isolated subagent (`omr_task`) synchronously or in the background (`--bg`)                     |
| `/subagents [graph\|inspect <id>\|wait <id\|all>\|cancel <id>]`                                                    | local    | Live Subagent Mesh DAG, real-time step-by-step trace, wait or cancel (`/graph`, `/mesh`)                 |
| `/steer <agent_id> <directive>`                                                                                    | local    | Course-correct a running (mid-flight) or completed (post-turn) subagent (`/intervene`)                   |
| `/profile [recon\|malware\|vuln\|crypto\|frida\|android\|firmware\|web\|off]`                                      | local    | Activate a cyber/RE operational profile (sticky tools, thinking effort & system lens)                    |
| `/save [filename \| --as-command <name>]`                                                                          | local    | Save the latest generated script/bot block to `<session>/scripts/` or export the last prompt as `.omr/commands/<name>.md` |
| `/commands [reload]`                                                                                               | local    | List or reload user/project markdown slash commands (`.omr/commands/*.md` & `~/.config/rea/omr/commands/*.md`) |
| `/jb [directive\|show\|clear]`                                                                                     | local    | Set, view, or clear a quick operator directive (saved in AGENTS.md's omr block & the active prompt)      |
| `/agents.md [path\|show\|reload\|on\|off]`                                                                         | local    | Load the project's AGENTS.md (or another instruction file as the default /jb) into the agent             |
| `/resume [session_id\|last]`                                                                                       | local    | List saved OMR sessions or restore conversation history & target from a previous session                 |
| `/rewind [turns]`                                                                                                  | local    | Roll back the last `N` conversation turns (`/undo`) while keeping `tool_call_id` pairing valid           |
| `/fork [label]`                                                                                                    | local    | Branch the current session into a new session directory on disk (`/branch`)                              |
| `/tools [query]`                                                                                                   | local    | Search REA's MCP tool catalog directly without invoking the model                                        |
| `/call <tool> [json]`                                                                                              | local    | Deterministically invoke any REA MCP tool with optional JSON arguments                                   |
| `/guide [topic]`                                                                                                   | local    | Read REA skill reference guides on demand                                                                |
| `/prompts [name]`                                                                                                  | local    | List or inspect REA's built-in MCP prompts                                                               |
| `!<cmd>`, `!!<cmd>`, `!!`, `!!clear`                                                                               | shell    | Run a zero-token local shell command (`!<cmd>`) or stage its output into the next agent turn (`!!<cmd>`) |
| `/compaction [soft\|remote\|snapcompact\|handoff\|shake\|off] [model=id\|active] [75%\|auto] [window=1m] [--save]` | local    | Configure compaction mode (soft\|remote\|snapcompact\|handoff\|shake\|off), compaction AI model & window |
| `/context`                                                                                                         | local    | Show context window usage, threshold and compaction mode                                                 |
| `/exit`                                                                                                            | local    | Flush session state and exit omr                                                                         |
| `/help`, `/exit`                                                                                                   | local    | help & clean shutdown (`/quit`, `/q`, `/?`)                                                              |

`/state [get|update <revision> <patch-json>]` reads or updates persistent task facts
without starting a model or REA. Updates replace the specified fields and require
the current revision to prevent lost updates. `omr_state` provides the same surface
to the primary agent; workers can read it. Goals, constraints, decisions, acceptance
claims, active work and artifact references survive compaction and rewind. Forks
copy the state, then evolve independently. Artifact paths retain their source session
identity; a copied reference does not claim that the artifact was recreated or verified.
An acceptance status of `claimed` is not proof of completion.

## Tools & Context Efficiency

Exposing all ~246 REA schemas per step would cost ~271 KB of context, so `omr` selects route-appropriate tools dynamically for the active target format (`ELF`/`PE`/`Mach-O`/`APK`/JS/PCAP, plus sticky session-promoted tools) with compacted JSON Schemas (~14–25 KB per step) alongside two meta tools:

- `rea_tools { query }` — search the full REA catalog by keyword.
- `rea_tools { schema: "inspect_sqlite_database" }` — fetch a tool's full verbatim JSON input schema.
- `rea_call { name, arguments }` — invoke any catalog tool.
- `rea_guide { topic }` — read REA's own skill sections and reference guides on demand (`OMR_REA_SKILL_DIR` overrides the lookup).
- `rea_prompt { name, arguments }` — fetch REA's guided MCP workflows (`investigate_feature`, `trace_crash`, …) as step lists.
- `omr_workflow { workflow, focus }` — load any of the 24 omr workflow playbooks (the same ones behind the slash commands) mid-turn, without the operator typing a command.
- `omr_task { action?, mode?, agent_id?, role?, goal?, prompt?, workflow?, depends_on?, max_steps?, timeout_s? }` — Stateful, Steerable, Observable Subagent Mesh & DAG orchestrator (`spawn` | `status`/`graph` | `inspect` | `steer` | `wait` | `cancel`):
  - **Parallel & Background (`mode: "background" | "wait"`)**: Launch specialist subagents in the background (`mode: "background"`) while continuing your own investigation, or run blocking (`mode: "wait"`). Completed background subagents automatically inject notifications on the next turn.
  - **DAG Dependencies (`depends_on: ["sub-1"]`)**: Chain downstream subagents on upstream subagent IDs; downstream nodes automatically receive upstream findings and `ev_<64-hex>` IDs.
  - **Step-by-Step Inspection & Graph (`action: "inspect" | "graph"`)**: Inspect any subagent's live step telemetry (`thinking`, `tool_exec`, `steered`, `done`), tool call arguments, duration, and Evidence IDs, or render the full Subagent Mesh DAG (`/subagents`, `/graph`, `/mesh`, and the live `/dashboard`).
  - **Supervisor Course-Correction (`action: "steer"` / `/steer <id> <directive>`)**: Inject corrective instructions mid-flight into a running subagent (at the next clean step boundary) or resume a completed subagent's stateful conversation history to fix a flawed assumption.
- `omr_run { script, code?, args?, stdin?, timeout_s?, network? }` — write and run a script from the session `scripts/` directory (`.py`, `.sh`, `.mjs`/`.cjs`, `.yar`/`.yara`) and get its real stdout, stderr and exit code, so a decryptor, parser or rule is tested before it is reported as working. The child gets a scrubbed environment (no provider keys), a timeout (default 30 s, max 300 s), bounded output and, by default, an empty network namespace (`unshare -rn`; reported as `NOT isolated` when the host cannot provide one). `network: true` opts into the host network. It never executes the target binary. Each run writes `scripts/.runs/<script>.<time>.json` with the script SHA-256, exit code and output preview.
- `omr_view_image { path, focus? }` — autonomously load a local image file (`.png`, `.jpg`, `.webp`, `.gif`, `.bmp`), remote `http(s)://` image URL, or `data:image/` URI into the vision context with forensic metadata (SHA-256, dimensions, entropy, strings).
- `omr_screenshot { source?, target?, focus? }` — autonomously capture and inspect a screenshot (`binary` 2D RGB byte-class & entropy heatmap, `adb` Android screen, `browser` page, `desktop`, `region`, or `window`) and attach the image to the next model step.

Tool outputs are capped at 80,000 characters, and multi-turn histories automatically compact older oversized tool outputs into Evidence-preserving stubs (keeping all `ev_…` and `unk_…` identifiers intact while full records remain accessible via `get_evidence_bundle` and `export_evidence_bundle`).

MCP `list_changed` notifications invalidate schemas and read-only hints immediately.
One refresh replaces the complete paginated catalog atomically. A failed refresh
blocks stale definitions; `/tools reload` retries it. Broker schema caches follow
catalog revisions. A catalog change while the model is responding causes its old
tool calls to return a retry message before dispatch. Native calls recheck the
revision after waiting for the target lease as well.

Built-in browser/meta names identify their OMR implementation consistently in search,
schemas and dispatch. A colliding REA tool remains available under `rea__<name>`
(or a shortened hash alias for long/colliding names); search with `rea_tools` to get
the exact exposed name. Local generated-tool collisions fail explicitly.

## Verified Forge tools

Generated scripts and Markdown slash commands remain available through `/forge <goal>`
and `/forge command`. A reusable function tool has a separate, explicit lifecycle:

1. Create source that reads one JSON object from stdin, writes one JSON value to stdout,
   and sends diagnostics to stderr. Supported interpreters are `node` (`.mjs`),
   `python3` (`.py`) and `bash` (`.sh`).
2. `/forge register <spec.json> <source>` records immutable `id`, numeric `major.minor.patch`
   version, description, interpreter, dependency version probes, input/output schemas,
   semantic fixtures, timeout and network preference. It does not activate the tool.
3. `/forge verify <id> <version>` executes every fixture and compares the parsed output
   with its exact expected JSON. Exit 0, valid JSON and the output schema must all pass.
4. `/forge activate <id> <version>` exposes `forge_<id>_v<major>_<minor>_<patch>` to the
   agent. `/forge run <id> <input-json>` runs it locally. Activating another version
   removes the previous function name, so stale calls cannot execute replacement code.

`/forge registry [id]` shows manifests, hashes, fixtures and proof references.
`/forge deactivate <id>` hides the tool; `/forge remove <id> [version]` retires versions
while retaining their historical files. Source edits require a new version. Source
hash or dependency-version drift prevents execution until a fresh proof is available.
Reverification deactivates the version first and never activates it implicitly.
The agent can perform this lifecycle with `omr_forge`; workers can inspect the registry.

Example spec for a script that returns `{ "decoded": "hi" }` for hex `6869`:

```json
{
  "id": "hex_decoder", "version": "1.0.0", "description": "Decode hex as UTF-8",
  "interpreter": "node", "dependencies": [],
  "inputSchema": { "type": "object", "properties": { "hex": { "type": "string" } }, "required": ["hex"], "additionalProperties": false },
  "outputSchema": { "type": "object", "properties": { "decoded": { "type": "string" } }, "required": ["decoded"], "additionalProperties": false },
  "fixtures": [{ "id": "hello", "input": { "hex": "6869" }, "expected": { "decoded": "hi" } }],
  "timeoutSec": 30, "network": false
}
```

Forge uses an explicit schema subset: one `type`, `properties`, `required`, boolean
`additionalProperties`, `items`, `enum`, `const`, length/item/numeric bounds, and
`description`/`title`. Unsupported keywords fail registration. Dependencies are
probed, never installed. Fixtures establish behavior for those inputs, not general
correctness or code isolation. The existing script runner bounds time/output and
scrubs credentials; network isolation availability is reported per run. Filesystem
access is not sandboxed. A Forge proof is distinct from authenticated REA Evidence.

## Replayable analysis recipes

`/recipe list` shows versioned recipes and recent runs. `/recipe run javascript
{"input_path":"/absolute/application"}` retains static analysis and coverage.
`/recipe run browser-javascript {"cdp_endpoint":"http://127.0.0.1:9222","target_id":"<discovered-id>","min_network_requests":1}`
records passive DOM/network Evidence, a digest-verified viewport screenshot,
already-captured script exports and static JavaScript Evidence in one episode.
Discover an exact page with `list_browser_targets` first. The endpoint can default
to the currently owned local browser; a historical endpoint is never reused implicitly.

Every run records the recipe/version/implementation hash, target binding, input,
native steps, active-ledger Evidence checks, artifact hashes and explicit exit conditions.
`/recipe inspect <run-id>` reads the full receipt. The model uses `omr_recipe`.
Replaying creates a fresh run directory. Uncertain side effects stop automatic work;
failed steps are not silently retried. A failed exit condition preserves a partial
receipt and returns the partial CLI outcome.

`completed` describes the declared pipeline conditions. Browser observation starts
at attachment and has explicit policy/coverage bounds; script capture does not prove
execution. Static syntax coverage and semantic Unknowns remain separate in the receipt.
The existing workflow playbooks remain available through their slash commands.

For a controlled integration check, build and run
`node test/live-browser-episode.mjs [--report <path>]`. It requires installed Chromium
and the configured/local REA launcher, uses a disposable localhost application,
requires no model credentials, and closes its owned processes and files.

## Coverage and measured progress

`/coverage [item-id] [offset=N] [limit=N]` and `omr_coverage` distinguish inspected
references, verified declared criteria, blocked work, native residual Unknowns and
provider coverage gaps. A claimed acceptance entry with a valid citation remains
`inspected` until its explicit machine criterion passes. Optional entry `verification`
uses one of:

- `evidence-equals`: exact retained Evidence `ref`, a JSON `pointer` into that record,
  and the expected JSON `equals` value. Missing and null differ.
- `forge-fixtures`: the exact passing Forge proof `ref`; source/environment drift or
  retirement invalidates it.
- `recipe-exit`: `ref: "recipe:<run-id>"`; recipe implementation, exit conditions,
  artifact hashes and active-ledger Evidence must still match.
- `unknown-resolution`: the exact native Unknown `ref`; withdrawn and out-of-scope
  dispositions are not truth-verified resolutions.

`acceptance_conditions_met` refers to those declared predicates. Prose interpretation
and unobserved behavior remain outside that assessment. Paged or stale task revisions
are explicit. Unavailable Unknown counts remain unknown rather than becoming zero;
provider semantic gaps are shown separately from the durable Unknown registry.

### Telemetry ve otonom inceleme

HUD ve alt durum çubuğundaki `ev`, aktif REA backend'inin tuttuğu gerçek Evidence
toplamıdır. `unk`, henüz `resolved` olmayan Unknown başlıklarını sayar; toplam ve
resolved ayrıca gösterilir. Geçmiş journal, checkpoint veya bir yanıtta alıntılanan
ID bu sayaçları artırmaz. `?` okunamayan/bilinmeyen, `~` eski veya tahmini değerdir.
`journal #N events`, REA olay sayısıdır: yalnız `session.start` bile `#1` yapabilir.
Model token kullanımı ayrı gösterilir; context tahmini `~`, doğrulanmış model
penceresi bulunamadığında kullanılan muhafazakâr sınır `safe` etiketi taşır.

`target` seçili dosya/dizindir; native engine binding ve son analiz kapsamı ayrı
izlenir. JavaScript, Android ve browser incelemesi native binary açmadan yapılabilir.
Doğal görev geldiğinde runtime çalışma dizinindeki sınırlı aday listesini ve görevde
geçen mevcut yolları keşfeder. Model, amaca uygun hedefi ve native aracı seçer;
`/open` veya `/unknowns` yazmak gerekmez. Birden çok adayda görevle desteklenmeyen
dosya keyfi seçilmez. Keşif sınırlıysa ajan `omr_investigation targets` ve mevcut
araçlarla devam edebilir.

Her model adımından önce güncel ledger, hedef, TaskState ve browser durumu verilir.
Native Evidence içindeki sorular ayrı bir inceleme kutusunda tutulur. Ajan material
açık soruyu `omr_investigation record_gap` ile gerçek native Unknown'a dönüştürür;
önce kaynak Evidence'ın aktif backend'de tutulduğu doğrulanır. Mevcut native
`record_unknown`/`update_unknown`/`verify_unknown_resolution` araçları da kullanılabilir.
İlgisiz veya şu an doğrulanamayan boşluk için gerekçeli `review_gap` kararı verebilir;
bu karar doğru cevap kanıtı değildir. Genel provider sınırlamaları otomatik olarak
Unknown sayılmaz. Açık bir provider sorusu kararsız bırakılırsa runtime iki sınırlı
yeniden değerlendirme ister; görmezden gelinirse sonuç `partial` olur.

Kararlar fork/resume ile taşınır; eski Unknown ID'si yeni backend'de doğrulanmadan
aktif kayıt sayılmaz. Metadata okumaları ortak, kısa ömürlü cache kullanır; boşta
sürekli sorgu veya yalnız sayaç artırmak için analiz yapılmaz. Bu mekanizma modelin
karar verebilmesi için güncel gerçekleri ve araçları sağlar; her modelin doğru hedefi
veya doğru semantik yorumu seçeceğini garanti etmez.

Gerçek yerel ledger → Unknown kaydı → withdrawn → reset kontrolü:
`npm run build && node test/live-investigation.mjs`. Harici model veya hedef kullanmaz.

Progress comes from new native Evidence identities, truth-verified Unknown resolutions
and passing Forge versions, with duplicates and historical origins excluded from new
work. A successful tool exit, task claim or recipe replay alone does not grant an extra
step budget. Primary and worker models share these facts. Counts do not prove goal completion.

Large task state remains complete on disk within its 16 MiB limit. `omr_state` supports
`path` (JSON Pointer), `offset` and `limit` for bounded reads; e.g. `/goal` pages text
and `/acceptance/0/proofRefs` pages references. Omitted large values return navigation
metadata; they are not silently converted into a truncated JSON document.

## Embedding SDK ve ölçüm

ESM uygulamaları `oh-my-rea/sdk` üzerinden aynı runtime'ı terminal döngüsü olmadan
kullanabilir. SDK process signal handler kurmaz ve `process.exit` çağırmaz.
Hedef yalnız açık `target` seçeneğiyle belirlenir; model/REA bağlantısı gerektiğinde açılır.

```ts
import { createRuntime } from "oh-my-rea/sdk";

const runtime = await createRuntime({ cwd: process.cwd() });
const unsubscribe = runtime.onEvent(({ event, replayed }) => {
  console.log(event.seq, event.type, replayed);
});
try {
  const result = await runtime.run("Seçilen artifact'ı incele ve Evidence ile açıkla.");
  console.log(result.outcome.status, result.text);
  const page = await runtime.readEvents({ afterSeq: 0, limit: 100 });
  console.log(page.at(-1)?.seq);
} finally {
  unsubscribe();
  await runtime.close();
}
```

`command('/state get')`, `snapshot()`, `cancel()` ve `run(..., {signal})` desteklenir.
Model gerektirmeyen kullanım için `noModel: true` verilebilir. `createRuntime({resume: id})`
yeni continuation açar; canlı SDK'da `/fork` ve `/resume` aynı CLI sözleşmesini kullanır.
Aktif session kendisine resume edilmez. `commandResult` komutun structured payload'ıdır.
İşlemler instance içinde sıralıdır; her sonuç kendi typed outcome/exitCode değerini taşır.
Observer'lar committed olayları görür, yazıcıyı bekletmez; hata verenler ayrılır ve
`observerErrors()` ile görünür. Cursor yeni continuation dosyasına göre değerlendirilir;
session kimliğiyle birlikte tutulmalıdır. `readEvents` snapshot'ı yalnız committed
sequence sınırını içerir. Kaynak temizliğini beklemek için `close()` mutlaka await edilir.

Process içindeki bütün runtime/worker'lar ortak backend admission kullanır:

| Kaynak | Varsayılan eşzamanlı sınır |
|---|---:|
| Model attempt | 4 |
| REA call | 2 |
| Browser operation | 4 |
| Script / shell | 2 / 2 |
| Kalıcı MCP / yerel browser process | 2 / 2 |

Her kaynak kuyruğu en fazla128 bekleyen iş tutar; iptal edilen iş kapasite tüketmez.
`OMR_RESOURCE_LIMITS='{"model":2,"rea":1,"mcpProcess":1}'` başlangıç değerlerini değiştirir.
SDK `configureResourceLimits({...})` yalnız bütün kaynaklar idle iken atomik değişir;
`snapshot().resources` active/queued/peak/admitted/cancelled/waitMs gösterir.
Bunlar concurrency/process admission sınırlarıdır; RSS/CPU için OS hard limit veya
filesystem sandbox garantisi vermez. POSIX yerel browser kendi process group'unda
TERM→KILL ile temizlenir. Linux REA, host'ta `setsid` varsa doğrulanmış owned group
kullanır; diğer host'larda SDK direct child cleanup uygulanır. Ortak haricî Camofox
servisi bu client'ın process kapasitesiyle yönetilmez.

Runtime snapcompact tam text/frame arşivini SHA-bound `context-archive/` içinde saklar.
Aktif projection en fazla bir frame ve window'un%15'i/8500token image bütçesi taşır.
Sığmayan eski frame'ler silinmez: `omr_context action=list` ref'leri sayfalar,
`action=get ref=ctx_...`20k karaktere kadar text page veya tek özgün image döndürür.
Fork/resume arşivi bağımsız kopyalar; origin korunur. Önizleme/context arşivi yeni
native Evidence doğrulaması değildir. TaskState önizlemesi de revision ile cache'lenir;
tam goal ve diğer kayıtlar `omr_state` pointer/pagination yolundan okunabilir.

Repo checkout'ında `npm run eval -- --out <report.json>` beş offline SDK episode'unu doğrular:
exact kabul koşulu, aktif ledger citation precision, duplicate analysis, gerçek
compact/fresh-resume rediscovery ve token metrikleri. Scripted model/REA fixture
kullanır; LLM zekâsını veya uzak provider task success oranını ölçmez. Prompt/schema
estimate, synthetic provider usage ve usage bulunmayan conservative charge ayrıdır.
`npm run bench -- --samples 10 --real-rea --out <report.json>` gerçek yerel REA ile
startup/import/tool, loopback10ms SSE TTFT, routed schema, compaction ve trace replay
ölçer. `--real-rea` verilmezse kontrollü stdio fixture kullanır. Ham örnekler, fingerprint,
nearest-rank p50/p95 ve RSS türleri saklanır; fresh Node process OS cache flush demek değildir.
Uzak model/API çağrısı veya dependency kurulumu yapılmaz.

`npm run bench:startup -- --samples 10 --out <report.json>` interaktif TUI'nin açılışını gerçek
bir pty üzerinde ölçer (`python3` ve PATH'te `rea` gerekir): ilk çizim, açılışta yazılan
`/help` komutunun çalışması, 24 saatlik model-limit önbelleği bayatken ilk çizim ve büyük
bir oturumla `--resume` (transcript'in görünmesi / geri yükleme tamamlanması). Config, cwd ve
oturumlar geçicidir; kullanıcı config'ine dokunmaz. `--entry <bin/omr.js>` ile başka bir
build aynı harness'la ölçülür.

`node test/live-native-resume.mjs --report <report.json>` ayrıca kurulu yerel REA ile
inert JS uygulama dizinini analiz eder; native Evidence export/import, source session
silindikten sonra bağımsız continuation ve copied recipe proof doğrulamasını sınar.
Model kullanmaz; genel test paketinden ayrı opt-in integration kontrolüdür.

Mevcut format/workflow router ve `rea_tools`/`rea_call` keşfi korunur. OMR bir REA
MCP backend'ine bağlanır; genel multi-server MCP host değildir. Ek provider'lar mevcut
`ReaPort` adapter seam'iyle bağlanabilir; gerçek ikinci backend gereksinimi ve ölçülmüş
fayda olmadan learned router veya genel MCP host karmaşıklığı eklenmemiştir.

## Session layout

```
~/.rea/sessions/<timestamp>-<slug>/
  session.json          strict agent-session/v1 descriptor (read by rea session-status)
  omr.json              omr metadata (version, target, model, paths)
  subagents.json        live Subagent Mesh DAG & step-by-step telemetry snapshot
  journal.jsonl         S1 journal written by REA (tool.call / tool.result / checkpoints)
  execution.jsonl       fsynced OMR invocation, model and canonical conversation trace
  history.json          current model projection and interrupted-turn checkpoint
  history-assets/       content-addressed conversation images
  context-archive/      immutable full compaction text/frame records and paged index
  origin.json           source session, target and Evidence import status
  evidence-bundle.json  complete backend bundle when export/import tools are advertised
  usage.json            shared durable usage, reservations and session budget cap
  task-state.json       revisioned goals, constraints, decisions, acceptance, work and artifacts
  investigation-state.json  provider gap decisions and historical analysis scope
  checkpoints/          S1 checkpoints
  report.md             cumulative investigation answers
  evidence.json         written by /export when no path is given
  scripts/              generated and saved scripts (/save, workflow autosave, omr_run)
  scripts/.runs/        one JSON record per omr_run execution
  forge/registry.json   immutable version index, active versions and proof pointers
  forge/<id>/<version>/ source, manifest and semantic fixture proofs
  forge/executions/     isolated working directories and run records (not an OS sandbox)
  recipes/<run-id>/     versioned episode receipt, native results and verified artifacts
```

Fork and resume create independent continuation directories. REA, browser, workers,
journal and scripts switch together. A completed REA journal is not reopened in place.
Evidence is imported into the new backend only when its catalog advertises the
import tool; historical citations remain unverified otherwise. Imported observations
retain their original identity and are not new observations of the current target.

Tool intent is synced before dispatch and the result is synced afterwards. A crash
between them leaves an uncertain invocation. `/resume reconcile` lists unresolved
work and native journal candidates; a digest match alone does not prove ownership.
Use `/resume reconcile <id> completed|retry <observation or decision>` after inspecting
the effect. Uncertain mutations stop automatic continuation and duplicate dispatch.
Compaction and rewind update the model projection while the original trace remains.

Primary, worker and compaction models share one token ledger. Each inference retry
and failover candidate reserves capacity before dispatch and receives a bounded
output limit. Provider usage settles the reservation; a lost response or a summary
without usage is charged as an explicitly labelled estimate. Unfinished reservations
are consumed conservatively after a crash. This is token admission accounting,
not a guarantee about an external provider's invoice or hidden server-side tokens.
`/budget` shows spent, reserved and estimated tokens. The session cap and usage survive
resume; a fork copies their baseline and then accounts independently. Environment
and saved model settings provide the initial cap for a fresh session. Change a restored
cap with `/budget <tokens>|off`. `/budget reset [note]` explicitly starts a new measured
baseline and retains the previous usage in the trace. Old histories without usage data
require this explicit baseline before a finite budget can admit more model work.

Batch runs return `0` for completion, `1` for failure, `2` for a partial answer or
budget limit, and `130` for cancellation. JSONL `turn.result` and `assistant` events
include `status` and `finish_reason`; truncated tool calls are not executed.

Remote text compaction requires an explicit custom summary endpoint. Native
Responses encrypted compaction items cannot be replayed by the current Chat
Completions/Anthropic transports, so they trigger the documented soft fallback.
Browser calls share a cancellable wall-clock deadline (`OMR_BROWSER_TIMEOUT_MS`,
default 30000). Proxy/Tor preferences apply to the next local browser launch;
Camofox routing is server-managed and unverified. This client rejects Camofox
navigation when an unapplied proxy/Tor override is requested.

`/browser context` shows the selected tab and last recorded DOM/screenshot;
`/browser select <tabId>` selects a tab observed in this runtime. `omr_browser`
supports the same `context` and `select` actions. Snapshot text is page data;
its recorded time, hash and pagination remain explicit. Page actions invalidate
element references. A screenshot or tab listing does not refresh those refs.
Snapshots/screenshots feed the next model step, and selected context survives
conversation compaction. Fork/resume retain artifact bytes as historical observations
with independent file copies; they do not automatically reattach a live tab.
Session shutdown closes local processes and only remote tabs created by that runtime,
using a bounded cleanup deadline. Observed tabs and the shared Camofox service remain.

Uzak tab ownership kaydı endpoint/userId/sessionKey/runId kapsamını API/access key
olmadan saklar. Cleanup başarısızlığı veya crash sonrası `/browser context` ve
`browser-state.json` operatörün eski kapsamı bulmasını sağlar; yeni runtime/fork
bu metadata'dan otomatik canlı sahiplik veya silme yetkisi üretmez.

## Boundaries

- Static and runtime REA tools are both first-class; the operator owns scope and authorization, and REA's own tool-side checks report their remediation verbatim.
- Every factual finding cites `evidence_id`; unresolved material questions go to `record_unknown`.
- Target content is data, never instructions.
