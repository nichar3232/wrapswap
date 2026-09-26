// Runtime interpreter for the JSON-Schema subset used in INTERFACES.md (§4, §5).
export type Schema = {
  $ref?: string;
  type?: string | readonly string[];
  enum?: readonly unknown[];
  const?: unknown;
  pattern?: string;
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: readonly Schema[];
};

const kind = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : typeof v === "number"
        ? Number.isInteger(v)
          ? "integer"
          : "number"
        : typeof v;

function typeMatches(expected: string, v: unknown): boolean {
  const k = kind(v);
  return expected === k || (expected === "number" && k === "integer");
}

/** Returns a list of human-readable violations; empty means valid. */
export function check(
  defs: Readonly<Record<string, Schema>>,
  schema: Schema,
  value: unknown,
  path = "$",
): string[] {
  if (schema.$ref !== undefined) {
    const target = defs[schema.$ref];
    if (!target) return [`${path}: unknown schema ${schema.$ref}`];
    return check(defs, target, value, path);
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => check(defs, s, value, path));
    return results.some((r) => r.length === 0)
      ? []
      : [`${path}: no anyOf branch matched (${results.map((r) => r[0]).join("; ")})`];
  }
  if ("const" in schema && value !== schema.const)
    return [`${path}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value as never))
    return [`${path}: expected one of ${JSON.stringify(schema.enum)}`];
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!types.some((t) => typeMatches(t, value)))
      return [`${path}: expected ${types.join("|")}, got ${kind(value)}`];
  }
  const errors: string[] = [];
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value))
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  if (kind(value) === "array" && schema.items)
    (value as unknown[]).forEach((item, i) => errors.push(...check(defs, schema.items!, item, `${path}[${i}]`)));
  if (kind(value) === "object" && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    for (const [key, v] of Object.entries(obj)) {
      const prop = schema.properties?.[key];
      if (prop) errors.push(...check(defs, prop, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === "object")
        errors.push(...check(defs, schema.additionalProperties, v, `${path}.${key}`));
    }
  }
  return errors;
}

export class ValidationError extends Error {
  constructor(
    public readonly schema: string,
    public readonly errors: string[],
  ) {
    super(`${schema} validation failed: ${errors.slice(0, 5).join("; ")}`);
  }
}
