import {
  adbPrompt,
  auditPrompt,
  comparePrompt,
  crashPrompt,
  explainPrompt,
  forgePrompt,
  investigatePrompt,
  scriptPrompt,
  tracePrompt,
  triagePrompt,
} from "./core.js";
import {
  capaPrompt,
  deobfuscatePrompt,
  firmwarePrompt,
  iocPrompt,
  masvsPrompt,
  sandboxPrompt,
  sbomPrompt,
  unpackPrompt,
} from "./defensive.js";
import {
  browserPrompt,
  cryptoPrompt,
  diffCvePrompt,
  fridaPrompt,
  protocolPrompt,
  surfacePrompt,
} from "./offensive.js";

export type WorkflowCategory = "attack" | "defender" | "core" | "web";

export interface WorkflowRenderArgs {
  readonly target: string | null;
  readonly focus: string;
  readonly secondaryTarget?: string | undefined;
  readonly scriptKind?: string | undefined;
  readonly browserStatus?: string | undefined;
}

export interface OmrWorkflowSpec {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly category: WorkflowCategory;
  readonly summary: string;
  readonly autoSavePrefix?: string | undefined;
  readonly promotedTools: readonly string[];
  /**
   * Intent triggers, matched against the operator's natural-language request by {@link scoreWorkflows}.
   * A word of 4+ letters is a prefix (so Turkish suffixes match: "yama" → "yamasını"); shorter words
   * match whole tokens only. A trigger with spaces is a run of consecutive words. Keep generic words
   * ("extract", "device", "compare") out: a false match promotes tools and busts the prompt cache.
   */
  readonly triggers: readonly string[];
  readonly buildPrompt: (args: WorkflowRenderArgs) => string;
}

export const OMR_WORKFLOWS: readonly OmrWorkflowSpec[] = Object.freeze([
  {
    id: "surface",
    aliases: ["attack-surface", "mitigations"],
    category: "attack",
    summary:
      "Map binary hardening (PIE, NX, Canary, RELRO, CFG, Fuses), external entrypoints & dangerous sinks",
    promotedTools: [
      "inspect_binary_layout",
      "inspect_signature",
      "inspect_pe_load_config",
      "inspect_pe_imports",
      "inspect_pe_certificates",
      "inspect_native_exports",
      "inspect_native_api",
      "inspect_electron_fuses",
      "xrefs",
      "build_call_path",
    ],
    triggers: [
      "attack surface",
      "saldırı yüzey",
      "mitigation",
      "hardening",
      "canary",
      "relro",
      "aslr",
      "pie",
      "nx",
      "entitlement",
      "electron fuse",
      "entrypoint",
      "dangerous sink",
      "giriş nokta",
      "exploit mitigation",
    ],
    buildPrompt: ({ target, focus }) => surfacePrompt(target, focus),
  },
  {
    id: "diff-cve",
    aliases: ["patch-diff"],
    category: "attack",
    summary:
      "Diff two binary/package versions to pinpoint security patches, bounds checks & vulnerability root causes",
    promotedTools: [
      "compare_artifacts",
      "compare_bundles",
      "match_native_functions",
      "find_changed_behavior",
      "compare_functions",
      "compare_managed_members",
      "compare_application_versions",
      "analyze_function",
      "procedure_pseudo_code",
    ],
    triggers: [
      "diff cve",
      "patch diff",
      "n day",
      "nday",
      "cve",
      "security patch",
      "güvenlik yama",
      "yama fark",
      "zafiyet fark",
      "iki sürüm",
      "sürüm fark",
      "patched version",
    ],
    buildPrompt: ({ target, secondaryTarget, focus }) =>
      diffCvePrompt(
        target ?? "(left_path)",
        secondaryTarget ?? "(right_path)",
        focus,
      ),
  },
  {
    id: "protocol",
    aliases: ["proto", "pcap"],
    category: "attack",
    summary:
      "Reconstruct wire/PCAP/IPC packet framing & handshake state machines and synthesize a Python protocol bot",
    autoSavePrefix: "protocol-client",
    promotedTools: [
      "inspect_pcap_capture",
      "inspect_packet_capture",
      "inspect_packet_fields",
      "search_strings",
      "search_procedures",
      "xrefs",
      "procedure_pseudo_code",
    ],
    triggers: [
      "protocol",
      "pcap",
      "pcapng",
      "wireshark",
      "handshake",
      "opcode",
      "tlv",
      "protobuf",
      "grpc",
      "packet framing",
      "paket yapı",
      "protokol",
      "websocket frame",
      "network traffic",
      "ağ trafiği",
    ],
    buildPrompt: ({ target, focus }) => protocolPrompt(target, focus),
  },
  {
    id: "crypto",
    aliases: ["cipher", "decrypt"],
    category: "attack",
    summary:
      "Locate cipher constants, S-boxes, KDFs, keys & IVs and synthesize a standalone Python decryptor",
    autoSavePrefix: "crypto-solver",
    promotedTools: [
      "inspect_byte_entropy",
      "search_bytes",
      "read_bytes",
      "trace_native_values",
      "search_procedures",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
    ],
    triggers: [
      "crypto",
      "cipher",
      "decrypt",
      "aes",
      "chacha",
      "salsa20",
      "rc4",
      "rsa",
      "hmac",
      "pbkdf",
      "hkdf",
      "sbox",
      "s box",
      "key schedule",
      "encryption",
      "şifreleme",
      "şifre çöz",
      "kripto",
      "anahtar bul",
      "hardcoded key",
      "hardcoded secret",
      "api key",
      "secret key",
      "embedded key",
      "gömülü anahtar",
    ],
    buildPrompt: ({ target, focus }) => cryptoPrompt(target, focus),
  },
  {
    id: "frida",
    aliases: ["hook"],
    category: "attack",
    summary:
      "Synthesize Evidence-pinned Frida (.js) hooks & anti-pinning/anti-debug bypasses and optionally attach live",
    autoSavePrefix: "frida-hook",
    promotedTools: [
      "instrument_with_frida",
      "start_frida_session",
      "load_frida_script",
      "frida_session_status",
      "search_procedures",
      "analyze_function",
      "procedure_pseudo_code",
      "inspect_android_class",
      "inspect_android_method",
      "get_objc_classes",
      "demangle_swift",
    ],
    triggers: [
      "frida",
      "interceptor",
      "java perform",
      "ssl pinning",
      "certificate pinning",
      "root detect",
      "anti debug",
      "anti frida",
      "hook",
      "hookla",
      "bypass license",
      "bypass check",
      "bypass root",
      "bypass pinning",
    ],
    buildPrompt: ({ target, focus }) => fridaPrompt(target, focus),
  },
  {
    id: "browser",
    aliases: ["camofox", "web", "tor"],
    category: "web",
    summary:
      "Stealth anti-bot browsing (Camoufox Docker/MCP), real local browsers (Chromium/Firefox/Zen CDP), Proxy & Tor",
    promotedTools: [
      "omr_browser",
      "camofox_create_tab",
      "camofox_snapshot",
      "camofox_click",
      "camofox_type",
      "camofox_navigate",
      "camofox_evaluate",
      "camofox_screenshot",
      "camofox_list_tabs",
      "camofox_close_tab",
      "list_browser_targets",
      "inspect_web_page",
      "observe_web_session",
      "capture_browser_scenario",
      "inspect_web_network_capture",
    ],
    triggers: [
      "camofox",
      "camoufox",
      "cloudflare",
      "captcha",
      "turnstile",
      "anti bot",
      "waf",
      "chromium",
      "firefox",
      "zen browser",
      "tor",
      "onion",
      "socks5",
      "browser",
      "tarayıcı",
      "web page",
      "http",
    ],
    buildPrompt: ({ target, focus, browserStatus }) =>
      browserPrompt(target, focus, browserStatus),
  },
  {
    id: "ioc",
    aliases: ["yara", "sigma", "dfir"],
    category: "defender",
    summary:
      "Extract Evidence-pinned network/host/byte IOCs and synthesize a low-FP production YARA rule (.yar)",
    autoSavePrefix: "yara-ioc",
    promotedTools: [
      "inspect_binary_layout",
      "inspect_byte_entropy",
      "search_strings",
      "search_bytes",
      "read_bytes",
      "inspect_pe_imports",
      "inspect_pe_resources",
      "inspect_signature",
    ],
    triggers: [
      "yara",
      "sigma",
      "ioc",
      "iocs",
      "dfir",
      "indicator of compromise",
      "c2",
      "mutex",
      "malware",
      "beacon",
      "zararlı",
      "yara kural",
      "ioc çıkar",
    ],
    buildPrompt: ({ target, focus }) => iocPrompt(target, focus),
  },
  {
    id: "unpack",
    aliases: ["extract"],
    category: "defender",
    summary:
      "Identify & extract packers/containers (PyInstaller, Bun, ASAR, UPX, Firmware, IL2CPP, Flutter AOT)",
    promotedTools: [
      "inspect_artifact",
      "inspect_byte_entropy",
      "extract_artifact",
      "inspect_firmware_regions",
      "extract_firmware",
      "inspect_il2cpp_metadata",
      "identify_flutter_build",
      "inspect_dart_aot",
      "inspect_python_pyc",
      "recover_javascript_sources",
    ],
    triggers: [
      "unpack",
      "packer",
      "packed",
      "upx",
      "pyinstaller",
      "asar",
      "il2cpp",
      "flutter aot",
      "dart aot",
      "firmware",
      "binwalk",
      "unblob",
      "overlay",
      "paketlen",
      "ayıkla",
    ],
    buildPrompt: ({ target, focus }) => unpackPrompt(target, focus),
  },
  {
    id: "sandbox",
    aliases: ["behavior", "proc-diff"],
    category: "defender",
    summary:
      "Capture & correlate runtime process behavior, native API calls, child processes & network activity",
    promotedTools: [
      "capture_process_scenario",
      "compare_process_captures",
      "observe_native_calls",
      "correlate_static_and_runtime",
      "inspect_pcap_capture",
      "instrument_with_frida",
    ],
    triggers: [
      "sandbox",
      "behavioral",
      "process capture",
      "process diff",
      "syscall",
      "davranış analiz",
      "çalışma zamanı davranış",
      "runtime behavior",
      "dropped file",
      "child process",
    ],
    buildPrompt: ({ target, focus }) => sandboxPrompt(target, focus),
  },
  {
    id: "deobfuscate",
    aliases: ["deobf", "strings-decrypt"],
    category: "defender",
    summary:
      "Decode encrypted/stack string tables, dynamic API hash resolution & obfuscated control flow",
    autoSavePrefix: "deobfuscator",
    promotedTools: [
      "search_procedures",
      "search_bytes",
      "read_bytes",
      "inspect_byte_entropy",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
      "read_function_instructions",
      "trace_native_values",
      "recover_javascript_sources",
    ],
    triggers: [
      "deobfuscat",
      "obfuscat",
      "encrypted string",
      "stack string",
      "api hash",
      "ror13",
      "string decrypt",
      "şifreli string",
      "gizlenmiş string",
      "string table",
      "control flow flatten",
    ],
    buildPrompt: ({ target, focus }) => deobfuscatePrompt(target, focus),
  },
  {
    id: "sbom",
    aliases: ["supply-chain", "deps"],
    category: "defender",
    summary:
      "Inventory linked & statically embedded libraries, compiler/runtime versions, certificates & crypto modules",
    promotedTools: [
      "inspect_binary_layout",
      "inspect_elf_notes",
      "inspect_macho",
      "trace_dylib_resolution",
      "inspect_pe_imports",
      "inspect_pe_certificates",
      "inspect_signature",
      "inspect_go_binary",
      "inspect_rust_binary",
      "inspect_managed_artifact",
      "search_strings",
    ],
    triggers: [
      "sbom",
      "supply chain",
      "embedded librar",
      "dependency inventory",
      "linked librar",
      "rpath",
      "dependenc",
      "tedarik zincir",
      "gömülü kütüphane",
      "bağımlılık",
    ],
    buildPrompt: ({ target, focus }) => sbomPrompt(target, focus),
  },
  {
    id: "triage",
    aliases: [],
    category: "core",
    summary:
      "Fast multi-format target reconnaissance: format, protections, entrypoints & recommended next probes",
    promotedTools: [
      "binary_session",
      "inspect_binary_layout",
      "inspect_byte_entropy",
      "inspect_signature",
      "inspect_artifact",
      "search_strings",
      "search_procedures",
    ],
    triggers: [
      "triage",
      "initial recon",
      "quick overview",
      "hızlı analiz",
      "ön inceleme",
    ],
    buildPrompt: ({ target, focus }) => triagePrompt(target, focus),
  },
  {
    id: "investigate",
    aliases: [],
    category: "core",
    summary:
      "Deep, bounded Evidence-backed investigation workflow for any target feature or question",
    promotedTools: [
      "binary_session",
      "search_strings",
      "search_procedures",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
      "build_call_path",
    ],
    triggers: ["investigate", "deep dive", "detaylı incele", "araştır"],
    buildPrompt: ({ target, focus }) =>
      investigatePrompt(target, focus || "explain purpose and architecture"),
  },
  {
    id: "explain",
    aliases: [],
    category: "core",
    summary:
      "Decompile & explain a specific function, class, method, or address with Evidence",
    promotedTools: [
      "search_procedures",
      "analyze_function",
      "procedure_pseudo_code",
      "procedure_callers",
      "procedure_callees",
      "xrefs",
      "inspect_android_method",
    ],
    triggers: ["explain function", "fonksiyonu açıkla"],
    buildPrompt: ({ target, focus }) => explainPrompt(target, focus || "main"),
  },
  {
    id: "trace",
    aliases: [],
    category: "core",
    summary:
      "Trace incoming callers, outgoing callees & cross-boundary xrefs across a feature or symbol",
    promotedTools: [
      "xrefs",
      "procedure_callers",
      "procedure_callees",
      "trace_feature",
      "trace_call_path",
      "build_call_path",
      "trace_android_references",
    ],
    triggers: [
      "call graph",
      "call chain",
      "caller trace",
      "çağrı zincir",
      "xref takip",
    ],
    buildPrompt: ({ target, focus }) => tracePrompt(target, focus || "main"),
  },
  {
    id: "crash",
    aliases: [],
    category: "defender",
    summary:
      "Localize crash dumps, signals (SIGSEGV/SIGABRT), exceptions & fault root causes",
    promotedTools: [
      "inspect_recorded_crash",
      "inspect_apple_ips",
      "inspect_elf_notes",
      "resolve_containing_procedure",
      "analyze_function",
      "procedure_pseudo_code",
      "build_call_path",
    ],
    triggers: [
      "crash",
      "sigsegv",
      "sigabrt",
      "segfault",
      "core dump",
      "stack overflow",
      "use after free",
      "çökme",
    ],
    buildPrompt: ({ target, focus }) => crashPrompt(target, focus || "crash"),
  },
  {
    id: "audit",
    aliases: [],
    category: "defender",
    summary: "Audit open residual unknowns against retained session Evidence",
    promotedTools: [
      "list_unknowns",
      "verify_unknown_resolution",
      "update_unknown",
      "get_evidence_bundle",
    ],
    triggers: ["residual unknown", "audit unknown", "bilinmeyenleri denetle"],
    buildPrompt: ({ focus }) => auditPrompt(focus),
  },
  {
    id: "compare",
    aliases: [],
    category: "core",
    summary:
      "Compare two application versions through inventory & function dossiers",
    promotedTools: [
      "compare_artifacts",
      "compare_bundles",
      "match_native_functions",
      "compare_functions",
    ],
    triggers: ["compare versions", "compare two", "karşılaştır"],
    buildPrompt: ({ target, secondaryTarget }) =>
      comparePrompt(target ?? "(left_path)", secondaryTarget ?? "(right_path)"),
  },
  {
    id: "script",
    aliases: ["bot", "codegen"],
    category: "core",
    summary:
      "Synthesize an Evidence-pinned RE script/bot (frida|python|gdb|rizin|yara) and auto-save to session",
    autoSavePrefix: "omr-script",
    promotedTools: [
      "search_procedures",
      "analyze_function",
      "procedure_pseudo_code",
      "read_bytes",
      "xrefs",
    ],
    triggers: [
      "script yaz",
      "bot yaz",
      "otomasyon script",
      "solver",
      "gdb script",
      "rizin script",
      "write a script",
      "write a bot",
      "automation script",
    ],
    buildPrompt: ({ target, focus, scriptKind }) =>
      scriptPrompt(target, scriptKind || "python", focus),
  },
  {
    id: "adb",
    aliases: [],
    category: "core",
    summary:
      "Live Android ADB device, package extraction, logcat & runtime inspection workflow",
    promotedTools: [
      "list_adb_devices",
      "inspect_adb_device",
      "list_adb_packages",
      "inspect_adb_package",
      "pull_adb_package",
      "read_adb_logcat",
      "list_adb_processes",
    ],
    triggers: [
      "adb",
      "logcat",
      "android cihaz",
      "android device",
      "emülatör",
      "emulator",
    ],
    buildPrompt: ({ target, focus }) => adbPrompt(target, focus),
  },
  {
    id: "capa",
    aliases: ["attck", "mitre", "mbc", "capabilities"],
    category: "defender",
    summary:
      "Map static binary capabilities to MITRE ATT&CK (Txxxx) & Malware Behavior Catalog (MBC) and synthesize a CAPA rule",
    autoSavePrefix: "capa-rule",
    promotedTools: [
      "inspect_binary_layout",
      "inspect_byte_entropy",
      "inspect_pe_imports",
      "inspect_native_api",
      "search_strings",
      "search_procedures",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
      "read_function_instructions",
      "trace_native_values",
    ],
    triggers: [
      "capa",
      "mitre",
      "attck",
      "att ck",
      "malware behavior catalog",
      "mbc",
      "capability matrix",
      "capability rule",
      "yetenek harita",
      "davranış katalog",
      "t1027",
      "t1055",
      "t1547",
    ],
    buildPrompt: ({ target, focus }) => capaPrompt(target, focus),
  },
  {
    id: "firmware",
    aliases: ["iot", "embedded", "mcu"],
    category: "defender",
    summary:
      "Audit embedded firmware, bootloaders (U-Boot/FIT/ESP32), DeviceTree, rootfs, kernel modules & hardcoded secrets",
    autoSavePrefix: "firmware-audit",
    promotedTools: [
      "inspect_firmware_regions",
      "extract_firmware",
      "inspect_devicetree",
      "inspect_kernel_module",
      "inspect_byte_entropy",
      "inspect_binary_layout",
      "search_strings",
      "search_bytes",
      "read_bytes",
      "search_procedures",
      "analyze_function",
      "procedure_pseudo_code",
    ],
    triggers: [
      "firmware audit",
      "iot security",
      "iot audit",
      "devicetree",
      "dtb",
      "u boot",
      "uboot",
      "esp32",
      "squashfs",
      "jffs2",
      "ubifs",
      "nvram",
      "mmio",
      "kernel module",
      "gömülü sistem",
      "donanım yazılım",
    ],
    buildPrompt: ({ target, focus }) => firmwarePrompt(target, focus),
  },
  {
    id: "masvs",
    aliases: ["mobile-audit", "mastg", "apk-audit"],
    category: "defender",
    summary:
      "Audit Android/iOS mobile packages against OWASP MASVS & MASTG (storage, crypto, network, exported surface & JNI)",
    autoSavePrefix: "masvs-audit",
    promotedTools: [
      "inspect_android_package",
      "inspect_apk_signature",
      "decode_android_resources",
      "search_android_classes",
      "inspect_android_class",
      "inspect_android_method",
      "trace_android_references",
      "inspect_sqlite_database",
      "inspect_macho",
      "inspect_plist",
      "get_objc_classes",
      "demangle_swift",
    ],
    triggers: [
      "masvs",
      "mastg",
      "owasp mobile",
      "apk audit",
      "mobile audit",
      "mobil güvenlik",
      "apk güvenlik",
      "exported activity",
      "content provider",
      "sharedpreferences",
      "nsuserdefaults",
      "androidmanifest",
    ],
    buildPrompt: ({ target, focus }) => masvsPrompt(target, focus),
  },
  {
    id: "forge",
    aliases: ["toolgen", "craft", "maketool"],
    category: "core",
    summary:
      "Synthesize & verify a custom RE analyzer tool + installable .omr/commands/*.md slash-command playbook",
    autoSavePrefix: "forged-tool",
    promotedTools: [
      "binary_session",
      "inspect_binary_layout",
      "inspect_byte_entropy",
      "search_strings",
      "search_procedures",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
      "read_bytes",
      "omr_run",
    ],
    triggers: [
      "forge",
      "toolgen",
      "maketool",
      "custom tool",
      "build a tool",
      "create a tool",
      "synthesize tool",
      "otomatik tool",
      "tool hazırla",
      "araç üret",
      "komut üret",
      "custom command",
    ],
    buildPrompt: ({ target, focus }) => forgePrompt(target, focus),
  },
]);

const WORKFLOW_BY_KEY: ReadonlyMap<string, OmrWorkflowSpec> = (() => {
  const map = new Map<string, OmrWorkflowSpec>();
  for (const wf of OMR_WORKFLOWS) {
    map.set(wf.id, wf);
    for (const alias of wf.aliases) map.set(alias, wf);
  }
  return map;
})();

/** Find an OMR workflow spec by canonical id or alias (`"ioc"`, `"yara"`, `"deobf"`, `"sandbox"`, …). */
export const findOmrWorkflow = (
  nameOrAlias: string,
): OmrWorkflowSpec | undefined => {
  const clean = nameOrAlias.trim().replace(/^\/+/, "").toLowerCase();
  return WORKFLOW_BY_KEY.get(clean);
};

/** Lowercase, drop combining dots (Turkish "İ"), and split into letter/digit tokens. */
const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/\u0307/g, "")
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

const wordMatches = (word: string, token: string): boolean =>
  word.length >= 4 ? token.startsWith(word) : token === word;

const triggerMatches = (
  trigger: string,
  tokens: readonly string[],
): boolean => {
  const words = tokenize(trigger);
  if (words.length === 0) return false;
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    if (
      words.every((word, offset) => wordMatches(word, tokens[start + offset]!))
    )
      return true;
  }
  return false;
};

/** Whether `text` contains any of `triggers` (same matching rules as workflow triggers). */
export const hasAnyTrigger = (
  text: string,
  triggers: readonly string[],
): boolean => {
  const tokens = tokenize(text);
  return triggers.some((trigger) => triggerMatches(trigger, tokens));
};

/** Workflows whose triggers match the request, best first (ties keep catalog order). */
export const scoreWorkflows = (
  userInput: string,
): readonly {
  readonly workflow: OmrWorkflowSpec;
  readonly score: number;
}[] => {
  const tokens = tokenize(userInput);
  if (tokens.length === 0) return [];
  const scored: { workflow: OmrWorkflowSpec; score: number; order: number }[] =
    [];
  OMR_WORKFLOWS.forEach((workflow, order) => {
    const score = workflow.triggers.filter((trigger) =>
      triggerMatches(trigger, tokens),
    ).length;
    if (score > 0) scored.push({ workflow, score, order });
  });
  scored.sort((x, y) => y.score - x.score || x.order - y.order);
  return scored.map(({ workflow, score }) => ({ workflow, score }));
};

/**
 * Match up to `maxMatches` specialized OMR workflows from a natural-language user prompt
 * so the agent automatically promotes their tools and knows which playbooks apply even
 * when the user did not type a `/command`.
 */
export const matchWorkflowsForInput = (
  userInput: string,
  maxMatches = 3,
): OmrWorkflowSpec[] =>
  scoreWorkflows(userInput)
    .slice(0, maxMatches)
    .map((entry) => entry.workflow);

/**
 * Build a compact per-turn routing note when natural-language input matches one or more
 * OMR slash-command workflows. Rides on the user turn note so the system prompt cache stays intact.
 */
export const autonomousWorkflowNote = (userInput: string): string | null => {
  const matched = matchWorkflowsForInput(userInput, 3);
  if (matched.length === 0) return null;
  const labels = matched.map((w) => `/${w.id} (${w.summary})`).join("; ");
  return (
    `[omr autonomous workflow match: user intent aligns with ${labels}. ` +
    `You can call \`omr_workflow { workflow: "${matched[0]!.id}", focus: "..." }\` to load the full step-by-step playbook, or execute its REA tool sequence directly.]`
  );
};
