import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConcurrencyLimiter } from "./concurrency.js";
import { resources } from "./resources.js";
import { writeJsonAtomic } from "./durable.js";
import type { ExecutionStore } from "./execution.js";
import { asArray, asRecord } from "./values.js";
import { ContextOverflowError, estimateRequestTokens, resolveModelCapabilities } from "./capabilities.js";
import type { ChatMessage, ModelAttemptAccounting, ModelPort, ModelRequestLimits, SessionUsageView, SummaryResult, ToolDefinition, Usage } from "./model.js";

interface UsageReservation {
  readonly id: string;
  readonly scope: string;
  readonly model: string;
  readonly promptEstimate: number;
  readonly maxOutputTokens: number;
  readonly reservedTokens: number;
}
interface UsageState {
  schema: 1;
  budgetTokens: number | null;
  totalTokens: number;
  estimatedTokens: number;
  overrunTokens: number;
  priorUsageUnknown: boolean;
  scopes: Record<string, number>;
  reservations: Record<string, UsageReservation>;
}
export interface UsageSnapshot extends SessionUsageView {
  readonly priorUsageUnknown: boolean;
  readonly overrunTokens: number;
  readonly reservations: number;
}
export class BudgetExceededError extends Error {
  constructor(readonly budgetTokens: number, readonly totalTokens: number, message = "Session token budget cannot admit another model attempt") {
    super(`${message} (${totalTokens} used / ${budgetTokens} cap). Raise /budget or use /budget reset to establish an explicit new baseline.`);
    this.name="BudgetExceededError";
  }
}
const emptyState = (): UsageState => ({schema:1,budgetTokens:null,totalTokens:0,estimatedTokens:0,overrunTokens:0,priorUsageUnknown:false,scopes:{},reservations:{}});
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const billedTokens = (usage: Usage | null): number | null => {
  if (!usage) return null;
  const components=[usage.prompt_tokens,usage.completion_tokens];
  if(components.some(value=>value!==null&&!validCount(value))) return null;
  const sum=components.some(validCount)?(usage.prompt_tokens??0)+(usage.completion_tokens??0):null;
  const total=validCount(usage.total_tokens)?usage.total_tokens:null;
  return total===null&&sum===null?null:Math.ceil(Math.max(total??0,sum??0));
};

/** Shared by every primary, child, summary, retry and failover attempt in one runtime. */
export class UsageLedger {
  readonly path: string;
  private state=emptyState();
  private ready: Promise<void> | null=null;
  private readonly writer=new ConcurrencyLimiter(1);
  private limitProvider: ()=>number|null=()=>null;
  constructor(private readonly directory:string, private readonly trace?: ExecutionStore) {this.path=join(directory,"usage.json");}
  /** Initial default only; restored session caps are authoritative. Changes use durable setBudget. */
  setLimitProvider(provider:()=>number|null):void {this.limitProvider=provider;}

  initialize():Promise<void> {
    if(this.ready) return this.ready;
    this.ready=(async()=>{
      let saved:string;
      try {
        saved=await readFile(this.path,"utf8");
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
        const initial=this.limitProvider();this.state.budgetTokens=initial!==null&&initial>0?initial:null;
        try {const history=asRecord(JSON.parse(await readFile(join(this.directory,"history.json"),"utf8")));this.state.priorUsageUnknown=asArray(history?.["messages"]).length>0;} catch(historyError) {if((historyError as NodeJS.ErrnoException).code!=="ENOENT") throw historyError;}
        await writeJsonAtomic(this.path,this.state);
        return;
      }
      const raw=asRecord(JSON.parse(saved));
      if(raw?.["schema"]!==1 || !validCount(raw["totalTokens"]) || !validCount(raw["estimatedTokens"]) || !validCount(raw["overrunTokens"]) || !asRecord(raw["scopes"]) || !asRecord(raw["reservations"])) throw new Error("Invalid saved usage ledger");
      this.state=raw as unknown as UsageState;
      if(raw["budgetTokens"]===undefined) {const initial=this.limitProvider();this.state.budgetTokens=initial!==null&&initial>0?initial:null;}
      else if(raw["budgetTokens"]!==null&&!validCount(raw["budgetTokens"])) throw new Error("Invalid saved budget cap");
      for(const value of Object.values(this.state.scopes)) if(!validCount(value)) throw new Error("Invalid saved scope usage");
      for(const reservation of Object.values(this.state.reservations)) {
        if(!validCount(reservation.reservedTokens) || typeof reservation.scope!=="string") throw new Error("Invalid saved usage reservation");
        this.state.totalTokens+=reservation.reservedTokens;this.state.estimatedTokens+=reservation.reservedTokens;
        this.state.scopes={...this.state.scopes,[reservation.scope]:this.scopeTokens(reservation.scope)+reservation.reservedTokens};
      }
      const recovered=Object.keys(this.state.reservations).length;
      this.state.reservations={};
      if(recovered) {await writeJsonAtomic(this.path,this.state);await this.trace?.append("usage.recovered",{reservations:recovered,totalTokens:this.state.totalTokens,source:"reserved-estimate"});}
    })();return this.ready;
  }
  private scopeTokens(scope:string):number {const value=this.state.scopes[scope];return validCount(value)?value:0;}
  snapshot(scope="primary"):UsageSnapshot {
    const budgetTokens=this.state.budgetTokens!==null&&this.state.budgetTokens>0?this.state.budgetTokens:null;
    return {totalTokens:this.state.totalTokens,scopeTokens:this.scopeTokens(scope),budgetTokens,reservedTokens:Object.values(this.state.reservations).reduce((sum,r)=>sum+r.reservedTokens,0),estimatedTokens:this.state.estimatedTokens,priorUsageUnknown:this.state.priorUsageUnknown,overrunTokens:this.state.overrunTokens,reservations:Object.keys(this.state.reservations).length};
  }
  private async publish(state:UsageState,type:string,data:Record<string,unknown>):Promise<void> {
    await writeJsonAtomic(this.path,state);this.state=state;await this.trace?.append(type,data);
  }
  async reserve(scope:string,model:string,promptEstimate:number,maxOutputTokens:number,signal?:AbortSignal):Promise<UsageReservation> {
    if(!Number.isFinite(promptEstimate)||promptEstimate<0||!Number.isFinite(maxOutputTokens)||maxOutputTokens<1) throw new Error("Usage reservation requires finite prompt and output limits");
    await this.initialize();
    return this.writer.run(async()=>{
      const snapshot=this.snapshot(scope);
      const prompt=Math.max(1,Math.ceil(promptEstimate));
      const desired=Math.max(1,Math.floor(maxOutputTokens));
      if(snapshot.budgetTokens && snapshot.priorUsageUnknown) throw new BudgetExceededError(snapshot.budgetTokens,snapshot.totalTokens,"Prior session usage is unavailable; an explicit budget baseline is required");
      const output=snapshot.budgetTokens ? Math.min(desired,snapshot.budgetTokens-snapshot.totalTokens-snapshot.reservedTokens-prompt) : desired;
      if(output<1) throw new BudgetExceededError(snapshot.budgetTokens!,snapshot.totalTokens);
      const reservation:UsageReservation={id:randomUUID(),scope,model,promptEstimate:prompt,maxOutputTokens:output,reservedTokens:prompt+output};
      await this.publish({...this.state,reservations:{...this.state.reservations,[reservation.id]:reservation}},"usage.reserved",{...reservation,budgetTokens:snapshot.budgetTokens});
      return reservation;
    },signal);
  }
  async settle(id:string,usage:Usage|null,unbilled=false):Promise<void> {
    await this.initialize();
    await this.writer.run(async()=>{
      const reservation=this.state.reservations[id];if(!reservation) throw new Error(`No active usage reservation ${id}`);
      const reported=unbilled?0:billedTokens(usage);const charge=reported??reservation.reservedTokens;
      const reservations={...this.state.reservations};delete reservations[id];
      const state:UsageState={...this.state,reservations,totalTokens:this.state.totalTokens+charge,estimatedTokens:this.state.estimatedTokens+(reported===null?charge:0),overrunTokens:this.state.overrunTokens+Math.max(0,charge-reservation.reservedTokens),scopes:{...this.state.scopes,[reservation.scope]:this.scopeTokens(reservation.scope)+charge}};
      await this.publish(state,"usage.charged",{id,scope:reservation.scope,model:reservation.model,tokens:charge,source:unbilled?"local-not-dispatched":reported===null?"reserved-estimate":"provider",overrunTokens:Math.max(0,charge-reservation.reservedTokens)});
    });
  }
  async reset(note:string):Promise<void> {
    await this.initialize();await this.writer.run(async()=>{
      if(Object.keys(this.state.reservations).length) throw new Error("Cannot reset usage while model attempts are running");
      if(!note.trim()) throw new Error("Usage reset requires an explicit note");
      await this.publish({...emptyState(),budgetTokens:this.state.budgetTokens},"usage.reset",{note,previousTotalTokens:this.state.totalTokens});
    });
  }
  async setBudget(tokens:number|null):Promise<void> {
    if(tokens!==null&&(!Number.isSafeInteger(tokens)||tokens<1)) throw new Error("Budget cap must be a positive integer or unlimited");
    await this.initialize();await this.writer.run(()=>this.publish({...this.state,budgetTokens:tokens},"usage.budget",{budgetTokens:tokens}));
  }
}

/** Per-attempt admission is async so durable reservation finishes before retry/failover dispatch. */
export class BudgetModelClient implements ModelPort {
  constructor(private readonly client:ModelPort,private readonly ledger:UsageLedger,private readonly scope:string) {}
  get model():string{return this.client.model;}
  get providerId():string{return this.client.providerId??"custom";}
  get providerName():string{return this.client.providerName??"Custom";}
  get endpoint():string{return this.client.endpoint??"";}
  get capabilities(){return this.client.capabilities??resolveModelCapabilities(this.model,this.providerId);}
  get outputReserveTokens():number{return this.client.outputReserveTokens??4096;}
  get sessionUsage():SessionUsageView{return this.ledger.snapshot(this.scope);}
  private observer(messages:readonly ChatMessage[],tools:readonly ToolDefinition[],desired:number,signal?:AbortSignal):ModelAttemptAccounting {
    let reservation:UsageReservation|null=null;
    let release:(()=>void)|null=null;
    return {
      beforeAttempt:async(model,window,requested)=>{
        signal?.throwIfAborted();const prompt=estimateRequestTokens(messages,tools);
        if(prompt>=window) throw new ContextOverflowError(`Prompt estimate ${prompt} exceeds model window ${window}`,window);
        release=await resources.acquire("model",signal);
        try { reservation=await this.ledger.reserve(this.scope,model,prompt,Math.min(desired,requested,window-prompt),signal); }
        catch(error) {release();release=null;throw error;}
        return reservation.maxOutputTokens;
      },
      completed:async usage=>{const current=reservation;reservation=null;try {if(current) await this.ledger.settle(current.id,usage);} finally {release?.();release=null;}},
      failed:async error=>{const current=reservation;reservation=null;try {if(current) await this.ledger.settle(current.id,null,error instanceof ContextOverflowError || (error instanceof Error && "unbilled" in error && error.unbilled===true));} finally {release?.();release=null;}},
    };
  }
  async stream(messages:ChatMessage[],tools:ToolDefinition[],signal:AbortSignal|undefined,onText:(delta:string)=>void,onReasoning?:Parameters<ModelPort["stream"]>[4],onRetry?:Parameters<ModelPort["stream"]>[5],onNetworkStatus?:Parameters<ModelPort["stream"]>[6],onStreamReset?:()=>void) {
    const accounting=this.observer(messages,tools,this.outputReserveTokens,signal);
    const limits:ModelRequestLimits={accounting};
    if(this.client.attemptAccounting) return this.client.stream(messages,tools,signal,onText,onReasoning,onRetry,onNetworkStatus,onStreamReset,limits);
    const maximum=await accounting.beforeAttempt(this.model,this.capabilities.contextWindow,this.outputReserveTokens);
    try {const result=await this.client.stream(messages,tools,signal,onText,onReasoning,onRetry,onNetworkStatus,onStreamReset,{maxOutputTokens:maximum});await accounting.completed(result.usage);return result;}
    catch(error){await accounting.failed(error);throw error;}
  }
  async summarize(system:string,user:string,maxTokens:number,signal?:AbortSignal):Promise<string> {
    const messages:ChatMessage[]=[{role:"system",content:system},{role:"user",content:user}];const accounting=this.observer(messages,[],maxTokens,signal);
    if(this.client.summarizeDetailed && this.client.attemptAccounting) return (await this.client.summarizeDetailed(system,user,maxTokens,signal,{accounting})).summary;
    const maximum=await accounting.beforeAttempt(this.model,this.capabilities.contextWindow,maxTokens);
    try {const summary=await this.client.summarize(system,user,maximum,signal);await accounting.completed(null);return summary;} catch(error){await accounting.failed(error);throw error;}
  }
  async compactRemote(system:string,user:string,maxTokens:number,signal?:AbortSignal,endpoint?:string|null):Promise<string> {
    if(!this.client.compactRemote) throw new Error("Remote text compaction is unsupported");
    const messages:ChatMessage[]=[{role:"system",content:system},{role:"user",content:user}];const accounting=this.observer(messages,[],maxTokens,signal);
    if(this.client.compactRemoteDetailed && this.client.attemptAccounting) return (await this.client.compactRemoteDetailed(system,user,maxTokens,signal,endpoint,{accounting})).summary;
    const maximum=await accounting.beforeAttempt(this.model,this.capabilities.contextWindow,maxTokens);
    try {const summary=await this.client.compactRemote(system,user,maximum,signal,endpoint);await accounting.completed(null);return summary;} catch(error){await accounting.failed(error);throw error;}
  }
}
