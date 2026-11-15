import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseReasoningEffort, type ReasoningEffort } from "./modelConfig.js";

export interface CustomCommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly effort: ReasoningEffort | null;
  readonly autoSavePrefix: string | null;
  readonly template: string;
  readonly filePath: string;
  readonly scope: "user" | "project";
}

export interface CustomCommandRenderContext {
  readonly args: string;
  readonly target: string | null;
  readonly sessionDir: string;
  readonly cwd: string;
}

const VALID_COMMAND_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export const userCommandsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env["OMR_USER_COMMANDS_DIR"]?.trim() ||
  join(homedir(), ".config", "rea", "omr", "commands");

export const projectCommandsDir = (cwd: string): string =>
  join(cwd, ".omr", "commands");

const stripQuotes = (raw: string): string => {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseAliases = (raw: string): string[] => {
  const clean = raw.trim().replace(/^\[|\]$/g, "");
  if (!clean) return [];
  return clean
    .split(/[\s,]+/)
    .map((item) => stripQuotes(item).replace(/^\/+/, "").toLowerCase())
    .filter((item) => VALID_COMMAND_NAME_RE.test(item));
};

/**
 * Parse a markdown command template with optional `---` YAML frontmatter:
 * `description`, `aliases`, `argument` (or `usage`), `effort`, `autoSavePrefix`.
 */
export const parseCustomCommandMarkdown = (
  nameHint: string,
  rawMarkdown: string,
  filePath: string,
  scope: "user" | "project",
): CustomCommandSpec | null => {
  const normalizedName = nameHint.trim().replace(/^\/+/, "").toLowerCase();
  if (!VALID_COMMAND_NAME_RE.test(normalizedName)) return null;

  const normalized = rawMarkdown.replace(/\r\n/g, "\n");
  let body = normalized;
  const meta: Record<string, string> = {};

  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---\n", 4);
    if (end > 0) {
      const header = normalized.slice(4, end);
      body = normalized.slice(end + 5);
      for (const line of header.split("\n")) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const val = stripQuotes(line.slice(colon + 1));
        if (key && val) meta[key] = val;
      }
    }
  }

  const template = body.trim();
  if (!template) return null;

  const firstHeading = /^#+\s+(.+)$/m.exec(template)?.[1]?.trim();
  const firstLine = template
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  const fallbackDesc = (firstHeading || firstLine || "Custom command").slice(
    0,
    110,
  );
  const description = meta["description"] || fallbackDesc;
  const aliases = parseAliases(meta["aliases"] ?? "").filter(
    (alias) => alias !== normalizedName,
  );
  const argHint = meta["argument"] ?? meta["usage"] ?? "[args]";
  const usage = argHint.startsWith("/")
    ? argHint
    : `/${normalizedName}${argHint ? ` ${argHint}` : ""}`;
  const effort = meta["effort"] ? parseReasoningEffort(meta["effort"]) : null;
  const autoSavePrefix = meta["autosaveprefix"] || meta["autosave_prefix"] || null;

  return {
    name: normalizedName,
    aliases,
    description,
    usage,
    effort,
    autoSavePrefix,
    template,
    filePath,
    scope,
  };
};

const scanCommandsDir = (
  dir: string,
  scope: "user" | "project",
): CustomCommandSpec[] => {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const specs: CustomCommandSpec[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || extname(entry).toLowerCase() !== ".md")
      continue;
    const fullPath = join(dir, entry);
    try {
      const st = statSync(fullPath);
      if (!st.isFile() || st.size > 256_000) continue;
      const raw = readFileSync(fullPath, "utf8");
      const stem = basename(entry, extname(entry));
      const parsed = parseCustomCommandMarkdown(stem, raw, fullPath, scope);
      if (parsed) specs.push(parsed);
    } catch {
      continue;
    }
  }
  return specs;
};

/**
 * Discover custom `.md` slash commands from `~/.config/rea/omr/commands/` and `<cwd>/.omr/commands/`.
 * Project-scoped commands take precedence over user-scoped commands of the same name, while built-in
 * command names reserved by `reservedNames` are never shadowed.
 */
export const discoverCustomCommands = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  reservedNames: ReadonlySet<string> = new Set(),
): CustomCommandSpec[] => {
  const byName = new Map<string, CustomCommandSpec>();
  for (const spec of scanCommandsDir(userCommandsDir(env), "user")) {
    if (reservedNames.has(spec.name)) continue;
    byName.set(spec.name, spec);
  }
  for (const spec of scanCommandsDir(projectCommandsDir(cwd), "project")) {
    if (reservedNames.has(spec.name)) continue;
    byName.set(spec.name, spec);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const splitPositionalArgs = (input: string): string[] => {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
};

/**
 * Render a custom command template with `$ARGUMENTS`, `$1..$9`, `$TARGET`, `$SESSION_DIR`, and `$CWD`.
 * If the template does not reference `$ARGUMENTS` or `$1..$9` and the operator passed arguments,
 * appends an explicit `Operator focus: <args>` footer so caller input is preserved.
 */
export const renderCustomCommandPrompt = (
  spec: CustomCommandSpec,
  ctx: CustomCommandRenderContext,
): string => {
  const trimmedArgs = ctx.args.trim();
  const positional = splitPositionalArgs(trimmedArgs);
  const usesArgsPlaceholder = /\$ARGUMENTS\b|\$[1-9]\b/.test(spec.template);

  let rendered = spec.template
    .replace(/\$ARGUMENTS\b/g, trimmedArgs || "(none specified)")
    .replace(/\$TARGET\b/g, ctx.target ?? "(none bound)")
    .replace(/\$SESSION_DIR\b/g, ctx.sessionDir)
    .replace(/\$CWD\b/g, ctx.cwd)
    .replace(/\$([1-9])\b/g, (_, idx: string) => {
      const pos = Number.parseInt(idx, 10) - 1;
      return positional[pos] ?? "";
    });

  if (!usesArgsPlaceholder && trimmedArgs) {
    rendered = `${rendered}\n\nOperator focus: ${trimmedArgs}`;
  }
  return rendered;
};

/** Save a reusable custom `.md` command into `<cwd>/.omr/commands/<name>.md` (or user commands dir). */
export const saveCustomCommandFile = async (options: {
  readonly name: string;
  readonly description: string;
  readonly template: string;
  readonly cwd: string;
  readonly scope?: "project" | "user" | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<{ path: string; spec: CustomCommandSpec }> => {
  const cleanName = options.name.trim().replace(/^\/+/, "").toLowerCase();
  if (!VALID_COMMAND_NAME_RE.test(cleanName)) {
    throw new Error(
      `Invalid command name "${options.name}". Use lowercase letters, digits, hyphens, underscores, or dots.`,
    );
  }
  const scope = options.scope ?? "project";
  const dir =
    scope === "user"
      ? userCommandsDir(options.env)
      : projectCommandsDir(options.cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${cleanName}.md`);
  const cleanDesc =
    options.description.replace(/\r?\n/g, " ").trim() ||
    `Custom OMR workflow /${cleanName}`;
  const body = options.template.trim();
  if (!body) {
    throw new Error("Cannot save an empty command template.");
  }
  const hasArgs = /\$ARGUMENTS\b|\$[1-9]\b/.test(body);
  const finalBody = hasArgs ? body : `${body}\n\nFocus: $ARGUMENTS`;
  const markdown =
    `---\n` +
    `description: ${JSON.stringify(cleanDesc)}\n` +
    `argument: "[focus]"\n` +
    `---\n\n` +
    `${finalBody}\n`;
  await writeFile(filePath, markdown, { mode: 0o600 });
  const parsed = parseCustomCommandMarkdown(cleanName, markdown, filePath, scope);
  if (!parsed) {
    throw new Error(`Failed to parse generated command file at ${filePath}`);
  }
  return { path: filePath, spec: parsed };
};

export interface ForgeCommandPreset {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly effort: ReasoningEffort;
  readonly autoSavePrefix: string | null;
  readonly template: string;
}

/**
 * Curated cyber/RE slash-command blueprints grounded in Mandiant CAPA, MITRE ATT&CK / MBC,
 * OWASP MASVS/MASTG, DFIR config extraction, and binary patch diffing.
 * Operators can install any or all presets into `.omr/commands/*.md` via `/forge install <name|all>`.
 */
export const FORGE_COMMAND_PRESETS: readonly ForgeCommandPreset[] = Object.freeze([
  {
    name: "config-extractor",
    aliases: ["cfg-dump", "c2-extract"],
    description:
      "Extract embedded C2/application configuration blobs, decrypt keys/tables, and verify with a standalone Python extractor",
    effort: "high",
    autoSavePrefix: "config-extractor",
    template: `# Automated Configuration & Embedded Table Extractor (/config-extractor)

Target: $TARGET
Focus: $ARGUMENTS
Session directory: $SESSION_DIR

Execute an Evidence-backed configuration & embedded resource extraction workflow:
1. Inspect \`binary_session\`, \`inspect_binary_layout\`, \`inspect_byte_entropy\`, \`inspect_pe_resources\`, and \`search_strings\` to locate high-entropy data sections, \`.rdata\`/\`.data\` blobs, or embedded JSON/XML/TLV/protobuf configurations.
2. Trace cross-references (\`xrefs\`, \`search_procedures\`, \`analyze_function\`, \`procedure_pseudo_code\`, \`read_bytes\`) to the initialization or parsing routine that reads the configuration structure.
3. Synthesize a standalone \`\`\`python\`\`\` configuration extractor script that reads the exact file offsets/bytes, decodes any XOR/RC4/AES/custom framing, and prints the structured configuration JSON.
4. Run the extractor via \`omr_run\` to verify its output and cite every \`[ev_...]\` relied upon.`,
  },
  {
    name: "capa-hunter",
    aliases: ["mbc-hunt"],
    description:
      "Hunt static behavioral capabilities mapped to MITRE ATT&CK (Txxxx) & Malware Behavior Catalog (MBC) and emit a CAPA rule",
    effort: "high",
    autoSavePrefix: "capa-hunter-rule",
    template: `# Static Capability Hunter — MITRE ATT&CK & MBC (/capa-hunter)

Target: $TARGET
Focus: $ARGUMENTS

1. Enumerate imports, exports, strings, and procedures (\`inspect_binary_layout\`, \`inspect_pe_imports\`, \`inspect_native_api\`, \`search_strings\`, \`search_procedures\`).
2. Decompile candidate functions (\`analyze_function\`, \`procedure_pseudo_code\`, \`xrefs\`) exhibiting process/thread manipulation, persistence, credential access, defense evasion, cryptography, or socket/HTTP communication.
3. Map each verified capability to **MITRE ATT&CK** (\`Txxxx\`) and **MBC** (\`Objective::Behavior\`) with exact function addresses and \`[ev_...]\` IDs, and emit a valid \`\`\`yaml\`\`\` \`capa\` rule.`,
  },
  {
    name: "jni-bridge-tracer",
    aliases: ["jni-trace"],
    description:
      "Map Android Java/Kotlin native methods to JNI C/C++ implementations (Java_* & RegisterNatives) and generate Frida hooks",
    effort: "high",
    autoSavePrefix: "jni-hook",
    template: `# Android JNI & Native Bridge Tracer (/jni-bridge-tracer)

Target: $TARGET
Focus: $ARGUMENTS

1. Inspect the Android package and native libraries (\`inspect_android_package\`, \`search_android_classes\`, \`inspect_android_class\`, \`inspect_android_method\`).
2. Locate \`native\` method declarations and correlate them with static \`Java_<pkg>_<cls>_<method>\` exports or dynamic \`JNI_OnLoad\` \`RegisterNatives\` tables (\`search_procedures\`, \`search_strings\`, \`xrefs\`, \`procedure_pseudo_code\`, \`trace_native_values\`).
3. Present a **Java ↔ JNI Mapping Table** (\`Java Signature | Native Library | Symbol / Offset | Registration Kind | Evidence ID\`) and emit a ready-to-run \`\`\`javascript\`\`\` Frida hook script.`,
  },
  {
    name: "firmware-secret-scanner",
    aliases: ["fw-secrets"],
    description:
      "Audit firmware images, DeviceTree, rootfs & NVRAM for hardcoded credentials, private keys, and vulnerable daemons",
    effort: "high",
    autoSavePrefix: "fw-secret-scan",
    template: `# Firmware Hardcoded Secret, Certificate & Daemon Scanner (/firmware-secret-scanner)

Target: $TARGET
Focus: $ARGUMENTS

1. Inspect firmware layout and partitions (\`inspect_firmware_regions\`, \`extract_firmware\`, \`inspect_devicetree\`, \`inspect_byte_entropy\`, \`inspect_artifact\`).
2. Scan strings, byte sequences, and procedures (\`search_strings\`, \`search_bytes\`, \`read_bytes\`, \`search_procedures\`) for PEM/DER keys (\`BEGIN RSA\`, \`BEGIN PRIVATE\`, \`0x30 0x82\`), password hashes, API tokens, UART/bootloader backdoors, and unsafe \`system\`/\`popen\`/\`strcpy\` sinks.
3. Output a categorized **Firmware Secret & Sink Ledger** with exact offsets and \`[ev_...]\` citations.`,
  },
  {
    name: "protocol-dissector",
    aliases: ["proto-dissect"],
    description:
      "Reverse custom binary/TLV/Protobuf/IPC packet framing from parser procedures or PCAP captures and build a Python dissector",
    effort: "high",
    autoSavePrefix: "protocol-dissector",
    template: `# Custom Wire & IPC Protocol Dissector (/protocol-dissector)

Target: $TARGET
Focus: $ARGUMENTS

1. Inspect PCAP captures or socket/IPC send/recv handlers (\`inspect_pcap_capture\`, \`inspect_packet_capture\`, \`inspect_packet_fields\`, \`search_procedures\`, \`xrefs\`, \`procedure_pseudo_code\`).
2. Recover the exact frame header layout (magic bytes, length field endianness, opcode dispatch table, sequence numbers, CRC/HMAC trailer).
3. Emit a standalone \`\`\`python\`\`\` packet dissector & serializer and verify it with \`omr_run\` against sample frame bytes.`,
  },
  {
    name: "patch-nday-auditor",
    aliases: ["nday-audit"],
    description:
      "Diff unpatched vs. patched binaries to isolate added bounds/lifetime checks and root-cause 1-day/N-day vulnerabilities",
    effort: "xhigh",
    autoSavePrefix: "patch-audit",
    template: `# Binary Security Patch & N-Day Root-Cause Auditor (/patch-nday-auditor)

Target: $TARGET
Comparison / Focus: $ARGUMENTS

1. Compare artifact inventories and matched functions (\`compare_artifacts\`, \`match_native_functions\`, \`find_changed_behavior\`, \`compare_functions\`).
2. Decompile modified procedures on both sides (\`analyze_function\`, \`procedure_pseudo_code\`) and isolate newly added bounds checks, integer overflow guards, reference-count/lifetime fixes, or sanitizer checks.
3. Document the exact vulnerability class (CWE), pre-patch trigger condition, post-patch guard, and \`[ev_...]\` citations.`,
  },
]);

export const installForgePreset = async (
  preset: ForgeCommandPreset,
  options: {
    readonly cwd: string;
    readonly scope?: "project" | "user" | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
): Promise<{ path: string; spec: CustomCommandSpec }> => {
  const scope = options.scope ?? "project";
  const dir =
    scope === "user"
      ? userCommandsDir(options.env)
      : projectCommandsDir(options.cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${preset.name}.md`);
  const aliasesLine =
    preset.aliases.length > 0
      ? `aliases: [${preset.aliases.join(", ")}]\n`
      : "";
  const autoSaveLine = preset.autoSavePrefix
    ? `autoSavePrefix: ${JSON.stringify(preset.autoSavePrefix)}\n`
    : "";
  const markdown =
    `---\n` +
    `description: ${JSON.stringify(preset.description)}\n` +
    aliasesLine +
    `argument: "[focus]"\n` +
    `effort: ${JSON.stringify(preset.effort)}\n` +
    autoSaveLine +
    `---\n\n` +
    `${preset.template.trim()}\n`;
  await writeFile(filePath, markdown, { mode: 0o600 });
  const parsed = parseCustomCommandMarkdown(
    preset.name,
    markdown,
    filePath,
    scope,
  );
  if (!parsed) {
    throw new Error(`Failed to parse preset command at ${filePath}`);
  }
  return { path: filePath, spec: parsed };
};
