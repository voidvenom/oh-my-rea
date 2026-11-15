import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConcurrencyLimiter } from "./concurrency.js";
import { writeJsonAtomic } from "./durable.js";
import type { ExecutionStore } from "./execution.js";
import { asRecord } from "./values.js";

export type TaskVerification =
  | { readonly kind: "evidence-equals"; readonly ref: string; readonly pointer: string; readonly equals: unknown }
  | { readonly kind: "forge-fixtures" | "recipe-exit" | "unknown-resolution"; readonly ref: string };

export interface TaskEntry {
  readonly id: string;
  readonly text: string;
  readonly status: "open" | "claimed" | "blocked";
  readonly proofRefs: readonly string[];
  readonly verification?: TaskVerification;
}
export interface TaskArtifact {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly originSessionId: string;
}
export interface TaskState {
  readonly schema: 1;
  readonly revision: number;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly decisions: readonly TaskEntry[];
  readonly acceptance: readonly TaskEntry[];
  readonly activeWork: readonly TaskEntry[];
  readonly artifacts: readonly TaskArtifact[];
}
export type TaskStatePatch = Partial<Pick<TaskState,"goal"|"constraints"|"decisions"|"acceptance"|"activeWork"|"artifacts">>;
const empty = (): TaskState=>({schema:1,revision:0,goal:"",constraints:[],decisions:[],acceptance:[],activeWork:[],artifacts:[]});
const text = (value:unknown,field:string,max=16_384):string=>{
  if(typeof value!=="string"||value.length>max) throw new Error(`${field} must be text of at most ${max} characters`);
  return value;
};
const id = (value:unknown):string=>{const valueText=text(value,"id",80);if(!/^[a-zA-Z0-9_.:-]+$/.test(valueText)) throw new Error("Task record id must be non-empty and contain only letters, numbers, _ . : -");return valueText;};
const list = <T>(value:unknown,field:string,parse:(value:unknown)=>T):T[]=>{
  if(!Array.isArray(value)||value.length>500) throw new Error(`${field} must be an array with at most 500 records`);
  return value.map(parse);
};
const unique = <T extends {id:string}>(values:T[]):T[]=>{if(new Set(values.map(value=>value.id)).size!==values.length) throw new Error("Duplicate task record id");return values;};
const verification = (raw: unknown): TaskVerification => {
  const value = asRecord(raw);
  if (!value || Array.isArray(value)) throw new Error("Task verification must be an object");
  const kind = value["kind"]; const ref = text(value["ref"], "verification ref", 512);
  const known = kind === "evidence-equals" ? ["kind", "ref", "pointer", "equals"] : ["kind", "ref"];
  if (Object.keys(value).some(key => !known.includes(key))) throw new Error("Unknown task verification field");
  if (kind === "evidence-equals") {
    if (!/^ev_[a-f0-9]{64}$/.test(ref) || !Object.hasOwn(value, "equals")) throw new Error("Evidence verification requires an exact Evidence ID and expected JSON");
    const pointer = text(value["pointer"], "JSON pointer", 1024);
    if ((pointer !== "" && !pointer.startsWith("/")) || /~(?![01])/.test(pointer)) throw new Error("Invalid verification JSON pointer");
    const encoded = JSON.stringify(value["equals"]);
    if (encoded === undefined || Buffer.byteLength(encoded) > 65_536) throw new Error("Verification expected JSON exceeds 64 KiB or is not JSON");
    return { kind, ref, pointer, equals: JSON.parse(encoded) as unknown };
  }
  if (kind === "forge-fixtures" && /^forge:[a-z][a-z0-9_]{0,31}@\d+\.\d+\.\d+:[a-f0-9-]{36}$/.test(ref)) return { kind, ref };
  if (kind === "recipe-exit" && /^recipe:[a-f0-9-]{36}$/.test(ref)) return { kind, ref };
  if (kind === "unknown-resolution" && /^unk_[a-f0-9]{64}$/.test(ref)) return { kind, ref };
  throw new Error("Invalid task verification kind or proof reference");
};
const entry = (value:unknown):TaskEntry=>{
  const record=asRecord(value);if(!record) throw new Error("Task entry must be an object");
  if(Object.keys(record).some(key=>!["id","text","status","proofRefs","verification"].includes(key))) throw new Error("Unknown task entry field");
  const status=record["status"]??"open";if(status!=="open"&&status!=="claimed"&&status!=="blocked") throw new Error("Task entry status must be open, claimed or blocked; verification is derived from evidence");
  const check = record["verification"] === undefined ? undefined : verification(record["verification"]);
  const refs = list(record["proofRefs"]??[],"proofRefs",value=>text(value,"proof reference",512));
  const proofRefs = [...new Set([...refs,...(check?[check.ref]:[])])]; if(proofRefs.length>500)throw new Error("Task entry exceeds 500 proof references");
  return {id:id(record["id"]),text:text(record["text"],"text"),status,proofRefs,...(check?{verification:check}:{})};
};
const artifact = (value:unknown):TaskArtifact=>{
  const record=asRecord(value);if(!record) throw new Error("Task artifact must be an object");
  if(Object.keys(record).some(key=>!["id","path","description","originSessionId"].includes(key))) throw new Error("Unknown artifact field");
  return {id:id(record["id"]),path:text(record["path"],"path",4096),description:text(record["description"]??"","description"),originSessionId:text(record["originSessionId"]??"","originSessionId",256)};
};
export const parseTaskPatch = (raw:unknown):TaskStatePatch=>{
  const patch=asRecord(raw);if(!patch) throw new Error("Task state patch must be an object");
  const known=["goal","constraints","decisions","acceptance","activeWork","artifacts"];
  if(Object.keys(patch).some(key=>!known.includes(key))) throw new Error("Unknown task state patch field");
  return {
    ...("goal"in patch?{goal:text(patch["goal"],"goal",16_777_216)}:{}),
    ...("constraints"in patch?{constraints:list(patch["constraints"],"constraints",value=>text(value,"constraint"))}:{}),
    ...("decisions"in patch?{decisions:unique(list(patch["decisions"],"decisions",entry))}:{}),
    ...("acceptance"in patch?{acceptance:unique(list(patch["acceptance"],"acceptance",entry))}:{}),
    ...("activeWork"in patch?{activeWork:unique(list(patch["activeWork"],"activeWork",entry))}:{}),
    ...("artifacts"in patch?{artifacts:unique(list(patch["artifacts"],"artifacts",artifact))}:{}),
  };
};

/** Durable task facts are independent from conversational projection, compaction and rewind. */
export class TaskStateStore {
  readonly path:string;
  private state:TaskState=empty();
  private ready:Promise<void>|null=null;
  private readonly writer=new ConcurrencyLimiter(1);
  private noteCache:{revision:number;maxChars:number;value:string}|null=null;
  constructor(directory:string,private readonly trace?:ExecutionStore){this.path=join(directory,"task-state.json");}
  initialize():Promise<void>{
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      let saved:string;try{if((await stat(this.path)).size>16_777_216)throw new Error("Saved task state exceeds 16 MiB");saved=await readFile(this.path,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
      const record=asRecord(JSON.parse(saved));if(record?.["schema"]!==1||!Number.isSafeInteger(record["revision"])||Number(record["revision"])<0)throw new Error("Invalid saved task state");
      const {schema:_schema,revision,...patch}=record;this.state={...empty(),...parseTaskPatch(patch),revision:Number(revision)};
    })();return this.ready;
  }
  async read():Promise<TaskState>{await this.initialize();return structuredClone(this.state);}
  async update(raw:unknown,expectedRevision:number):Promise<TaskState>{
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error("expected_revision must be a non-negative integer");
    const patch=parseTaskPatch(raw);await this.initialize();
    return this.writer.run(async()=>{
      if(expectedRevision!==this.state.revision)throw new Error(`Task state revision conflict: expected ${expectedRevision}, current ${this.state.revision}`);
      const next={...this.state,...patch,revision:this.state.revision+1};
      if(Buffer.byteLength(JSON.stringify(next))>16_777_216)throw new Error("Task state exceeds 16 MiB");
      await writeJsonAtomic(this.path,next);this.state=next;
      await this.trace?.append("task.updated",{revision:next.revision,patch});
      return structuredClone(next);
    });
  }
  async initializeGoal(goal:string):Promise<void>{
    await this.initialize();
    await this.writer.run(async()=>{
      if(this.state.goal||!goal.trim())return;
      const next={...this.state,goal,revision:this.state.revision+1};
      if(Buffer.byteLength(JSON.stringify(next))>16_777_216)throw new Error("Task state exceeds 16 MiB");
      await writeJsonAtomic(this.path,next);this.state=next;
      await this.trace?.append("task.updated",{revision:next.revision,patch:{goal}});
    });
  }
  async flush():Promise<void>{await this.initialize();await this.writer.run(async()=>{});}
  contextNote(maxChars=8000):string|null{
    if(!this.state.goal&&this.state.revision===0)return null;
    maxChars=Math.max(256,Math.min(20_000,Math.floor(maxChars)||8000));
    if(this.noteCache?.revision===this.state.revision&&this.noteCache.maxChars===maxChars)return this.noteCache.value;
    const state=this.state;
    const clip=(value:string,limit:number):string=>value.length>limit?`${value.slice(0,limit)}…`:value;
    const section=Math.max(32,Math.floor(maxChars/7));
    const lines=[`[persistent task state r${state.revision}]`,`goal (${state.goal.length} chars): ${clip(state.goal,section)}`,
      `constraints (${state.constraints.length}): ${clip(state.constraints.slice(0,10).map(value=>clip(value,300)).join("; "),section)}`,
      `decisions (${state.decisions.length}): ${clip(state.decisions.slice(-10).map(value=>`${value.id} (${value.status}): ${clip(value.text,300)}`).join("; "),section)}`,
      `acceptance (${state.acceptance.length}): ${clip(state.acceptance.slice(0,20).map(value=>`${value.id} (${value.status}): ${clip(value.text,200)}; proofs=${value.proofRefs.slice(0,3).join(",")||"none"}`).join("; "),section)}`,
      `work (${state.activeWork.length}): ${clip(state.activeWork.slice(0,20).map(value=>`${value.id} (${value.status}): ${clip(value.text,300)}`).join("; "),section)}`,
      `artifacts (${state.artifacts.length}): ${clip(state.artifacts.slice(-10).map(value=>`${value.id}: ${clip(value.path,300)} (${clip(value.description,100)})`).join("; "),section)}`];
    const value=`${lines.join("\n").slice(0,maxChars)}\n[bounded task preview; complete records remain durable]\nUse omr_state action=get with path/offset/limit for bounded reads, or /state for the full durable state; updates require expected_revision. Claimed acceptance is not verified evidence.`;
    this.noteCache={revision:state.revision,maxChars,value};return value;
  }
}
