import type { ChatImageBlock, ChatMessage, ToolDefinition } from "./model.js";
import { asArray, asRecord } from "./values.js";

export const CONSERVATIVE_CONTEXT_WINDOW = 32_768;
export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly vision: boolean | null;
  readonly tools: boolean | null;
  readonly nativeCompaction: false;
  readonly source: "provider-metadata" | "operator" | "verified-registry" | "conservative-default";
  readonly sourceUrl?: string | undefined;
}
export type CapabilityMetadata = Partial<Pick<ModelCapabilities, "contextWindow" | "maxOutputTokens" | "vision" | "tools">>;

// Exact identities only. A gateway alias does not prove that it serves the upstream model.
// Sources checked 2026-11-11; live provider metadata and operator settings take precedence.
const registry: Readonly<Record<string, ModelCapabilities>> = {
  "openai:gpt-4.1": {contextWindow:1_047_576,maxOutputTokens:32_768,vision:true,tools:true,nativeCompaction:false,source:"verified-registry",sourceUrl:"https://developers.openai.com/api/docs/models/gpt-4.1"},
  "openai:gpt-4.1-2025-04-14": {contextWindow:1_047_576,maxOutputTokens:32_768,vision:true,tools:true,nativeCompaction:false,source:"verified-registry",sourceUrl:"https://developers.openai.com/api/docs/models/gpt-4.1"},
  "openai:gpt-4o-mini": {contextWindow:128_000,maxOutputTokens:16_384,vision:true,tools:true,nativeCompaction:false,source:"verified-registry",sourceUrl:"https://developers.openai.com/api/docs/models/gpt-4o-mini"},
  "openai:gpt-4o-mini-2024-07-18": {contextWindow:128_000,maxOutputTokens:16_384,vision:true,tools:true,nativeCompaction:false,source:"verified-registry",sourceUrl:"https://developers.openai.com/api/docs/models/gpt-4o-mini"},
  "gemini:gemini-2.5-pro": {contextWindow:1_048_576,maxOutputTokens:65_536,vision:true,tools:true,nativeCompaction:false,source:"verified-registry",sourceUrl:"https://aistudio.google.com/docs/models/gemini-2.5-pro"},
};

const positive = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** Retain structured metadata rather than reducing it to a UI label. */
export const parseCapabilityMetadata = (raw: Record<string, unknown> | null): CapabilityMetadata => {
  if (!raw) return {};
  const caps = asRecord(raw["capabilities"]);
  const limit = asRecord(raw["top_provider"]);
  const contextWindow = positive(raw["context_length"] ?? raw["context_window"] ?? raw["contextWindow"] ?? raw["max_model_len"] ?? raw["max_input_tokens"] ?? raw["inputTokenLimit"] ?? raw["max_context_length"] ?? caps?.["contextWindow"] ?? caps?.["context_length"]);
  const maxOutputTokens = positive(raw["max_output_tokens"] ?? raw["maxOutputTokens"] ?? raw["outputTokenLimit"] ?? raw["max_tokens"] ?? raw["max_completion_tokens"] ?? limit?.["max_completion_tokens"] ?? caps?.["maxOutputTokens"] ?? caps?.["maxOutput"]);
  const modalities = asArray(asRecord(raw["architecture"])?.["input_modalities"] ?? raw["input_modalities"]);
  const params = asArray(raw["supported_parameters"]);
  const rawVision = caps?.["vision"] ?? raw["vision"];
  const rawTools = caps?.["tools"] ?? raw["tools"] ?? raw["tool_call"];
  return {
    ...(contextWindow ? {contextWindow} : {}), ...(maxOutputTokens ? {maxOutputTokens} : {}),
    ...(typeof rawVision === "boolean" ? {vision:rawVision} : modalities.length ? {vision:modalities.includes("image")} : {}),
    ...(typeof rawTools === "boolean" ? {tools:rawTools} : params.includes("tools") ? {tools:true} : {}),
  };
};

export const resolveModelCapabilities = (model: string, providerId?: string, metadata?: CapabilityMetadata, source: "provider-metadata" | "operator" = "provider-metadata"): ModelCapabilities => {
  const known = registry[`${providerId ?? ""}:${model}`];
  const base: ModelCapabilities = known ?? {contextWindow:CONSERVATIVE_CONTEXT_WINDOW,maxOutputTokens:null,vision:null,tools:null,nativeCompaction:false,source:"conservative-default"};
  const window = positive(metadata?.contextWindow);
  const output = positive(metadata?.maxOutputTokens);
  return {...base,
    ...(window ? {contextWindow:window,source} : {}), ...(output ? {maxOutputTokens:output} : {}),
    ...(typeof metadata?.vision === "boolean" ? {vision:metadata.vision} : {}),
    ...(typeof metadata?.tools === "boolean" ? {tools:metadata.tools} : {}),
  };
};

/** A positive, bounded estimate for every image, even without caller-supplied billing metadata. */
export const estimateImageTokens = (image: ChatImageBlock): number => {
  if (image.detail === "low") return 512;
  const bytes = Buffer.from(image.data.slice(0, 131_072), "base64");
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    width=bytes.readUInt32BE(16); height=bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at=2;
    while (at+9<bytes.length) {
      if (bytes[at] !== 0xff) break;
      const marker=bytes[at+1]!; const size=bytes.readUInt16BE(at+2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {height=bytes.readUInt16BE(at+5);width=bytes.readUInt16BE(at+7);break;}
      if (size<2) break; at+=size+2;
    }
  }
  if (width<1 || height<1) return 4096;
  // This is an admission estimate, not a billing claim; provider usage remains authoritative.
  const tiles=Math.ceil(Math.min(width,4096)/512)*Math.ceil(Math.min(height,4096)/512);
  return Math.max(1024, Math.min(32_768, 256+tiles*512));
};

export const messageImageTokens = (message: ChatMessage): number => Math.max(
  Number.isFinite(message.image_tokens) && (message.image_tokens ?? 0)>0 ? message.image_tokens! : 0,
  message.images?.reduce((total,image)=>total+estimateImageTokens(image),0) ?? 0,
);
export const estimateToolTokens = (tools: readonly ToolDefinition[]): number => tools.length ? Math.ceil(Buffer.byteLength(JSON.stringify(tools),"utf8")/3)+tools.length*16 : 0;
export const estimateRequestTokens = (messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = []): number =>
  estimateToolTokens(tools)+messages.reduce((total,message)=>total+8+Math.ceil(Buffer.byteLength(JSON.stringify({...message,images:undefined,image_tokens:undefined}),"utf8")/3)+messageImageTokens(message),0);

export class ContextOverflowError extends Error {
  constructor(message: string, readonly contextWindow: number | null = null) {super(message);this.name="ContextOverflowError";}
}
export const contextOverflowOf = (error: unknown): {contextWindow:number|null} | null => {
  if (error instanceof ContextOverflowError) return {contextWindow:error.contextWindow};
  const message=error instanceof Error ? error.message : "";
  if (!/context_length_exceeded|prompt[_ ]too[_ ]long|maximum context length|exceeds?.{0,30}context|context window.{0,30}(?:exceeded|limit)/i.test(message)) return null;
  const match=/(?:maximum context length|context window)(?:\D{0,25})([\d,]+)/i.exec(message);
  return {contextWindow:match ? positive(match[1]!.replaceAll(",","")) ?? null : null};
};
