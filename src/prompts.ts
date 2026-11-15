export {
  type PromptContext,
  systemPrompt,
  targetLineOf,
  turnContextNote,
} from "./prompts/system.js";

export {
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
} from "./prompts/core.js";

export {
  browserPrompt,
  cryptoPrompt,
  diffCvePrompt,
  fridaPrompt,
  protocolPrompt,
  surfacePrompt,
} from "./prompts/offensive.js";

export {
  capaPrompt,
  deobfuscatePrompt,
  firmwarePrompt,
  iocPrompt,
  masvsPrompt,
  sandboxPrompt,
  sbomPrompt,
  unpackPrompt,
} from "./prompts/defensive.js";

export {
  type OmrWorkflowSpec,
  type WorkflowCategory,
  type WorkflowRenderArgs,
  OMR_WORKFLOWS,
  autonomousWorkflowNote,
  findOmrWorkflow,
  hasAnyTrigger,
  matchWorkflowsForInput,
  scoreWorkflows,
} from "./prompts/registry.js";
