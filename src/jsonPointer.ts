/** RFC 6901 lookup with own-property checks; missing differs from a JSON null. */
export const selectJsonPointer = (root: unknown, pointer: string): { found: boolean; value: unknown } => {
  if (pointer === "") return { found: true, value: root };
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) throw new Error("Invalid JSON pointer");
  let value = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key) || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
};
