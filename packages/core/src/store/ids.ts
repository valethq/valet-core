/** 8.1: prefixed UUIDv7 ids (prj_, ses_, msg_, prt_, run_, pri_, blb_). */
export function newId(prefix: "prj" | "ses" | "msg" | "prt" | "run" | "pri" | "blb"): string {
  return `${prefix}_${Bun.randomUUIDv7()}`;
}
