import { isDeepStrictEqual } from "node:util";
import type { ReaCallResult, ReaPort } from "./rea.js";
import { asRecord, asString } from "./values.js";

export interface RetainedEvidence {
  readonly evidence_id: string;
  readonly operation: string;
  readonly normalized_result: unknown;
  readonly provider: Record<string, unknown>;
  readonly [key: string]: unknown;
}
export const evidenceRecord = (raw: unknown): RetainedEvidence | null => {
  const value = asRecord(raw);
  if (!value || Array.isArray(value) || !/^ev_[a-f0-9]{64}$/.test(asString(value["evidence_id"])) || !asString(value["operation"]) || !Object.hasOwn(value, "normalized_result") || !asString(asRecord(value["provider"])?.["id"])) return null;
  return value as RetainedEvidence;
};

/** Ask the live REA ledger for an exact record; a citation-shaped string is insufficient. */
export const retainedEvidence = async (rea: ReaPort, id: string, signal?: AbortSignal): Promise<RetainedEvidence | null> => {
  if (!/^ev_[a-f0-9]{64}$/.test(id) || !rea.find("get_evidence_bundle")) return null;
  const result = await rea.call("get_evidence_bundle", { detail: "records", filters: { evidence_id: id }, limit: 1 }, { signal });
  if (result.isError) throw new Error(`Retained Evidence lookup failed: ${result.text}`);
  const value = asRecord(result.payload); const records = value?.["records"];
  if (!Array.isArray(records) || records.length !== 1) return null;
  const record = evidenceRecord(records[0]); return record?.evidence_id === id ? record : null;
};

export const verifyReturnedEvidence = async (rea: ReaPort, result: ReaCallResult, operation: string, signal?: AbortSignal): Promise<RetainedEvidence> => {
  if (result.isError) throw new Error(result.text || `REA ${operation} failed`);
  const record = evidenceRecord(result.payload);
  if (!record) throw new Error(`${operation} did not return a complete Evidence record`);
  const view = asRecord(record.normalized_result);
  if (record.operation !== operation && !(record.operation === "inspect_analysis_view" && view?.["parent_operation"] === operation && /^ev_[a-f0-9]{64}$/.test(asString(view["parent_evidence_id"])))) throw new Error(`${operation} returned Evidence for a different operation`);
  const retained = await retainedEvidence(rea, record.evidence_id, signal);
  if (!retained || retained.operation !== record.operation || !isDeepStrictEqual(retained.normalized_result, record.normalized_result)) throw new Error(`${operation} Evidence is missing or differs in the active ledger`);
  if (record.operation === "inspect_analysis_view") {
    const parent = await rea.call("get_evidence_bundle", { detail: "summary", filters: { evidence_id: view!["parent_evidence_id"], operation } }, { signal });
    if (parent.isError || asRecord(parent.payload)?.["matching_records"] !== 1) throw new Error(`${operation} parent Evidence is not retained in the active ledger`);
  }
  return record;
};
