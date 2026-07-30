const textEncoder = new TextEncoder();

/**
 * Canonicalize an I-JSON-compatible value using the JSON Canonicalization
 * Scheme described by RFC 8785. Negative zero is rejected per verified
 * Errata ID 7920 instead of being silently rewritten as positive zero.
 */
export function canonicalJson(value: unknown): string {
  return canonicalJsonAt(value, "$");
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalJson(value));
}

export function dssePreAuthenticationEncoding(
  payloadTypeValue: string,
  payload: Uint8Array,
): Uint8Array {
  const payloadType = textEncoder.encode(payloadTypeValue);
  return concatBytes(
    textEncoder.encode(`DSSEv1 ${payloadType.byteLength} `),
    payloadType,
    textEncoder.encode(` ${payload.byteLength} `),
    payload,
  );
}

function canonicalJsonAt(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must contain only finite JSON numbers`);
    }
    if (Object.is(value, -0)) {
      throw new Error(`${path} must not contain negative zero`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => {
        if (entry === undefined) {
          throw new Error(`${path}[${index}] must not be undefined`);
        }
        return canonicalJsonAt(entry, `${path}[${index}]`);
      })
      .join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key, `${path} property name`);
        const entry = value[key];
        if (entry === undefined) {
          throw new Error(`${path}.${key} must not be undefined`);
        }
        return `${JSON.stringify(key)}:${canonicalJsonAt(entry, `${path}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`${path} must contain only plain JSON values`);
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${path} must not contain an unpaired Unicode surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${path} must not contain an unpaired Unicode surrogate`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
