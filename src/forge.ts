import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { BrokerOutcome } from "./broker.js";
import { ConcurrencyLimiter } from "./concurrency.js";
import { writeJsonAtomic } from "./durable.js";
import { runSessionScript, scrubbedEnv, type RunFailure, type RunOutcome } from "./exec.js";
import type { ExecutionStore } from "./execution.js";
import { parseToolSchema, validateToolValue, type JsonSchema } from "./jsonSchema.js";
import type { LocalTool } from "./localTools.js";
import { asRecord } from "./values.js";

export interface ForgeDependency {
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly versionContains?: string;
}
export interface ForgeFixture { readonly id: string; readonly input: Record<string, unknown>; readonly expected: unknown; }
export interface ForgeSpec {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly interpreter: "node" | "python3" | "bash";
  readonly dependencies: readonly ForgeDependency[];
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly fixtures: readonly ForgeFixture[];
  readonly timeoutSec: number;
  readonly network: boolean;
}
export interface ForgeManifest extends ForgeSpec {
  readonly schema: 1;
  readonly codeSha256: string;
  readonly createdAt: string;
  readonly originSessionId: string;
}
interface FixtureRun {
  readonly id: string;
  readonly passed: boolean;
  readonly run: RunOutcome | RunFailure;
  readonly output?: unknown;
  readonly problem?: string;
}
export interface ForgeProof {
  readonly schema: 1;
  readonly ref: string;
  readonly manifestSha256: string;
  readonly codeSha256: string;
  readonly environment: readonly { command: string; version: string }[];
  readonly verifiedAt: string;
  readonly passed: boolean;
  readonly fixtures: readonly FixtureRun[];
}
interface ForgeRecord {
  readonly manifest: ForgeManifest;
  readonly digest: string;
  retired: boolean;
  proofFile: string | null;
  proof: ForgeProof | null;
}
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});
const recordKey = (id: string, version: string): string => `${id}@${version}`;
const shortText = (value: unknown, field: string, max = 4096): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Forge ${field} must be non-empty text (max ${max})`);
  return value;
};
const identity = (id: unknown, version: unknown): { id: string; version: string } => {
  if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(id)) throw new Error("Forge id must match [a-z][a-z0-9_]{0,31}");
  if (typeof version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) throw new Error("Forge version must be numeric major.minor.patch");
  return { id, version };
};
export const forgeToolName = (spec: Pick<ForgeSpec, "id" | "version">): string => `forge_${spec.id}_v${spec.version.replaceAll(".", "_")}`;
const extension = (interpreter: ForgeSpec["interpreter"]): string => interpreter === "node" ? "mjs" : interpreter === "python3" ? "py" : "sh";

export const parseForgeSpec = (raw: unknown): ForgeSpec => {
  const value = asRecord(raw);
  if (!value || Array.isArray(raw)) throw new Error("Forge spec must be an object");
  const allowed = new Set(["id", "version", "description", "interpreter", "dependencies", "inputSchema", "outputSchema", "fixtures", "timeoutSec", "network"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown Forge spec field: ${key}`);
  const names = identity(value["id"], value["version"]);
  const interpreter = value["interpreter"];
  if (interpreter !== "node" && interpreter !== "python3" && interpreter !== "bash") throw new Error("Forge interpreter must be node, python3 or bash");
  const dependencies = value["dependencies"] ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 32) throw new Error("Forge dependencies must be an array (max 32)");
  const parsedDependencies = dependencies.map(rawDependency => {
    const dependency = asRecord(rawDependency);
    if (!dependency || Object.keys(dependency).some(key => !["command", "versionArgs", "versionContains"].includes(key))) throw new Error("Invalid Forge dependency declaration");
    const command = shortText(dependency["command"], "dependency command", 128);
    if (!/^[a-zA-Z0-9_.+-]+$/.test(command)) throw new Error("Dependency commands must be executable names without paths or shell syntax");
    const args = dependency["versionArgs"] ?? ["--version"];
    if (!Array.isArray(args) || args.length > 16 || args.some(arg => typeof arg !== "string" || arg.length > 256)) throw new Error("Invalid dependency versionArgs");
    if (args.length !== 1 || !["--version", "-version", "-V", "-v", "version"].includes(args[0])) throw new Error("Dependency probes accept only a single version flag/subcommand; installers or arbitrary commands are not version probes");
    return { command, versionArgs: args as string[], ...(dependency["versionContains"] === undefined ? {} : { versionContains: shortText(dependency["versionContains"], "dependency versionContains", 256) }) };
  });
  const inputSchema = parseToolSchema(value["inputSchema"], true);
  const outputSchema = parseToolSchema(value["outputSchema"]);
  const fixtures = value["fixtures"];
  if (!Array.isArray(fixtures) || !fixtures.length || fixtures.length > 50) throw new Error("Forge requires 1–50 semantic fixtures with explicit expected JSON");
  const parsedFixtures = fixtures.map(rawFixture => {
    const fixture = asRecord(rawFixture);
    if (!fixture || Object.keys(fixture).some(key => !["id", "input", "expected"].includes(key)) || !Object.hasOwn(fixture, "expected")) throw new Error("Fixture requires id, input and expected JSON");
    const input = asRecord(fixture["input"]);
    if (!input || Array.isArray(input)) throw new Error("Fixture input must be a JSON object");
    validateToolValue(input, inputSchema); validateToolValue(fixture["expected"], outputSchema);
    return { id: shortText(fixture["id"], "fixture id", 80), input, expected: fixture["expected"] };
  });
  if (new Set(parsedFixtures.map(fixture => fixture.id)).size !== parsedFixtures.length) throw new Error("Duplicate Forge fixture id");
  const timeoutSec = value["timeoutSec"] ?? 30;
  if (!Number.isSafeInteger(timeoutSec) || Number(timeoutSec) < 1 || Number(timeoutSec) > 300) throw new Error("Forge timeoutSec must be an integer from 1 to 300");
  if (value["network"] !== undefined && typeof value["network"] !== "boolean") throw new Error("Forge network must be boolean");
  const spec: ForgeSpec = { ...names, description: shortText(value["description"], "description"), interpreter, dependencies: parsedDependencies, inputSchema, outputSchema, fixtures: parsedFixtures, timeoutSec: Number(timeoutSec), network: value["network"] === true };
  if (Buffer.byteLength(JSON.stringify(spec)) > 1_048_576) throw new Error("Forge spec exceeds 1 MiB");
  return structuredClone(spec);
};

/** Immutable versions, semantic proofs and explicit activation; no dependency installation. */
export class ForgeRegistry {
  readonly directory: string;
  private readonly records = new Map<string, ForgeRecord>();
  private readonly active = new Map<string, string>();
  private readonly writer = new ConcurrencyLimiter(1);
  private ready: Promise<void> | null = null;
  constructor(directory: string, private readonly sessionId: string, private readonly trace?: ExecutionStore, private readonly validateName?: (name: string) => void) { this.directory = join(directory, "forge"); }
  private versionDir(id: string, version: string): string { identity(id, version); return join(this.directory, id, version); }
  private async json(path: string): Promise<unknown> {
    if ((await stat(path)).size > 4_194_304) throw new Error(`Forge record exceeds 4 MiB: ${path}`);
    return JSON.parse(await readFile(path, "utf8"));
  }
  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let index: Record<string, unknown> | null;
      try { index = asRecord(await this.json(join(this.directory, "registry.json"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (index?.["schema"] !== 1 || !Array.isArray(index["versions"]) || index["versions"].length > 500) throw new Error("Invalid Forge registry");
      for (const raw of index["versions"]) {
        const entry = asRecord(raw); const names = identity(entry?.["id"], entry?.["version"]);
        const saved = asRecord(await this.json(join(this.versionDir(names.id, names.version), "manifest.json")));
        if (!saved || saved["schema"] !== 1 || typeof saved["codeSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(saved["codeSha256"])) throw new Error("Invalid Forge manifest");
        const { schema: _schema, codeSha256, createdAt, originSessionId, ...spec } = saved;
        const manifest: ForgeManifest = { ...parseForgeSpec(spec), schema: 1, codeSha256, createdAt: shortText(createdAt, "createdAt", 100), originSessionId: shortText(originSessionId, "originSessionId", 256) };
        const digest = sha(canonical(manifest));
        if (manifest.id !== names.id || manifest.version !== names.version || entry?.["digest"] !== digest || this.records.has(recordKey(names.id, names.version))) throw new Error("Forge manifest identity or hash mismatch");
        const proofFile = entry["proofFile"];
        if (proofFile !== null && (typeof proofFile !== "string" || !/^[a-f0-9-]{36}\.json$/.test(proofFile))) throw new Error("Invalid Forge proof file");
        const record: ForgeRecord = { manifest, digest, retired: entry["retired"] === true, proofFile, proof: null };
        if (proofFile) record.proof = this.parseProof(await this.json(join(this.versionDir(names.id, names.version), "proofs", proofFile)), record);
        this.records.set(recordKey(names.id, names.version), record);
      }
      const active = asRecord(index["active"]); if (!active || Array.isArray(active)) throw new Error("Invalid active Forge tools");
      for (const [id, version] of Object.entries(active)) {
        const names = identity(id, version); const record = this.get(names.id, names.version);
        if (record.retired || !record.proof?.passed) throw new Error("Active Forge version has no passing proof");
        await this.code(record); this.validateName?.(forgeToolName(record.manifest)); this.active.set(id, names.version);
      }
    })();
    return this.ready;
  }
  private get(id: string, version: string): ForgeRecord {
    identity(id, version); const record = this.records.get(recordKey(id, version));
    if (!record) throw new Error(`Unknown Forge version: ${id}@${version}`);
    return record;
  }
  private parseProof(raw: unknown, record: ForgeRecord): ForgeProof {
    const proof = asRecord(raw); const manifest = record.manifest;
    if (!proof || proof["schema"] !== 1 || proof["manifestSha256"] !== record.digest || proof["codeSha256"] !== manifest.codeSha256 || typeof proof["ref"] !== "string" || !proof["ref"].startsWith(`forge:${manifest.id}@${manifest.version}:`) || !Array.isArray(proof["fixtures"]) || !Array.isArray(proof["environment"])) throw new Error("Forge proof identity/hash mismatch");
    const fixtures = proof["fixtures"].map(asRecord);
    const commands = [manifest.interpreter, ...manifest.dependencies.map(dependency => dependency.command)];
    if (proof["environment"].length !== commands.length || proof["environment"].some((raw, index) => { const env = asRecord(raw); return env?.["command"] !== commands[index] || typeof env["version"] !== "string" || !env["version"]; })) throw new Error("Invalid Forge proof environment");
    if (typeof proof["verifiedAt"] !== "string" || !Number.isFinite(Date.parse(proof["verifiedAt"]))) throw new Error("Invalid Forge proof timestamp");
    const passed = fixtures.length === manifest.fixtures.length && fixtures.every((fixture, index) => {
      const run = asRecord(fixture?.["run"]);
      return fixture?.["id"] === manifest.fixtures[index]!.id && fixture["passed"] === true && run?.["ok"] === true && run["exitCode"] === 0 && run["timedOut"] === false && run["aborted"] === false && run["droppedBytes"] === 0 && run["sha256"] === manifest.codeSha256 && isDeepStrictEqual(fixture["output"], manifest.fixtures[index]!.expected);
    });
    if (proof["passed"] !== passed) throw new Error("Forge proof verdict differs from fixture results");
    return structuredClone(proof) as unknown as ForgeProof;
  }
  private async publish(records = new Map(this.records), active = new Map(this.active)): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.directory, "registry.json"), { schema: 1, versions: [...records.values()].map(record => ({ id: record.manifest.id, version: record.manifest.version, digest: record.digest, retired: record.retired, proofFile: record.proofFile })), active: Object.fromEntries(active) });
    this.records.clear(); for (const [key, record] of records) this.records.set(key, record);
    this.active.clear(); for (const [id, version] of active) this.active.set(id, version);
  }
  async flush(): Promise<void> { await this.initialize(); await this.writer.run(async () => {}); }
  async register(raw: unknown, code: string): Promise<ForgeManifest> {
    const spec = parseForgeSpec(raw);
    if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > 524_288) throw new Error("Forge source must contain 1–524288 bytes");
    this.validateName?.(forgeToolName(spec)); await this.initialize();
    return this.writer.run(async () => {
      if (this.records.has(recordKey(spec.id, spec.version))) throw new Error("Forge versions are immutable; register a new version");
      if (this.records.size >= 500) throw new Error("Forge registry version limit reached");
      const directory = this.versionDir(spec.id, spec.version);
      await mkdir(join(this.directory, spec.id), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      const manifest: ForgeManifest = { ...spec, schema: 1, codeSha256: sha(code), createdAt: new Date().toISOString(), originSessionId: this.sessionId };
      const file = await open(join(directory, `tool.${extension(spec.interpreter)}`), "wx", 0o600);
      try { await file.writeFile(code); await file.sync(); } finally { await file.close(); }
      await writeJsonAtomic(join(directory, "manifest.json"), manifest);
      const records = new Map(this.records); records.set(recordKey(spec.id, spec.version), { manifest, digest: sha(canonical(manifest)), retired: false, proofFile: null, proof: null });
      await this.publish(records); await this.trace?.append("forge.registered", { id: spec.id, version: spec.version, codeSha256: manifest.codeSha256 });
      return structuredClone(manifest);
    });
  }
  private async code(record: ForgeRecord): Promise<string> {
    const path = join(this.versionDir(record.manifest.id, record.manifest.version), `tool.${extension(record.manifest.interpreter)}`);
    if ((await stat(path)).size > 524_288) throw new Error("Forge source exceeds limit");
    const code = await readFile(path, "utf8");
    if (sha(code) !== record.manifest.codeSha256) throw new Error("Forge source hash changed; register and verify a new version");
    return code;
  }
  private async environment(spec: ForgeSpec, signal?: AbortSignal): Promise<{ command: string; version: string }[]> {
    const dependencies: readonly ForgeDependency[] = [{ command: spec.interpreter, versionArgs: ["--version"] }, ...spec.dependencies];
    const results = await Promise.all(dependencies.map(async dependency => {
      signal?.throwIfAborted();
      const result = await promisify(execFile)(dependency.command, [...dependency.versionArgs], { env: scrubbedEnv(this.directory), timeout: 5000, maxBuffer: 8192, ...(signal ? { signal } : {}) });
      const version = `${result.stdout}${result.stderr}`.trim();
      if (!version || (dependency.versionContains && !version.includes(dependency.versionContains))) throw new Error(`Forge dependency version check failed: ${dependency.command}`);
      return { command: dependency.command, version };
    }));
    return results;
  }
  private async execute(record: ForgeRecord, code: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Omit<FixtureRun, "id" | "passed">> {
    signal?.throwIfAborted(); validateToolValue(input, record.manifest.inputSchema);
    if (Buffer.byteLength(JSON.stringify(input)) > 1_048_576) throw new Error("Forge input exceeds 1 MiB");
    const directory = join(this.directory, "executions", randomUUID()); await mkdir(directory, { recursive: true, mode: 0o700 });
    const run = await runSessionScript({ scriptsDir: directory, script: `tool.${extension(record.manifest.interpreter)}`, code, stdin: `${JSON.stringify(input)}\n`, timeoutSec: record.manifest.timeoutSec, network: record.manifest.network, signal });
    if ("error" in run) return { run, problem: run.error };
    if (!run.ok || run.sha256 !== record.manifest.codeSha256 || run.droppedBytes > 0) return { run, problem: "Script failed, was interrupted, changed hash or produced truncated output" };
    try { const output: unknown = JSON.parse(run.stdout); validateToolValue(output, record.manifest.outputSchema); return { run, output }; }
    catch (error) { return { run, problem: error instanceof Error ? error.message : String(error) }; }
  }
  async verify(id: string, version: string, signal?: AbortSignal): Promise<ForgeProof> {
    await this.initialize();
    return this.writer.run(async () => {
      const prior = this.get(id, version); if (prior.retired) throw new Error("Cannot verify a removed Forge version");
      const record = { ...prior, proof: null, proofFile: null };
      const records = new Map(this.records); records.set(recordKey(id, version), record);
      const active = new Map(this.active); if (active.get(id) === version) active.delete(id);
      await this.publish(records, active);
      const code = await this.code(record); const environment = await this.environment(record.manifest, signal); const fixtures: FixtureRun[] = [];
      for (const fixture of record.manifest.fixtures) {
        const work = () => this.execute(record, code, fixture.input, signal);
        const result = this.trace ? await this.trace.invoke({ backend: "forge-fixture", tool: forgeToolName(record.manifest), args: { fixture: fixture.id, manifestSha256: record.digest, input: fixture.input }, readOnly: false, binding: null }, work, signal) : await work();
        fixtures.push({ id: fixture.id, ...result, passed: !result.problem && isDeepStrictEqual(result.output, fixture.expected), ...(!result.problem && !isDeepStrictEqual(result.output, fixture.expected) ? { problem: "Output differs from the fixture's expected JSON" } : {}) });
      }
      const proofId = randomUUID();
      const proof: ForgeProof = { schema: 1, ref: `forge:${id}@${version}:${proofId}`, manifestSha256: record.digest, codeSha256: record.manifest.codeSha256, environment, verifiedAt: new Date().toISOString(), passed: fixtures.every(fixture => fixture.passed), fixtures };
      const proofFile = `${proofId}.json`; const proofs = join(this.versionDir(id, version), "proofs"); await mkdir(proofs, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(join(proofs, proofFile), proof);
      const verified = new Map(this.records); verified.set(recordKey(id, version), { ...record, proofFile, proof }); await this.publish(verified);
      await this.trace?.append("forge.verified", { id, version, proofRef: proof.ref, passed: proof.passed, manifestSha256: record.digest });
      return structuredClone(proof);
    }, signal);
  }
  async activate(id: string, version: string, signal?: AbortSignal): Promise<void> {
    await this.initialize();
    await this.writer.run(async () => {
      const record = this.get(id, version);
      if (record.retired || !record.proof?.passed) throw new Error("Forge activation requires a passing semantic fixture proof for this version");
      this.validateName?.(forgeToolName(record.manifest)); await this.code(record);
      if (!isDeepStrictEqual(await this.environment(record.manifest, signal), record.proof.environment)) throw new Error("Forge dependency environment changed; verify again");
      const active = new Map(this.active); active.set(id, version); await this.publish(new Map(this.records), active); await this.trace?.append("forge.activated", { id, version, proofRef: record.proof.ref });
    }, signal);
  }
  async remove(id: string, version?: string): Promise<void> {
    await this.initialize();
    await this.writer.run(async () => {
      const candidates = version ? [this.get(id, version)] : [...this.records.values()].filter(record => record.manifest.id === id);
      if (!candidates.length) throw new Error(`Unknown Forge tool: ${id}`);
      const records = new Map(this.records); const active = new Map(this.active);
      for (const record of candidates) { records.set(recordKey(id, record.manifest.version), { ...record, retired: true }); if (active.get(id) === record.manifest.version) active.delete(id); }
      await this.publish(records, active); await this.trace?.append("forge.removed", { id, version: version ?? null });
    });
  }
  async deactivate(id: string): Promise<void> { await this.initialize(); await this.writer.run(async () => { const active = new Map(this.active); active.delete(id); await this.publish(new Map(this.records), active); await this.trace?.append("forge.deactivated", { id }); }); }
  async list(id?: string): Promise<unknown[]> { await this.initialize(); return [...this.records.values()].filter(record => !id || record.manifest.id === id).map(record => ({ ...structuredClone(record.manifest), manifestSha256: record.digest, toolName: forgeToolName(record.manifest), active: this.active.get(record.manifest.id) === record.manifest.version, retired: record.retired, proof: structuredClone(record.proof) })); }
  async resolveProof(ref: string): Promise<boolean> {
    await this.initialize(); const record = [...this.records.values()].find(candidate => candidate.proof?.ref === ref && candidate.proof.passed);
    if (!record || record.retired) return false;
    try { await this.code(record); return isDeepStrictEqual(await this.environment(record.manifest), record.proof!.environment); } catch { return false; }
  }
  activeName(id: string): string | null { const version = this.active.get(id); return version ? forgeToolName(this.get(id, version).manifest) : null; }
  tools(): LocalTool[] {
    return [...this.active].map(([id, version]) => {
      const record = this.get(id, version); const manifest = record.manifest;
      return { definition: { type: "function", function: { name: forgeToolName(manifest), description: `${manifest.description} [Forge ${id}@${version}; semantic fixtures verified; JSON stdin/stdout]`, parameters: manifest.inputSchema } }, backend: "forge", readOnly: () => false,
        invoke: async (args: Record<string, unknown>, signal?: AbortSignal): Promise<BrokerOutcome> => {
          if (this.active.get(id) !== version || record.retired || !record.proof?.passed) throw new Error("Forge version is no longer active");
          const code = await this.code(record);
          if (!isDeepStrictEqual(await this.environment(manifest, signal), record.proof.environment)) throw new Error("Forge dependency environment changed; verify again");
          const result = await this.execute(record, code, args, signal);
          await this.trace?.append("forge.run", { id, version, proofRef: record.proof.ref, ...result });
          return { tool: forgeToolName(manifest), text: JSON.stringify(result), structuredContent: result, isError: Boolean(result.problem), durationMs: 0, evidenceIds: [] };
        } };
    });
  }
}
