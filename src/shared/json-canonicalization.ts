import { createHash } from "node:crypto";

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("RFC 8785 rejects unpaired UTF-16 surrogates");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("RFC 8785 rejects unpaired UTF-16 surrogates");
  }
}

/** RFC 8785 JSON Canonicalization Scheme for JSON-compatible values. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") { assertValidUnicode(value); return JSON.stringify(value); }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("RFC 8785 only accepts finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => {
      assertValidUnicode(key);
      const item = object[key];
      if (item === undefined) throw new TypeError("RFC 8785 input must not contain undefined");
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError(`RFC 8785 cannot canonicalize ${typeof value}`);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
