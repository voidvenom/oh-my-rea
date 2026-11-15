import { isDeepStrictEqual } from "node:util";
import { asRecord } from "./values.js";

/** Deliberately small, explicit schema dialect for generated JSON tools. No silent $ref fallback. */
export type JsonSchema = Readonly<Record<string, unknown>>;
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const keywords = new Set(["type", "description", "title", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]);

export const parseToolSchema = (value: unknown, rootObject = false): JsonSchema => {
  let nodes = 0;
  const visit = (raw: unknown, depth: number): JsonSchema => {
    const schema = asRecord(raw);
    if (!schema || Array.isArray(raw) || depth > 20 || ++nodes > 1000) throw new Error("Tool schema must be a bounded JSON schema object");
    for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported tool schema keyword: ${key}`);
    if (typeof schema["type"] !== "string" || !types.has(schema["type"])) throw new Error("Tool schema requires one explicit type");
    if ("enum" in schema && (!Array.isArray(schema["enum"]) || schema["enum"].length === 0)) throw new Error("Schema enum must be non-empty");
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
      if (key in schema && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0)) throw new Error(`Invalid schema ${key}`);
    }
    for (const key of ["minimum", "maximum"]) if (key in schema && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) throw new Error(`Invalid schema ${key}`);
    for (const [minimum, maximum] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]]) {
      if (typeof schema[minimum!] === "number" && typeof schema[maximum!] === "number" && Number(schema[minimum!]) > Number(schema[maximum!])) throw new Error(`Schema ${minimum} exceeds ${maximum}`);
    }
    if ("properties" in schema) {
      const properties = asRecord(schema["properties"]); if (!properties || Array.isArray(properties)) throw new Error("Schema properties must be an object");
      for (const child of Object.values(properties)) visit(child, depth + 1);
    }
    if ("required" in schema && (!Array.isArray(schema["required"]) || schema["required"].some(key => typeof key !== "string"))) throw new Error("Schema required must contain property names");
    if ("additionalProperties" in schema && typeof schema["additionalProperties"] !== "boolean") throw new Error("additionalProperties must be boolean in the Forge schema dialect");
    if (schema["type"] === "array") { if (!schema["items"]) throw new Error("Array tool schemas require items"); visit(schema["items"], depth + 1); }
    return schema;
  };
  const parsed = visit(value, 0);
  if (rootObject && parsed["type"] !== "object") throw new Error("Tool input schema must have type object");
  return structuredClone(parsed);
};

export const validateToolValue = (value: unknown, schema: JsonSchema, path = "$", depth = 0): void => {
  if (depth > 64) throw new Error(`${path}: JSON nesting exceeds limit`);
  const type = schema["type"];
  const valid = type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
    : type === "object" ? asRecord(value) !== null && !Array.isArray(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === type;
  if (!valid) throw new Error(`${path}: expected ${String(type)}`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].some(candidate => isDeepStrictEqual(candidate, value))) throw new Error(`${path}: value is outside enum`);
  if ("const" in schema && !isDeepStrictEqual(schema["const"], value)) throw new Error(`${path}: value differs from const`);
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) throw new Error(`${path}: below minimum`);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) throw new Error(`${path}: above maximum`);
  }
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) throw new Error(`${path}: too short`);
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) throw new Error(`${path}: too long`);
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) throw new Error(`${path}: too few items`);
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) throw new Error(`${path}: too many items`);
    value.forEach((item, index) => validateToolValue(item, schema["items"] as JsonSchema, `${path}[${index}]`, depth + 1));
  } else if (type === "object") {
    const record = value as Record<string, unknown>; const properties = asRecord(schema["properties"]) ?? {};
    for (const key of (schema["required"] ?? []) as string[]) if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required property missing`);
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) validateToolValue(item, properties[key] as JsonSchema, `${path}.${key}`, depth + 1);
      else if (schema["additionalProperties"] === false) throw new Error(`${path}.${key}: additional property`);
    }
  }
};
