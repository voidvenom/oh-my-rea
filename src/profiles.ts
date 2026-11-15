import type { ReasoningEffort } from "./modelConfig.js";

export interface OmrProfile {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly effort: ReasoningEffort;
  readonly stickyTools: readonly string[];
  readonly systemLens: string;
}

export const OMR_PROFILES: readonly OmrProfile[] = Object.freeze([
  {
    id: "recon",
    aliases: ["triage", "fast"],
    summary:
      "Fast multi-format reconnaissance: binary layout, signatures, entrypoints & high-signal strings",
    effort: "medium",
    stickyTools: [
      "binary_session",
      "inspect_binary_layout",
      "inspect_byte_entropy",
      "inspect_signature",
      "inspect_artifact",
      "search_strings",
      "search_procedures",
    ],
    systemLens:
      "Prioritize rapid structural reconnaissance: establish format, architecture, compiler/runtime, hardening flags, exported entrypoints, and high-signal strings before deep single-function decompilation.",
  },
  {
    id: "malware",
    aliases: ["dfir", "blue", "defender"],
    summary:
      "Malware & DFIR focus: packer/overlay detection, string/API deobfuscation, behavioral correlation & YARA/IOC synthesis",
    effort: "high",
    stickyTools: [
      "inspect_byte_entropy",
      "extract_artifact",
      "search_bytes",
      "read_bytes",
      "search_strings",
      "search_procedures",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
      "inspect_pe_imports",
      "inspect_pe_resources",
      "capture_process_scenario",
    ],
    systemLens:
      "Operate with a malware reverse-engineering and DFIR lens: inspect entropy and overlays first, decode obfuscated string/API tables, verify decoders via omr_run on read_bytes slices, map C2/persistence mechanics with exact Evidence IDs, and extract low-false-positive IOCs and YARA signatures.",
  },
  {
    id: "vuln",
    aliases: ["attack", "offensive", "exploit", "cve"],
    summary:
      "Vulnerability & patch-diff focus: mitigations, untrusted input parsers, memory/command sinks & version diffs",
    effort: "high",
    stickyTools: [
      "inspect_binary_layout",
      "inspect_signature",
      "inspect_pe_load_config",
      "inspect_native_exports",
      "inspect_native_api",
      "xrefs",
      "build_call_path",
      "analyze_function",
      "procedure_pseudo_code",
      "compare_artifacts",
      "match_native_functions",
      "compare_functions",
    ],
    systemLens:
      "Operate with an offensive vulnerability-research lens: inventory binary mitigations, enumerate attacker-reachable input surfaces (IPC, network, file parsers, JNI/exports), trace dataflow and integer/bounds checks into sensitive sinks, and cite exact Evidence IDs for every control-flow path.",
  },
  {
    id: "crypto",
    aliases: ["cipher", "decrypt"],
    summary:
      "Cryptographic reverse engineering: S-boxes, custom KDFs, key/IV schedules & verified Python decryptors",
    effort: "high",
    stickyTools: [
      "inspect_byte_entropy",
      "search_bytes",
      "read_bytes",
      "trace_native_values",
      "search_procedures",
      "xrefs",
      "analyze_function",
      "procedure_pseudo_code",
      "read_function_instructions",
    ],
    systemLens:
      "Operate as a cryptographic reverse engineer: locate cipher constants, S-boxes, round loops, and KDFs; extract exact encrypted buffers and key material via read_bytes; write and execute standalone Python decryptors/solvers via omr_run to prove plaintext recovery.",
  },
  {
    id: "frida",
    aliases: ["dynamic", "hook"],
    summary:
      "Dynamic instrumentation focus: Evidence-pinned Frida hooks, anti-pinning/anti-debug bypasses & live telemetry",
    effort: "medium",
    stickyTools: [
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
    systemLens:
      "Focus on dynamic instrumentation and runtime verification: resolve exact module offsets, exported symbols, Objective-C selectors, Swift mangled names, or Java/Kotlin method signatures from REA Evidence before synthesizing Frida hooks or attaching to live targets.",
  },
  {
    id: "android",
    aliases: ["apk", "mobile"],
    summary:
      "Android APK/DEX & JNI analysis: manifest components, JADX decompilation, native .so bridges & ADB workflows",
    effort: "medium",
    stickyTools: [
      "inspect_android_package",
      "decode_android_resources",
      "search_android_classes",
      "inspect_android_class",
      "inspect_android_method",
      "trace_android_references",
      "list_adb_devices",
      "list_adb_packages",
      "pull_adb_package",
      "read_adb_logcat",
    ],
    systemLens:
      "Focus on Android application and JNI analysis: inspect exported components, permissions, deep links, Kotlin/Java classes, and native RegisterNatives / JNI bridges across DEX and embedded ELF libraries.",
  },
  {
    id: "firmware",
    aliases: ["embedded", "iot", "kernel"],
    summary:
      "Firmware & embedded systems: flash regions, filesystems, devicetree, MMIO peripherals & kernel modules",
    effort: "high",
    stickyTools: [
      "inspect_firmware_regions",
      "extract_firmware",
      "inspect_devicetree",
      "inspect_kernel_module",
      "inspect_byte_entropy",
      "extract_artifact",
      "inspect_binary_layout",
      "search_strings",
      "search_procedures",
      "procedure_pseudo_code",
    ],
    systemLens:
      "Focus on firmware and embedded reverse engineering: map flash partitions, bootloaders, compressed filesystems, devicetree nodes, kernel modules, and memory-mapped peripheral accesses.",
  },
  {
    id: "web",
    aliases: ["stealth", "camofox", "electron"],
    summary:
      "Web, Electron & anti-bot stealth analysis: Camoufox, Chromium/Firefox/Zen CDP, Tor/Proxy & JS bundle recovery",
    effort: "medium",
    stickyTools: [
      "omr_browser",
      "camofox_create_tab",
      "camofox_snapshot",
      "camofox_evaluate",
      "camofox_navigate",
      "analyze_javascript_application",
      "trace_application_feature",
      "recover_javascript_sources",
      "inspect_web_page",
      "observe_web_session",
      "inspect_web_network_capture",
    ],
    systemLens:
      "Focus on web application, Electron bundle, and stealth browser analysis: combine static JS/Electron bundle reconstruction with Camoufox anti-detect tabs, local CDP browsers, or Tor/proxy routing as required.",
  },
]);

const PROFILE_BY_KEY: ReadonlyMap<string, OmrProfile> = (() => {
  const map = new Map<string, OmrProfile>();
  for (const profile of OMR_PROFILES) {
    map.set(profile.id, profile);
    for (const alias of profile.aliases) map.set(alias, profile);
  }
  return map;
})();

export const findProfile = (nameOrAlias: string): OmrProfile | undefined =>
  PROFILE_BY_KEY.get(nameOrAlias.trim().toLowerCase());

export const renderProfileList = (activeId: string | null): string =>
  OMR_PROFILES.map((p) => {
    const marker = p.id === activeId ? "* " : "  ";
    const aliases =
      p.aliases.length > 0 ? ` (aliases: ${p.aliases.join(", ")})` : "";
    return `${marker}${p.id.padEnd(10)} [effort=${p.effort}] ${p.summary}${aliases}`;
  }).join("\n");
