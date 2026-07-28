const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passphrase|api[_-]?key|apikey|authorization|cookie|session/i;
const TOKEN_ROUTE_PATTERNS = [
  /(\/api\/app\/invitations\/)[^/\s"']+(\/accept)/gi,
  /(\/api\/public\/share\/)[^/\s"']+/gi,
  /(\/share\/)[^/\s"']+/gi,
  /(\/api\/public\/webhooks\/agents\/)[^/\s"']+/gi,
];
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:token|access_token|api[_-]?key|apikey|key|secret)=)[^&\s"']+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(\b(?:token|access_token|api[_-]?key|apikey|secret|authorization)\b["']?\s*[:=]\s*)[^,&\s;}"']+/gi;

export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const suffix = value.slice(-4);
  return suffix ? `${REDACTED}:${suffix}` : REDACTED;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactSensitiveString(
  value: string,
  knownSecrets: readonly (string | null | undefined)[] = [],
): string {
  let redacted = value;
  for (const secret of knownSecrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join(maskSecret(secret));
  }
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  redacted = redacted.replace(/whk_[A-Za-z0-9_-]+/g, "whk_[redacted]");
  redacted = redacted.replace(SENSITIVE_QUERY_PATTERN, (_match, prefix) => `${prefix}${REDACTED}`);
  redacted = redacted.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, prefix) => `${prefix}${REDACTED}`,
  );
  for (const pattern of TOKEN_ROUTE_PATTERNS) {
    redacted = redacted.replace(
      pattern,
      (_match, prefix, suffix) => `${prefix}${REDACTED}${typeof suffix === "string" ? suffix : ""}`,
    );
  }
  return redacted;
}

export function redactSensitiveValue(
  value: unknown,
  knownSecrets: readonly (string | null | undefined)[] = [],
): unknown {
  if (typeof value === "string") return redactSensitiveString(value, knownSecrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, knownSecrets));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if (isSensitiveKey(key)) {
        return [key, typeof entry === "string" ? maskSecret(entry) : REDACTED];
      }
      return [key, redactSensitiveValue(entry, knownSecrets)];
    }),
  );
}

export function redactedErrorMessage(
  error: unknown,
  knownSecrets: readonly (string | null | undefined)[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveString(message, knownSecrets);
}
