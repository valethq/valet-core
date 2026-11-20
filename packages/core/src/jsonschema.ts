import { existsSync, statSync } from "node:fs";
import { expandHome } from "./paths";

/**
 * JSON-schema subset validator (AGENTS: no ajv). Covers what compiled settings documents emit: type, required,
 * properties, items, enum, const, additionalProperties, propertyNames, minimum, maximum, exclusiveMinimum,
 * exclusiveMaximum, multipleOf, minLength, maxLength, pattern, minItems, maxItems, anyOf, oneOf, plus the
 * settings keywords x-discriminator (variant), x-ordered (range), x-schemes (url) and x-mustExist (path).
 * Other keys (title, default) are ignored.
 */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeOf(value) === type;
}

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

function checkNumber(value: number, schema: Schema, path: string, errors: string[]): void {
  const exclMin = schema.exclusiveMinimum;
  const exclMax = schema.exclusiveMaximum;
  if (typeof exclMin === "number") {
    if (value <= exclMin) errors.push(`${path}: must be greater than ${exclMin}`);
  } else if (typeof schema.minimum === "number") {
    if (exclMin === true) {
      if (value <= schema.minimum) errors.push(`${path}: must be greater than ${schema.minimum}`);
    } else if (value < schema.minimum) {
      errors.push(`${path}: must be at least ${schema.minimum}`);
    }
  }
  if (typeof exclMax === "number") {
    if (value >= exclMax) errors.push(`${path}: must be less than ${exclMax}`);
  } else if (typeof schema.maximum === "number") {
    if (exclMax === true) {
      if (value >= schema.maximum) errors.push(`${path}: must be less than ${schema.maximum}`);
    } else if (value > schema.maximum) {
      errors.push(`${path}: must be at most ${schema.maximum}`);
    }
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const q = value / schema.multipleOf;
    if (Math.abs(q - Math.round(q)) > 1e-9)
      errors.push(`${path}: must be a multiple of ${schema.multipleOf}`);
  }
}

function checkString(value: string, schema: Schema, path: string, errors: string[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength)
    errors.push(`${path}: must be at least ${schema.minLength} characters`);
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
    errors.push(`${path}: must be at most ${schema.maxLength} characters`);
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
    errors.push(`${path}: must match ${schema["x-patternHint"] ?? schema.pattern}`);
  if (Array.isArray(schema["x-schemes"])) {
    let scheme: string | undefined;
    try {
      scheme = new URL(value).protocol.replace(/:$/, "");
    } catch {
      errors.push(`${path}: must be a URL`);
    }
    if (scheme !== undefined && !(schema["x-schemes"] as unknown[]).includes(scheme))
      errors.push(`${path}: scheme must be one of ${(schema["x-schemes"] as string[]).join(", ")}`);
  }
  const must = schema["x-mustExist"];
  if (must === "file" || must === "dir" || must === "any") {
    const full = expandHome(value);
    if (!existsSync(full)) errors.push(`${path}: path does not exist`);
    else if (must !== "any" && statSync(full).isDirectory() !== (must === "dir"))
      errors.push(`${path}: must be a ${must === "dir" ? "directory" : "file"}`);
  }
}

function checkObject(obj: Record<string, unknown>, schema: Schema, path: string, errors: string[]): void {
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in obj)) errors.push(`${path}: missing required "${key}"`);
    }
  }
  const properties = isSchema(schema.properties) ? schema.properties : {};
  for (const [key, sub] of Object.entries(properties)) {
    if (key in obj && isSchema(sub)) check(obj[key], sub, `${path}.${key}`, errors);
  }
  const known = new Set(Object.keys(properties));
  if (isSchema(schema.propertyNames)) {
    for (const key of Object.keys(obj))
      check(key, schema.propertyNames, `${path}[${JSON.stringify(key)}]`, errors);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) errors.push(`${path}: unexpected property "${key}"`);
    }
  } else if (isSchema(schema.additionalProperties)) {
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) check(obj[key], schema.additionalProperties, `${path}.${key}`, errors);
    }
  }
}

function checkArray(value: unknown[], schema: Schema, path: string, errors: string[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems)
    errors.push(`${path}: must have at least ${schema.minItems} items`);
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    errors.push(`${path}: must have at most ${schema.maxItems} items`);
  if (isSchema(schema.items)) {
    for (const [i, item] of value.entries()) check(item, schema.items, `${path}[${i}]`, errors);
  }
  if (schema["x-ordered"] === true && value.length === 2) {
    const [lo, hi] = value;
    if (typeof lo === "number" && typeof hi === "number" && lo > hi)
      errors.push(`${path}: lower bound must not exceed upper bound`);
  }
}

function checkVariant(obj: Record<string, unknown>, schema: Schema, path: string, errors: string[]): void {
  const tag = schema["x-discriminator"] as string;
  const cases = (schema.oneOf as Schema[]).filter(isSchema);
  const value = obj[tag];
  const match = cases.find((c) =>
    Bun.deepEquals((c.properties as Schema | undefined)?.[tag], { const: value }),
  );
  if (match === undefined) {
    const allowed = cases.map((c) => ((c.properties as Schema)[tag] as Schema).const);
    errors.push(`${path}.${tag}: must be one of ${JSON.stringify(allowed)}`);
    return;
  }
  check(obj, match, path, errors);
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
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isSchema).map((s) => {
      const e: string[] = [];
      check(value, s, path, e);
      return e;
    });
    if (!branches.some((e) => e.length === 0)) {
      errors.push(...(branches.reduce((a, b) => (b.length < a.length ? b : a)) ?? []));
      return;
    }
  }
  if (schema.const !== undefined && !Bun.deepEquals(schema.const, value))
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((v) => Bun.deepEquals(v, value))) {
      errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}`);
    }
  }
  if (typeof value === "number") checkNumber(value, schema, path, errors);
  if (typeof value === "string") checkString(value, schema, path, errors);
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof schema["x-discriminator"] === "string" && Array.isArray(schema.oneOf)) {
      checkVariant(obj, schema, path, errors);
    } else {
      checkObject(obj, schema, path, errors);
      if (Array.isArray(schema.oneOf)) {
        const passing = schema.oneOf.filter(isSchema).filter((s) => validateAt(value, s, path).length === 0);
        if (passing.length !== 1) errors.push(`${path}: must match exactly one schema in oneOf`);
      }
    }
  }
  if (Array.isArray(value)) checkArray(value, schema, path, errors);
}

/** Errors for `value` against `schema`, reported under `path`. */
export function validateAt(value: unknown, schema: Schema, path: string): string[] {
  const errors: string[] = [];
  check(value, schema, path, errors);
  return errors;
}

/** Returns a list of validation errors; empty means valid. */
export function validateJsonSchema(value: unknown, schema: Schema): string[] {
  return validateAt(value, schema, "config");
}
