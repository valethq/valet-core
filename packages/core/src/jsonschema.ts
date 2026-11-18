/**
 * JSON-schema subset validator (AGENTS: no ajv). Supports the keys plugins
 * actually use: type, required, properties, items, enum, additionalProperties,
 * minimum, maximum, minLength and maxLength. Other keys (title, default, x-*) are ignored.
 */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // object | string | number | integer-ish | boolean | undefined
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeOf(value) === type;
}

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${path}: expected ${type}, got ${typeOf(value)}`);
    return;
  }
  if (Array.isArray(type) && !type.some((t) => typeof t === "string" && matchesType(value, t))) {
    errors.push(`${path}: expected one of ${type.join("|")}, got ${typeOf(value)}`);
    return;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((v) => Bun.deepEquals(v, value))) {
      errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path}: must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path}: must be at most ${schema.maxLength} characters`);
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) errors.push(`${path}: missing required "${key}"`);
      }
    }
    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null) {
      for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
        if (key in obj && typeof sub === "object" && sub !== null) {
          check(obj[key], sub as Schema, `${path}.${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys((properties as Record<string, unknown> | undefined) ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      const known = new Set(Object.keys((properties as Record<string, unknown> | undefined) ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) check(obj[key], schema.additionalProperties as Schema, `${path}.${key}`, errors);
      }
    }
  }
  if (Array.isArray(value) && typeof schema.items === "object" && schema.items !== null) {
    for (const [i, item] of value.entries()) check(item, schema.items as Schema, `${path}[${i}]`, errors);
  }
}

/** Returns a list of validation errors; empty means valid. */
export function validateJsonSchema(value: unknown, schema: Schema): string[] {
  const errors: string[] = [];
  check(value, schema, "config", errors);
  return errors;
}
