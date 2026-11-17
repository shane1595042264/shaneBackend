// SHAN-704: the small JSON Schema subset the MCP tools use, and a validator
// for it. Each tool's inputSchema is written once, published as-is in
// tools/list, and checked here on tools/call, so what a client is told and
// what the server enforces cannot drift apart.

export type JsonSchema =
  | { type: "string"; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number; pattern?: string }
  | { type: "integer" | "number"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
  | {
      type: "object";
      description?: string;
      properties?: Record<string, JsonSchema>;
      required?: readonly string[];
      additionalProperties?: boolean | JsonSchema;
    }
  | { anyOf: readonly JsonSchema[]; description?: string };

/** Every problem found, as "path: message". Empty means valid. */
export function validate(schema: JsonSchema, value: unknown, path = "arguments"): string[] {
  if ("anyOf" in schema) {
    const ok = schema.anyOf.some((s) => validate(s, value, path).length === 0);
    return ok ? [] : [`${path}: does not match any allowed shape`];
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [`${path}: expected a string`];
      const errs: string[] = [];
      if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.join(", ")}`);
      if (schema.minLength !== undefined && value.length < schema.minLength)
        errs.push(`${path}: must be at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        errs.push(`${path}: must be at most ${schema.maxLength} characters`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
      return errs;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: expected a number`];
      if (schema.type === "integer" && !Number.isInteger(value)) return [`${path}: expected an integer`];
      const errs: string[] = [];
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be <= ${schema.maximum}`);
      return errs;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: expected true or false`];
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected an array`];
      const errs: string[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems)
        errs.push(`${path}: needs at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        errs.push(`${path}: takes at most ${schema.maxItems} items`);
      value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
      return errs;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected an object`];
      const obj = value as Record<string, unknown>;
      const errs: string[] = [];
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) errs.push(`${path}.${key}: required`);
      }
      const props = schema.properties ?? {};
      for (const [key, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const sub = props[key];
        if (sub) errs.push(...validate(sub, v, `${path}.${key}`));
        else if (schema.additionalProperties === false) errs.push(`${path}.${key}: unknown field`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
          errs.push(...validate(schema.additionalProperties, v, `${path}.${key}`));
      }
      return errs;
    }
  }
}
