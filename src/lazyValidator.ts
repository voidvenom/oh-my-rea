import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/client";

/**
 * The MCP client compiles the output schema of *every* tool in `tools/list` synchronously on the first
 * `callTool` (and again after each catalog refresh). REA exposes ~230 tools with ~3 MB of output
 * schemas, so that is ~6 s of blocked event loop (frozen TUI, delayed transcript on `--resume`).
 * This provider hands the client a cheap closure instead and compiles a schema only when a result of
 * that tool is first validated, then caches it, so an ordinary session compiles a handful of tools.
 *
 * Validation strictness is unchanged: the same Ajv provider validates the same schemas. A schema that
 * fails to compile is reported as an invalid result for that tool rather than failing the whole catalog.
 */
export const createLazyValidatorProvider = (base: jsonSchemaValidator): jsonSchemaValidator => ({
  getValidator: <T>(schema: JsonSchemaType): JsonSchemaValidator<T> => {
    let compiled: JsonSchemaValidator<T> | Error | undefined;
    return (input: unknown) => {
      if (compiled === undefined) {
        try {
          compiled = base.getValidator<T>(schema);
        } catch (error) {
          compiled = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (compiled instanceof Error) {
        return { valid: false, data: undefined, errorMessage: `invalid outputSchema: ${compiled.message.slice(0, 200)}` };
      }
      return compiled(input);
    };
  },
});
