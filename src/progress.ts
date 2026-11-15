import { evidenceRecord } from "./evidence.js";
import type { ExecutionObservation, ExecutionStore } from "./execution.js";
import { asRecord, asString } from "./values.js";

/** Novel committed facts, independent of model prose and successful-but-redundant tool exits. */
export class ProgressTracker {
  private readonly evidence = new Set<string>();
  private readonly unknowns = new Set<string>();
  private readonly fixtures = new Set<string>();
  private readonly recipes = new Set<string>();
  private revision = 0;
  private freshEvidence = 0;
  private freshUnknowns = 0;
  private freshFixtures = 0;
  private duplicateEvidence = 0;
  constructor(private readonly sessionId: string, private readonly store: ExecutionStore) { store.observe(observation => this.observe(observation)); }
  get epoch(): number { return this.revision; }
  private observe({ event, invocation }: ExecutionObservation): void {
    const current = event.sessionId === this.sessionId;
    if (event.type === "invocation.completed" && invocation?.backend === "rea") {
      const result = asRecord(event.data["result"]);
      if (result?.["isError"] === true) return;
      const record = evidenceRecord(result?.["payload"]);
      if (record) {
        if (this.evidence.has(record.evidence_id)) { if (current) this.duplicateEvidence++; }
        else { this.evidence.add(record.evidence_id); if (current) { this.freshEvidence++; this.revision++; } }
      }
      if (invocation.tool === "verify_unknown_resolution") {
        const verdict = asRecord(result?.["payload"]); const unknown = asRecord(verdict?.["unknown"]);
        const id = asString(unknown?.["unknown_id"]);
        if (verdict?.["valid"] === true && verdict["truthVerified"] === true && unknown?.["status"] === "resolved" && asRecord(unknown["resolution"])?.["disposition"] === "verified" && /^unk_[a-f0-9]{64}$/.test(id) && !this.unknowns.has(id)) {
          this.unknowns.add(id); if (current) { this.freshUnknowns++; this.revision++; }
        }
      }
    } else if (event.type === "forge.verified" && event.data["passed"] === true) {
      const digest = asString(event.data["manifestSha256"]);
      if (/^[a-f0-9]{64}$/.test(digest) && !this.fixtures.has(digest)) { this.fixtures.add(digest); if (current) { this.freshFixtures++; this.revision++; } }
    } else if (event.type === "recipe.completed" && event.data["status"] === "completed") this.recipes.add(asString(event.data["id"]));
  }
  snapshot(): { epoch: number; newEvidence: number; verifiedUnknowns: number; verifiedFixtureVersions: number; knownEvidenceIncludingOrigin: number; redundantEvidenceResults: number; completedRecipeRunsIncludingOrigin: number; observerErrors: readonly string[] } {
    return { epoch: this.revision, newEvidence: this.freshEvidence, verifiedUnknowns: this.freshUnknowns, verifiedFixtureVersions: this.freshFixtures, knownEvidenceIncludingOrigin: this.evidence.size, redundantEvidenceResults: this.duplicateEvidence, completedRecipeRunsIncludingOrigin: this.recipes.size, observerErrors: this.store.observerErrors() };
  }
  note(): string { const value = this.snapshot(); return `[measured progress: ${value.newEvidence} new native Evidence identities, ${value.verifiedUnknowns} truth-verified Unknown resolutions, ${value.verifiedFixtureVersions} passing Forge versions; ${value.redundantEvidenceResults} duplicate Evidence results. A successful tool exit or a completion claim alone is not progress. These counts are observations, not proof of task completion.]`; }
}
