import {
  asArray,
  asNumber as num,
  asRecord,
  asString as str,
} from "./values.js";

export const SCHEMA_VERSION = "omr-events/v1";

export const normalized = (payload: unknown): unknown => {
  const record = asRecord(payload);
  if (!record) return payload;
  if ("normalized_result" in record && record["normalized_result"] !== null)
    return record["normalized_result"];
  if ("result" in record) return record["result"];
  return payload;
};

export const compactJson = (payload: unknown, limit = 4000): string => {
  const text = JSON.stringify(payload, null, 2) ?? String(payload);
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… (${text.length - limit} bytes truncated)`;
};

export const shortSha = (value: unknown): string => str(value).slice(0, 16);

export const renderOpen = (payload: unknown): string => {
  const record = asRecord(normalized(payload));
  if (!record) return compactJson(payload);
  const architecture = str(record["architecture"]);
  return [
    `opened ${str(record["format"], "unknown")}/${str(record["kind"], "unknown")}${architecture ? ` (${architecture})` : ""}`,
    `  path    ${str(record["path"])}`,
    `  sha256  ${shortSha(record["sha256"])}…`,
  ].join("\n");
};

export const renderEvidence = (payload: unknown): string => {
  const record = asRecord(normalized(payload));
  if (!record) return compactJson(payload);
  const total = num(record["total_retained_records"]) ?? 0;
  const matching = num(record["matching_records"]) ?? 0;
  const revisions = num(record["unknown_revisions"]) ?? 0;
  const lines = [
    `evidence ${matching}/${total} records · ${revisions} unknown revisions`,
  ];
  for (const item of asArray(record["records"]).slice(0, 15)) {
    const entry = asRecord(item);
    if (!entry) continue;
    const provider = asRecord(entry["provider"]);
    const evId = str(entry["evidence_id"]);
    lines.push(
      `  ${evId.slice(0, 22)}…  ${str(entry["operation"], "?").padEnd(28)}  ${str(provider?.["id"])}`.trimEnd(),
    );
  }
  if (matching > 15)
    lines.push(`  … ${matching - 15} more (use /evidence <ev_id_or_prefix>)`);
  return lines.join("\n");
};

export const renderUnknowns = (payload: unknown): string => {
  const record = asRecord(normalized(payload));
  if (!record) return compactJson(payload);
  const items = asArray(record["items"]);
  const total = num(record["total"]) ?? items.length;
  if (total === 0) return "no residual unknowns";
  const lines = [`unknowns ${items.length}/${total}`];
  for (const item of items) {
    const entry = asRecord(item);
    if (!entry) continue;
    lines.push(
      `  [${str(entry["status"], "?")}/${str(entry["severity"], "?")}] ${str(entry["unknown_id"]).slice(0, 18)}…  ${str(entry["question"])}`,
    );
  }
  return lines.join("\n");
};

export const renderStringMatches = (payload: unknown, limit = 25): string => {
  const unwrapped = normalized(payload);
  const matches = Array.isArray(unwrapped)
    ? unwrapped
    : asArray(
        asRecord(unwrapped)?.["items"] ??
          asRecord(unwrapped)?.["matches"] ??
          asRecord(unwrapped)?.["rows"],
      );
  if (matches.length === 0) return "  (no matches)";
  const lines = [`  ${matches.length} match(es)`];
  for (const match of matches.slice(0, limit)) {
    const entry = asRecord(match);
    if (!entry) continue;
    const primary =
      str(entry["value"]) || str(entry["name"]) || str(entry["display_name"]);
    const aliases = asArray(entry["matched_aliases"])
      .map((item) => str(item))
      .filter(Boolean);
    const aliasNote =
      aliases.length > 0 ? `  (alias: ${aliases.slice(0, 2).join(", ")})` : "";
    lines.push(
      `  ${str(entry["address"], "?").padEnd(14)} ${primary.replace(/\n/g, "\\n").slice(0, 120)}${aliasNote}`,
    );
  }
  if (matches.length > limit) lines.push(`  … ${matches.length - limit} more`);
  return lines.join("\n");
};

export const renderClassMatches = (payload: unknown, limit = 30): string => {
  const record = asRecord(normalized(payload));
  if (!record) return compactJson(payload);
  const matches = asArray(record["matches"]);
  const totalClasses = num(record["total_classes"]);
  if (matches.length === 0)
    return `no class matches (${totalClasses ?? "?"} classes indexed)`;
  const lines = [
    `${matches.length} class match(es) of ${totalClasses ?? "?"} indexed`,
  ];
  for (const name of matches.slice(0, limit)) lines.push(`  ${str(name)}`);
  if (matches.length > limit) lines.push(`  … ${matches.length - limit} more`);
  return lines.join("\n");
};

export const renderSession = (payload: unknown): string => {
  const record = asRecord(normalized(payload));
  if (!record) return compactJson(payload);
  const open = record["open"] === true;
  const lines: string[] = [];
  if (open) {
    const architecture = str(record["architecture"]);
    lines.push(
      `target    ${str(record["path"])} (${str(record["format"], "?")}/${str(record["kind"], "?")}${architecture ? `, ${architecture}` : ""})`,
    );
    lines.push(
      `sha256    ${shortSha(record["sha256"])}… · open=${open} cleanup_pending=${String(record["cleanup_pending"])}`,
    );
  } else {
    lines.push("target    (no target open in binary_session)");
  }
  const providers: string[] = [];
  for (const candidate of asArray(record["analysis_provider_candidates"])) {
    const entry = asRecord(candidate);
    const provider = asRecord(entry?.["provider"]);
    const availability = asRecord(entry?.["availability"]);
    if (!provider) continue;
    const status = str(availability?.["status"], "?");
    if (status === "available") providers.push(str(provider["id"], "?"));
  }
  if (providers.length > 0) lines.push(`providers ${providers.join(", ")}`);
  const binding = asRecord(record["analysis_provider_binding"]);
  if (binding) {
    const bindingProvider = asRecord(binding["provider"]);
    const bindingId =
      str(binding["provider_id"]) ||
      str(binding["id"]) ||
      str(bindingProvider?.["id"]);
    if (bindingId) lines.push(`bound     ${bindingId}`);
  }
  return lines.join("\n");
};

export const renderProviders = (payload: unknown): string => {
  const record = asRecord(normalized(payload));
  if (!record) return compactJson(payload);
  const lines: string[] = [];
  for (const candidate of asArray(record["analysis_provider_candidates"])) {
    const entry = asRecord(candidate);
    const provider = asRecord(entry?.["provider"]);
    const availability = asRecord(entry?.["availability"]);
    if (!provider) continue;
    const status = str(availability?.["status"], "?");
    const reason = str(availability?.["reason"]);
    lines.push(
      `  ${status === "available" ? "✓" : "✗"} ${str(provider["id"], "?").padEnd(16)}${reason ? ` — ${reason}` : ""}`,
    );
  }
  const tools = asRecord(record["tool_availability"]);
  const requirements = asRecord(tools?.["client_requirements"]);
  for (const missing of asArray(requirements?.["missing_required"])) {
    lines.push(`  ! missing required client feature: ${str(missing)}`);
  }
  const identity = asRecord(record["server_identity"]);
  const pkg = asRecord(identity?.["package"]);
  if (pkg)
    lines.push(
      `  rea ${str(pkg["version"], "?")} · ${str(pkg["root_path"], "")}`,
    );
  return lines.join("\n");
};

export const renderJournalTail = (journalText: string, limit = 30): string => {
  const rawLines = journalText
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-limit);
  if (rawLines.length === 0) return "(journal is empty)";
  const formatted: string[] = [];
  for (const raw of rawLines) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const rec = asRecord(parsed);
      if (!rec) {
        formatted.push(raw);
        continue;
      }
      const seq = String(num(rec["seq"]) ?? "?").padStart(3, "0");
      const type = str(rec["type"], "?");
      const time = str(rec["at"]).slice(11, 19);
      if (type === "tool.call") {
        formatted.push(`#${seq} ${time}  ▸ call    ${str(rec["tool"], "?")}`);
      } else if (type === "tool.result") {
        const ok = rec["ok"] === true;
        const dur = num(rec["duration_ms"]);
        const evs = asArray(rec["evidence_ids"])
          .map((e) => str(e).slice(0, 12))
          .filter(Boolean);
        formatted.push(
          `#${seq} ${time}  ${ok ? "✓" : "✗"} result  ${str(rec["tool"], "?").padEnd(24)} ${dur !== null ? `${dur}ms` : ""}${evs.length > 0 ? `  [${evs.join(", ")}]` : ""}`.trimEnd(),
        );
      } else if (type === "session.start" || type === "session.end") {
        const outcome = str(rec["outcome"]);
        formatted.push(
          `#${seq} ${time}  ◈ ${type}${outcome ? ` (${outcome})` : ""}`,
        );
      } else if (type === "checkpoint") {
        formatted.push(
          `#${seq} ${time}  ◆ checkpoint through #${num(rec["through_seq"]) ?? "?"} (${num(rec["records"]) ?? 0} ev)`,
        );
      } else {
        formatted.push(`#${seq} ${time}  · ${type}`);
      }
    } catch {
      formatted.push(raw.slice(0, 160));
    }
  }
  return formatted.join("\n");
};
